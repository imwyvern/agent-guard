import type { RequestListener } from 'node:http';
import type { AgentGuard, AgentGuardConfig, AGRequest } from '../types.js';
import type { CryptoProvider } from '../crypto/types.js';
import { nodeCrypto } from '../crypto/node.js';
import { CallbackCanaries as CoreCallbackCanaries } from './callback-core.js';

export class CallbackCanaries extends CoreCallbackCanaries {
    constructor(config: AgentGuardConfig, crypto: CryptoProvider = nodeCrypto) { super(config, crypto); }
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
