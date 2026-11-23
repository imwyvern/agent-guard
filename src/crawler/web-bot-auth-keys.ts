import { LRU } from '../core/lru.js';
import type { JsonWebKeySet, WebBotAuthFetchOptions } from './web-bot-auth-types.js';

/** HTTPS, no credentials, fragment, backslashes, whitespace or non-default port. */
export function agentUrl(value: string): string | undefined {
    if (value.length > 2048 || /[\s\\#]/.test(value) || /^https:\/\/[^/?]*@/i.test(value)) return;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return;
        return url.href;
    } catch { return; }
}

export function isJwks(value: unknown): value is JsonWebKeySet {
    if (!value || typeof value !== 'object' || !('keys' in value) || !Array.isArray(value.keys)
        || !value.keys.length || value.keys.length > 64) return false;
    return value.keys.every((key: unknown) => {
        if (!key || typeof key !== 'object') return false;
        const jwk = key as Record<string, unknown>;
        if (typeof jwk.kty !== 'string' || 'd' in jwk || 'k' in jwk || 'p' in jwk || 'q' in jwk) return false;
        const fields = jwk.kty === 'OKP' ? ['crv', 'x'] : jwk.kty === 'EC' ? ['crv', 'x', 'y'] : jwk.kty === 'RSA' ? ['n', 'e'] : [];
        return fields.length > 0 && fields.every(field => typeof jwk[field] === 'string' && (jwk[field] as string).length > 0)
            && (jwk.kid === undefined || typeof jwk.kid === 'string');
    });
}

export function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
    return value === undefined || !Number.isFinite(value) || value < 0 ? fallback : Math.min(value, maximum);
}

interface CacheEntry { jwks: JsonWebKeySet | null; expires: number }
const cacheCapacity = 256, maxTtl = 86400, negativeTtl = 30, maxPending = 32;

/** Lazy, bounded discovery. Cache identity is the complete URL, never a kid. */
export class WebBotAuthKeys {
    private cache = new LRU<string, CacheEntry>(cacheCapacity);
    private pending = new Map<string, Promise<JsonWebKeySet | null>>();
    constructor(private options?: WebBotAuthFetchOptions) {}

    async lookup(url: string): Promise<JsonWebKeySet | null> {
        const options = this.options;
        if (!options || agentUrl(url) !== url || !options.allowHosts.some(host => host.toLowerCase() === new URL(url).hostname.toLowerCase())) return null;
        const cached = this.cache.get(url);
        if (cached) return cached.jwks;
        const active = this.pending.get(url);
        if (active) return active;
        if (this.pending.size >= maxPending) return null;
        const work = this.load(url, options).finally(() => this.pending.delete(url));
        this.pending.set(url, work);
        return work;
    }
    private async load(url: string, options: WebBotAuthFetchOptions): Promise<JsonWebKeySet | null> {
        const controller = new AbortController(), timeout = boundedOption(options.timeoutMs, 2000, 5000);
        const storeKey = 'web-bot-auth:jwks:' + url;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let ttl = negativeTtl, jwks: JsonWebKeySet | null = null;
        const ttlLimit = boundedOption(options.maxTtlSeconds, maxTtl, maxTtl);
        try {
            const result = await Promise.race([
                (async (): Promise<CacheEntry> => {
                    if (options.cache) {
                        try {
                            const entry = await options.cache.get<CacheEntry>(storeKey);
                            const remaining = entry ? entry.expires - Date.now() : 0;
                            if (entry && remaining > 0 && remaining <= (entry.jwks === null ? negativeTtl : ttlLimit) * 1000
                                && (entry.jwks === null || isJwks(entry.jwks))) return entry;
                        } catch { /* Store failures fall back to bounded local memory. */ }
                    }
                    if (controller.signal.aborted) throw new Error('Key lookup timed out');
                    const response = await options.fetcher(url, { signal: controller.signal, redirect: 'manual', headers: { Accept: 'application/jwk-set+json, application/json, application/http-message-signatures-directory+json' } });
                    if (response.status !== 200 || response.redirected || response.url && agentUrl(response.url) !== url) {
                        void response.body?.cancel().catch(() => {});
                        throw new Error('Key response rejected');
                    }
                    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
                    if (mediaType !== 'application/json' && mediaType !== 'application/jwk-set+json' && mediaType !== 'application/http-message-signatures-directory+json') {
                        void response.body?.cancel().catch(() => {});
                        throw new Error('Key media type rejected');
                    }
                    const value: unknown = JSON.parse(await this.readBody(response, controller.signal, boundedOption(options.maxBytes, 65536, 262144)));
                    if (!isJwks(value)) throw new Error('Invalid JWK set');
                    const cacheControl = response.headers.get('cache-control') ?? '';
                    const age = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/i.exec(cacheControl);
                    const responseAge = Number(response.headers.get('age') ?? 0);
                    const lifetime = /(?:^|,)\s*(?:no-store|no-cache)\s*(?:,|$)/i.test(cacheControl) ? 0
                        : Math.max(0, Math.min(age ? Number(age[1]) : ttlLimit, ttlLimit) - (Number.isFinite(responseAge) ? Math.max(0, responseAge) : 0));
                    return { jwks: value, expires: Date.now() + lifetime * 1000 };
                })(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => { controller.abort(); reject(new Error('Key lookup timed out')); }, timeout);
                }),
            ]);
            jwks = result.jwks;
            ttl = Math.max(0, Math.min((result.expires - Date.now()) / 1000, jwks ? ttlLimit : negativeTtl));
        } catch { /* Negative results are short lived and cannot establish trust. */ }
        finally { clearTimeout(timer); }
        const entry: CacheEntry = { jwks, expires: Date.now() + ttl * 1000 };
        if (ttl > 0) {
            this.cache.set(url, entry, ttl * 1000);
            // An optional remote store must not hold up the host response.
            try { void Promise.resolve(options.cache?.set(storeKey, entry, ttl * 1000)).catch(() => {}); } catch { /* Isolate store errors. */ }
        }
        return jwks;
    }
    private async readBody(response: Response, signal: AbortSignal, maxBytes: number): Promise<string> {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Empty key response');
        const cancel = (): void => { void reader.cancel().catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        try {
            const length = response.headers.get('content-length');
            if (signal.aborted || length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error('Key response too large');
            const decoder = new TextDecoder('utf-8', { fatal: true });
            let size = 0, text = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (signal.aborted) throw new Error('Key lookup timed out');
                if (done) break;
                size += value.byteLength;
                if (size > maxBytes) throw new Error('Key response too large');
                text += decoder.decode(value, { stream: true });
            }
            return text + decoder.decode();
        } catch (error) { cancel(); throw error; }
        finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
    }
}
