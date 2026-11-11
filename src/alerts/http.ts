import { isLoopback } from './shared.js';

export function alertUrl(value: string): URL {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error('alert URL is invalid'); }
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))))
        throw new Error('alert URL must use HTTPS (or loopback HTTP) without credentials');
    return url;
}

export async function postAlert(url: URL, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<{ ok: boolean; status?: number }> {
    try {
        const response = await fetch(url, {
            method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
        await response.body?.cancel();
        return { ok: response.ok, status: response.status };
    }
    catch { return { ok: false }; }
}
