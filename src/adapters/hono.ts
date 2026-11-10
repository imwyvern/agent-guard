import type { MiddlewareHandler } from 'hono';
import type { IncomingMessage } from 'node:http';
import type { AgentGuard, AgentGuardConfig, AGRequest } from '../types.js';
import { createAgentGuard } from '../index.js';
import { guardConfigs } from '../config.js';
import { inspectionLimits } from '../core/limits.js';
import { matchesPath } from '../canary/scan.js';
import { appendRobots } from '../lures/robots.js';

/** Clone/tee readers must not await cancel: it can wait for the downstream branch. */
async function readPrefix(request: Request | Response, cap: number): Promise<{ bytes: Buffer; complete: boolean }> {
    cap = Math.floor(cap);
    const reader = request.clone().body?.getReader();
    if (!reader) return { bytes: Buffer.alloc(0), complete: true };
    const chunks: Buffer[] = [];
    let size = 0, complete = false;
    try {
        while (size < cap) {
            const { done, value } = await reader.read();
            if (done) { complete = true; break; }
            const chunk = Buffer.from(value.subarray(0, cap - size));
            chunks.push(chunk);
            size += chunk.length;
        }
        return { bytes: Buffer.concat(chunks), complete };
    } finally {
        void reader.cancel().catch(() => {});
    }
}

function parseBody(text: string, type: string): unknown {
    try {
        if (type.includes('application/json')) return JSON.parse(text) as unknown;
        if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
    } catch { /* A partial/malformed body is still scanned as bounded text. */ }
    return text;
}

/** Hono on Node >=20. The core uses node:crypto and node:dns; edge is future work. */
export function agentGuard(configOrGuard: AgentGuard | AgentGuardConfig): MiddlewareHandler {
    const guard = 'inspect' in configOrGuard ? configOrGuard : createAgentGuard(configOrGuard);
    const config = guardConfigs.get(guard), limits = inspectionLimits(config);
    return async (c, next) => {
        let decision;
        try {
            const raw = c.req.raw, url = raw.url;
            const pathAt = url.indexOf('/', url.indexOf('://') + 3);
            const target = pathAt < 0 ? '/' : url.slice(pathAt);
            // Match the Node adapter's target cap, without counting scheme/host.
            // Keep an oversized target intact so core cannot match a truncated decoy.
            const path = target.length > limits.maxUrlLength ? target : c.req.path;
            const query = Object.create(null) as AGRequest['query'];
            if (target.length <= limits.maxUrlLength) {
                let count = 0;
                for (const [key, value] of new URL(url).searchParams) {
                    if (count++ >= limits.maxQueryParams) break;
                    const old = query[key];
                    if (old === undefined) query[key] = value;
                    else if (Array.isArray(old)) old.push(value);
                    else query[key] = [old, value];
                }
            }
            const headers = Object.fromEntries(raw.headers);
            // @hono/node-server supplies the IncomingMessage in Bindings. Forwarded
            // headers remain untrusted; clientIp can override this behind a proxy.
            const incoming = c.env?.incoming as IncomingMessage | undefined;
            const request: AGRequest = { method: raw.method, path, query, headers, ip: incoming?.socket.remoteAddress ?? '' };
            const d5 = config?.decoys?.paths?.D5 ?? (config?.decoys?.basePath ?? '/api/internal') + '/auth/login';
            const scanBody = (Array.isArray(d5) ? d5 : [d5]).includes(path) || (config?.canaryScan?.bodyPaths ?? ['/login', '/api/auth/*']).some(pattern => matchesPath(path, pattern));
            if (scanBody && raw.body && limits.maxBodyBytes > 0) {
                try {
                    const { bytes } = await readPrefix(raw, limits.maxBodyBytes);
                    request.body = parseBody(bytes.toString('utf8'), headers['content-type'] ?? '');
                } catch { /* Body read failures never deny a host request. */ }
            }
            decision = await guard.inspect(request);
        } catch { /* Inspection failures pass through to the host. */ }
        if (decision?.action === 'respond' && !decision.events.some(event => event.event === 'crawler_bypass')) {
            const { response } = decision;
            c.res = new Response(c.req.method === 'HEAD' ? null : response.body, { status: response.status, headers: response.headers });
            return;
        }
        await next();
        if (decision?.action !== 'pass' || c.req.method === 'HEAD') return;
        const path = c.req.path, response = c.res;
        const robots = path === '/robots.txt' && config?.lures?.robots === 'append';
        const llms = path === '/llms.txt' && config?.lures?.llmsTxt;
        const comment = guard.htmlCommentFor(path);
        const html = response.headers.get('content-type')?.includes('text/html');
        if (response.status !== 200 || response.headers.has('content-encoding') || !(robots || llms || (comment && html))) return;
        try {
            const { bytes, complete } = await readPrefix(response, 1024 * 1024 + 1);
            if (!complete || bytes.length > 1024 * 1024) return;
            let body = bytes.toString('utf8');
            if (robots) body = appendRobots(body, guard.robotsLines());
            if (llms) {
                const target = config?.decoys?.paths?.D4;
                body += '\nInternal API reference: ' + ((Array.isArray(target) ? target[0] : target) ?? (config?.decoys?.basePath ?? '/api/internal') + '/openapi.json') + '\n';
            }
            if (comment && html) body += comment;
            const headers = new Headers(response.headers);
            c.res = new Response(body, { status: response.status, headers });
            // Hono merges the previous response headers in its response setter.
            c.res.headers.delete('etag');
            c.res.headers.delete('content-md5');
            c.res.headers.set('content-length', String(Buffer.byteLength(body)));
        } catch { /* Failed transforms preserve the original response. */ }
    };
}
