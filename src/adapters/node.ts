import type { IncomingMessage, ServerResponse, RequestListener } from 'node:http';
import type { AgentGuard, AgentGuardConfig, AGRequest } from '../types.js';
import { createAgentGuard } from '../index.js';
import { guardConfigs } from '../config.js';
import { inspectionLimits } from '../core/limits.js';
import { appendRobots } from '../lures/robots.js';
export type ParsedRequest = IncomingMessage & {
    body?: unknown;
};
const plainPath = /^\/[A-Za-z0-9/_-]*$/;
export function toRequest(req: ParsedRequest, config?: AgentGuardConfig): AGRequest {
    const limits = inspectionLimits(config);
    const target = req.url ?? '/';
    const base = { method: req.method ?? 'GET', headers: req.headers, ip: req.socket.remoteAddress ?? '', body: req.body };
    const query = Object.create(null) as AGRequest['query'];
    // Leave overlong targets intact for inspect to mark as truncated; never parse them.
    if (target.length > limits.maxUrlLength || (plainPath.test(target) && !target.startsWith('//')))
        return { ...base, path: target, query };
    try {
        const url = new URL(target, 'http://local.invalid');
        let count = 0;
        for (const [key, value] of url.searchParams) {
            if (count++ >= limits.maxQueryParams) break;
            const old = query[key];
            if (old === undefined) query[key] = value;
            else if (Array.isArray(old)) old.push(value);
            else query[key] = [old, value];
        }
        return { ...base, path: url.pathname, query };
    } catch { return { ...base, path: target, query }; }
}

function isGuard(value: AgentGuard | AgentGuardConfig): value is AgentGuard { return 'inspect' in value; }
/** Transform only explicitly opted-in response paths. Streaming is untouched elsewhere. */
export function installLures(req: ParsedRequest, res: ServerResponse, guard: AgentGuard, config?: AgentGuardConfig): void {
    const url = (req.url ?? '/').slice(0, inspectionLimits(config).maxUrlLength), queryAt = url.indexOf('?');
    const path = queryAt < 0 ? url : url.slice(0, queryAt);
    const robots = path === '/robots.txt' && config?.lures?.robots === 'append';
    const llms = path === '/llms.txt' && config?.lures?.llmsTxt;
    const comment = guard.htmlCommentFor(path);
    if (req.method === 'HEAD' || (!robots && !llms && !comment))
        return;
    const chunks: Buffer[] = [];
    let length = 0, streaming = false;
    const write = res.write.bind(res), end = res.end.bind(res), writeHead = res.writeHead.bind(res);
    let deferredHead: [
        number,
        (string | import('node:http').OutgoingHttpHeaders | import('node:http').OutgoingHttpHeader[])?,
        (import('node:http').OutgoingHttpHeaders | import('node:http').OutgoingHttpHeader[])?
    ] | undefined;
    // Delay explicit writeHead until transformed content length is known.
    res.writeHead = ((...args: Parameters<ServerResponse['writeHead']>) => { deferredHead = args; return res; }) as ServerResponse['writeHead'];
    const restore = (): void => {
        res.writeHead = writeHead;
        if (deferredHead) {
            const extra = deferredHead[2] ?? (typeof deferredHead[1] === 'object' ? deferredHead[1] : undefined);
            if (Array.isArray(extra)) {
                const names = new Set<string>();
                for (let i = 0; i < extra.length; i += 2) {
                    const name = String(extra[i]), key = name.toLowerCase();
                    if (!names.has(key))
                        res.removeHeader(name);
                    names.add(key);
                    const value = extra[i + 1]!;
                    res.appendHeader(name, Array.isArray(value) ? value : String(value));
                }
            }
            else if (extra)
                for (const [k, v] of Object.entries(extra))
                    if (v !== undefined)
                        res.setHeader(k, v);
            if (typeof deferredHead[1] === 'string')
                res.statusMessage = deferredHead[1];
            res.statusCode = deferredHead[0];
        }
    };
    res.write = ((chunk: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined);
        if (streaming)
            return write(buffer, typeof encoding === 'function' ? encoding : callback);
        chunks.push(buffer);
        length += buffer.length;
        if (length > 1024 * 1024) {
            streaming = true;
            restore();
            for (const part of chunks)
                write(part);
            chunks.length = 0;
        }
        (typeof encoding === 'function' ? encoding : callback)?.();
        return true;
    }) as ServerResponse['write'];
    res.end = ((chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
        if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
            if (typeof encoding === 'string')
                res.write(chunk as string, encoding);
            else
                res.write(chunk as string);
        }
        if (streaming)
            return end(typeof chunk === 'function' ? chunk as () => void : typeof encoding === 'function' ? encoding : callback);
        restore();
        const original = Buffer.concat(chunks);
        let body: string | Buffer = original;
        const eligible = res.statusCode === 200 && !res.getHeader('Content-Encoding') && (robots || llms || (comment && String(res.getHeader('Content-Type')).includes('text/html')));
        if (eligible) {
            body = original.toString('utf8');
            if (robots)
                body = appendRobots(body, guard.robotsLines());
            if (llms) {
                const path = config?.decoys?.paths?.D4;
                const target = Array.isArray(path) ? path[0] : path;
                body += '\nInternal API reference: ' + (target ?? (config?.decoys?.basePath ?? '/api/internal') + '/openapi.json') + '\n';
            }
            if (comment && String(res.getHeader('Content-Type')).includes('text/html'))
                body += comment;
            res.removeHeader('ETag');
            res.removeHeader('Content-MD5');
        }
        if (eligible)
            res.setHeader('Content-Length', Buffer.byteLength(body));
        return end(body, typeof chunk === 'function' ? chunk as () => void : typeof encoding === 'function' ? encoding : callback);
    }) as ServerResponse['end'];
}
export function agentGuardNode(configOrGuard: AgentGuardConfig | AgentGuard): (req: ParsedRequest, res: ServerResponse, next: () => void) => void {
    const config = isGuard(configOrGuard) ? guardConfigs.get(configOrGuard) : configOrGuard, guard = isGuard(configOrGuard) ? configOrGuard : createAgentGuard(configOrGuard);
    return (req, res, next) => {
        void guard.inspect(toRequest(req, config)).then(decision => {
            try {
                if (decision.action === 'pass') {
                    installLures(req, res, guard, config);
                    next();
                    return;
                }
                // Delegate a verified crawler to the host's native not-found handler.
                if (decision.events.some(e => e.event === 'crawler_bypass')) {
                    next();
                    return;
                }
                res.writeHead(decision.response.status, decision.response.headers);
                res.end(decision.response.body);
            } catch { next(); }
        }, () => next());
    };
}
/** Body parsing belongs to the host; wrap accepts req.body without consuming its stream. */
export function wrap(guard: AgentGuard | AgentGuardConfig, handler: RequestListener): RequestListener {
    const middleware = agentGuardNode(guard);
    return (req, res) => middleware(req, res, () => handler(req, res));
}
