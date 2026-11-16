import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type Socket } from 'node:net';
import { toRequest, type ParsedRequest } from '../adapters/node.js';
import { inspectGraphqlRequest } from '../scenarios/graphql.js';
import { inspectMcpRequest } from '../scenarios/mcp.js';
import { DecoyRoutes } from '../decoys/responses.js';
import { sanitizeEvent } from '../core/security-core.js';
import { ulid } from '../core/ulid.js';
import type { AgentGuard, AgentGuardConfig, AgentGuardEvent, AGDecision } from '../types.js';

export interface ProxyOptions {
    upstream: string;
    guard: AgentGuard;
    config: AgentGuardConfig;
    timeoutMs?: number;
    inspectTimeoutMs?: number;
    onError?: (event: AgentGuardEvent) => void;
}
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection'];
/** Preserve end-to-end header values, order and duplicates, including Set-Cookie. */
export function endToEndHeaders(message: IncomingMessage): string[] {
    const excluded = new Set(hopHeaders);
    for (const token of (message.headers.connection ?? '').split(',')) excluded.add(token.trim().toLowerCase());
    const result: string[] = [];
    for (let i = 0; i < message.rawHeaders.length; i += 2)
        if (!excluded.has(message.rawHeaders[i]!.toLowerCase())) result.push(message.rawHeaders[i]!, message.rawHeaders[i + 1]!);
    return result;
}
export function fixedUpstream(input: string): URL {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
        throw new Error('upstream must be an HTTP(S) origin');
    return url;
}
function originTarget(target: string): string {
    if (target === '*') return target;
    if (target.startsWith('/')) return target; // Includes //: still a path on the fixed origin.
    const absolute = /^https?:\/\/[^/?#]+([^#]*)/i.exec(target);
    const path = absolute?.[1] || '/';
    return path.startsWith('?') ? '/' + path : path;
}
/** Read only a bounded prefix in paused mode. A slow upload cannot hold inspection. */
async function window(req: IncomingMessage): Promise<Buffer> {
    return new Promise(resolve => {
        const parts: Buffer[] = [];
        let used = 0;
        const finish = () => {
            clearTimeout(timer); req.off('readable', read); req.off('end', finish); req.off('close', finish);
            resolve(Buffer.concat(parts, used));
        };
        const read = () => {
            let chunk: Buffer | null;
            while (used < 16384 && (chunk = req.read(Math.min(16384 - used, req.readableLength || 16384)) as Buffer | null) !== null) {
                parts.push(chunk); used += chunk.length;
            }
            if (used === 16384 || req.readableEnded) finish();
        };
        const timer = setTimeout(finish, 50);
        req.on('readable', read); req.once('end', finish); req.once('close', finish);
        read();
    });
}

export function createProxy(options: ProxyOptions): { server: ReturnType<typeof createServer>; close(): Promise<void> } {
    const upstream = fixedUpstream(options.upstream), timeout = options.timeoutMs ?? 30000;
    const hostname = upstream.hostname.replace(/^\[|\]$/g, '');
    const budget = options.inspectTimeoutMs ?? 50;
    for (const value of [timeout, budget]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid proxy timeout');
    if (options.config.mode !== 'detect') throw new Error('proxy requires detect mode');
    const routes = new DecoyRoutes(options.config), sockets = new Set<Socket>();
    const report = (reason: string): void => {
        const event = sanitizeEvent({ v: 1, ts: new Date().toISOString(), event_id: ulid(), event: 'alert_failed', severity: 'medium',
            project: options.config.project, env: options.config.env, req: { method: 'PROXY', path: '', client_key: '' },
            alert: { channel: 'proxy' }, signals: [reason] });
        try { (options.onError ?? (event => console.error(JSON.stringify(event))))(event); } catch { /* Observers cannot interrupt forwarding. */ }
    };
    const server = createServer((req: ParsedRequest, res) => {
        // Always observe stream errors, including disconnects during inspection.
        req.on('error', () => {});
        const forward = (prefix: Buffer): void => {
            if (req.aborted || res.destroyed) return;
            // Do not invent an end-to-end Date header when the origin omits it.
            res.sendDate = false;
            let finished = false;
            const fail = (status: number) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                if (res.headersSent) res.destroy();
                else { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(status === 504 ? 'Gateway Timeout\n' : 'Bad Gateway\n'); }
                outgoing.destroy();
            };
            const outgoing = (upstream.protocol === 'https:' ? httpsRequest : httpRequest)({
                protocol: upstream.protocol, hostname, port: upstream.port || undefined,
                // Pin TLS identity too: an incoming Host must not choose SNI.
                ...(upstream.protocol === 'https:' ? { servername: isIP(hostname) ? '' : hostname } : {}),
                method: req.method, path: originTarget(req.url ?? '/'), headers: endToEndHeaders(req),
                // The target is fixed here; Host and absolute request targets never select it.
            }, response => {
                res.writeHead(response.statusCode ?? 502, response.statusMessage, endToEndHeaders(response));
                response.on('error', () => fail(502));
                response.once('end', () => { finished = true; clearTimeout(timer); });
                response.pipe(res);
            });
            const timer = setTimeout(() => fail(504), timeout);
            outgoing.on('error', () => fail(502));
            req.once('aborted', () => { clearTimeout(timer); outgoing.destroy(); });
            res.once('close', () => { clearTimeout(timer); outgoing.destroy(); });
            if (prefix.length) outgoing.write(prefix);
            req.pipe(outgoing);
        };
        if (process.env.AGENT_GUARD === 'off') { forward(Buffer.alloc(0)); return; }
        void (async () => {
            const prefix = await window(req);
            req.body = prefix.toString('utf8');
            if (String(req.headers['content-type']).includes('application/json')) {
                try { req.body = JSON.parse(req.body as string); } catch { /* Scan the bounded text on malformed/truncated JSON. */ }
            }
            const request = toRequest(req, options.config);
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const inspect = () => {
                    if (request.path === '/graphql') return inspectGraphqlRequest(options.guard, request);
                    if (request.path === '/mcp') {
                        const body = req.body as { method?: string; params?: { name?: string } } | null;
                        return inspectMcpRequest(options.guard, request, body?.method === 'tools/call' ? body.params?.name : undefined);
                    }
                    return options.guard.inspect(request);
                };
                // D5's existing intentional 300–600 ms response delay is outside
                // the computation budget; all other inspection gets 50 ms.
                const allowance = routes.match(request.path, request.method) === 'D5' ? 600 : 0;
                const decision = await Promise.race<AGDecision>([
                    Promise.resolve().then(inspect),
                    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), budget + allowance); }),
                ]);
                if (decision.action === 'respond' && !decision.events.some(event => event.event === 'crawler_bypass')) {
                    if (!res.destroyed) { res.writeHead(decision.response.status, decision.response.headers); res.end(req.method === 'HEAD' ? undefined : decision.response.body); req.resume(); }
                } else forward(prefix);
            } catch { report('proxy_inspect_error'); forward(prefix); }
            finally { clearTimeout(timer); }
        })().catch(() => { report('proxy_request_error'); if (!res.headersSent) forward(Buffer.alloc(0)); else res.destroy(); });
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    const rejectTunnel = (_req: IncomingMessage, socket: Socket) => { socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); };
    server.on('connect', rejectTunnel);
    server.on('upgrade', rejectTunnel);
    return { server, close: () => new Promise<void>(resolve => {
        const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); resolve(); }, 5000);
        server.close(() => { clearTimeout(timer); resolve(); });
    }) };
}
