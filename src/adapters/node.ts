import type { IncomingMessage, ServerResponse, RequestListener } from 'node:http';
import type { AgentGuard, AgentGuardConfig, AGRequest } from '../types.js';
import { createAgentGuard } from '../index.js';
import { guardConfigs } from '../config.js';
import { appendRobots } from '../lures/robots.js';
export type ParsedRequest = IncomingMessage & {
    body?: unknown;
};
export function toRequest(req: ParsedRequest): AGRequest {
    const url = new URL(req.url ?? '/', 'http://local.invalid'), query: AGRequest['query'] = {};
    for (const key of new Set(url.searchParams.keys())) {
        const values = url.searchParams.getAll(key);
        query[key] = values.length === 1 ? values[0]! : values;
    }
    return { method: req.method ?? 'GET', path: url.pathname, query, headers: req.headers, ip: req.socket.remoteAddress ?? '', body: req.body };
}
function isGuard(value: AgentGuard | AgentGuardConfig): value is AgentGuard { return 'inspect' in value; }
/** Transform only explicitly opted-in response paths. Streaming is untouched elsewhere. */
export function installLures(req: ParsedRequest, res: ServerResponse, guard: AgentGuard, config?: AgentGuardConfig): void {
    const path = (req.url ?? '/').split('?')[0]!;
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
        void guard.inspect(toRequest(req)).then(decision => {
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
        }).catch(() => next());
    };
}
/** Body parsing belongs to the host; wrap accepts req.body without consuming its stream. */
export function wrap(guard: AgentGuard | AgentGuardConfig, handler: RequestListener): RequestListener {
    const middleware = agentGuardNode(guard);
    return (req, res) => middleware(req, res, () => handler(req, res));
}
