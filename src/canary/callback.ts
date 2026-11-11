import { createHmac } from 'node:crypto';
import type { RequestListener } from 'node:http';
import type { AgentGuard, AgentGuardConfig, AGRequest, DecoyId } from '../types.js';
import { base32 } from '../core/ulid.js';
import { secretEqual } from '../core/security.js';

/** Dedicated inert format with a 100-bit MAC and domain separation from replay
 * canaries and maze nodes. Stable IDs let separate guard instances share a handler. */
export class CallbackCanaries {
    private readonly placements = new Map<string, string>();
    constructor(private readonly config: AgentGuardConfig) {
        for (const id of ['D1', 'D2', 'D3', 'D4'] as const) this.placements.set(this.id(id), `${id}:callback`);
    }
    private digest(value: string): string { return base32(createHmac('sha256', this.config.canary.secret).update(value).digest()); }
    private id(id: DecoyId): string { return this.digest(`callback:id|${this.config.env}|${id}`).slice(0, 12); }
    private mac(id: string): string { return this.digest(`callback:v1|${this.config.env}|${id}`).slice(0, 20); }
    url(placement: DecoyId): string | undefined {
        const base = this.config.canary.callback?.baseUrl;
        if (!base) return;
        const id = this.id(placement);
        let end = base.length;
        while (end > 0 && base[end - 1] === '/') end--;
        return base.slice(0, end) + `/ag/cb/AGCB-CANARY-${id}-${this.mac(id)}`;
    }
    verify(path: string): { id: string; placement: string } | undefined {
        if (!this.config.canary.callback) return;
        const match = /^\/ag\/cb\/AGCB-CANARY-([0-9A-HJKMNP-TV-Z]{12})-([0-9A-HJKMNP-TV-Z]{20})$/.exec(path);
        if (!match || !secretEqual(match[2]!, this.mac(match[1]!))) return;
        const id = match[1]!, placement = this.placements.get(id);
        return placement ? { id, placement } : undefined;
    }
}

const callbackSymbol = Symbol.for('@imwyvern/agent-guard/callback');
type Ingress = (request: AGRequest) => Promise<boolean>;
export function installCallback(guard: AgentGuard, ingress: Ingress): void {
    Object.defineProperty(guard, callbackSymbol, { value: ingress });
}

/** Explicitly mounted Node listener. The public baseUrl is only placement data;
 * this handler never contacts it. A proxy may strip a baseUrl path prefix. */
export function callbackHandler(guard: AgentGuard): RequestListener {
    return (req, res) => {
        const finish = (valid: boolean): void => {
            try {
                if (!res.headersSent) res.writeHead(valid ? 204 : 404, { 'Cache-Control': 'no-store', ...(valid ? {} : { 'Content-Type': 'text/plain; charset=utf-8' }) });
                res.end(valid || req.method === 'HEAD' ? '' : 'Not Found\n');
            } catch { /* Response failures never escape into the host. */ }
        };
        try {
            const ingress = (guard as unknown as Record<symbol, Ingress>)[callbackSymbol];
            const target = req.url ?? '/';
            if (!ingress || target.length > 8192 || (req.method !== 'GET' && req.method !== 'HEAD')) { finish(false); return; }
            const queryAt = target.indexOf('?'), path = queryAt < 0 ? target : target.slice(0, queryAt);
            void ingress({ method: req.method, path, query: {}, headers: req.headers, ip: req.socket.remoteAddress ?? '' }).then(finish, () => finish(false));
        } catch { finish(false); }
    };
}
