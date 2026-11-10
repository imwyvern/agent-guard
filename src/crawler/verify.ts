import * as dns from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { LRU } from '../core/lru.js';
import { inCidr, ipNumber } from '../core/client-key.js';
import { crawlerPatterns } from './ua.js';
import type { AgentGuardConfig, Resolver } from '../types.js';
export interface CrawlerResult {
    claimed: string;
    verified: boolean;
    rdns?: string;
    cache: boolean;
}
export const defaultResolver: Resolver = {
    reverse: ip => dns.reverse(ip),
    resolve: async (host) => {
        const results = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
        if (results.every(result => result.status === 'rejected'))
            throw new Error('Forward DNS lookup failed');
        return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    },
};
export class CrawlerVerifier {
    private cache = new LRU<string, CrawlerResult>(10000);
    private pending = new Map<string, Promise<CrawlerResult>>();
    private ranges: Record<string, string[]>;
    constructor(private options: NonNullable<AgentGuardConfig['crawler']> = {}) {
        this.ranges = options.ipRangesFile ? JSON.parse(readFileSync(options.ipRangesFile, 'utf8')) as Record<string, string[]> : {};
    }
    async verify(ip: string, claimed: string): Promise<CrawlerResult> {
        const key = claimed + '|' + ip, cached = this.cache.get(key);
        if (cached)
            return { ...cached, cache: true };
        const active = this.pending.get(key);
        if (active)
            return active;
        const work = this.run(ip, claimed).then(result => { this.cache.set(key, result, result.verified ? 86400000 : 3600000); return result; }).finally(() => this.pending.delete(key));
        this.pending.set(key, work);
        return work;
    }
    private async run(ip: string, claimed: string): Promise<CrawlerResult> {
        const base = { claimed, cache: false };
        if (this.options.verify === false)
            return { ...base, verified: false };
        if ((this.ranges[claimed] ?? []).some(range => inCidr(ip, range)))
            return { ...base, verified: true };
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const resolver = this.options.resolver ?? defaultResolver;
            return await Promise.race([
                (async () => {
                    const hosts = await resolver.reverse(ip);
                    const suffixes = [...(crawlerPatterns.find(([name]) => name === claimed)?.[2] ?? []), ...(this.options.extraSuffixes?.[claimed] ?? [])];
                    for (const host of hosts) {
                        const normalized = host.toLowerCase().replace(/\.$/, '');
                        if (!suffixes.some(s => normalized === s || normalized.endsWith('.' + s)))
                            continue;
                        const addresses = await resolver.resolve(host), original = ipNumber(ip);
                        if (original && addresses.some(a => { const parsed = ipNumber(a); return parsed?.bits === original.bits && parsed.value === original.value; }))
                            return { ...base, verified: true, rdns: normalized };
                    }
                    return { ...base, verified: false };
                })(),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), this.options.timeoutMs ?? 300); }),
            ]);
        }
        catch {
            return { ...base, verified: this.options.failOpen ?? true };
        }
        finally {
            clearTimeout(timer);
        }
    }
}
