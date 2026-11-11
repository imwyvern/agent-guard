import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { listenLocal } from './loopback.js';
import { createAgentGuard, consoleAdapter, webhookAdapter, type AgentGuard, type AgentGuardConfig, type AGResponse } from '../../src/index.js';
import { agentGuardNode, type ParsedRequest } from '../../src/adapters/node.js';
export const realPaths = ['/', '/list', '/item/1', '/login', '/pricing'];
export const browserUA = 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36';
export function demoConfig(overrides: Partial<AgentGuardConfig> = {}): AgentGuardConfig {
    return { project: 'agent-guard-demo', env: 'demo', mode: 'detect', projectSeed: 'agent-guard-demo-v1', canary: { secret: process.env.AG_CANARY_SECRET ?? 'local-demo-secret-never-use-in-production', registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
        lures: { robots: 'append', htmlComment: { paths: ['/login'] } },
        // Demos are offline: injected resolver models a failed identity check, never contacts DNS.
        crawler: { resolver: { reverse: async () => [], resolve: async () => [] } },
        alerts: { adapters: [consoleAdapter(), ...(process.env.AG_WEBHOOK_URL ? [webhookAdapter({ url: process.env.AG_WEBHOOK_URL, secret: process.env.AG_WEBHOOK_SECRET ?? 'local-webhook-secret' })] : [])] }, ...overrides };
}
function page(title: string, content: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="A local demonstration catalog for agent-guard research."><title>${title} — Local catalog</title><link rel="stylesheet" href="/static/site.css"></head><body><header><nav aria-label="Main"><a href="/">Home</a> <a href="/list">Catalog</a> <a href="/pricing">Pricing</a> <a href="/login">Login</a></nav></header><main><h1>${title}</h1>${content}</main><footer>Local research demonstration</footer></body></html>`;
}
export function siteResponse(path: string, method: string, data?: unknown): AGResponse {
    const headers: Record<string, string> = {};
    let status = 200, type = 'text/html; charset=utf-8', body = '';
    if (path === '/' && method === 'GET')
        body = page('Local catalog', '<p>Browse a small collection of sample items.</p><a href="/list">Browse items</a>');
    else if (path === '/list')
        body = page('Catalog', '<ul><li><a href="/item/1">Sample notebook</a></li><li><a href="/item/2">Sample pencil</a></li></ul>');
    else if (/^\/item\/\d+$/.test(path))
        body = page('Sample item', '<p>A sample item for local testing.</p><a href="/list">Back to catalog</a>');
    else if (path === '/pricing')
        body = page('Pricing', '<p>Research demo: free.</p>');
    else if (path === '/login' && method === 'GET')
        body = page('Login', '<form method="post" action="/login"><label>Email <input name="email" type="email" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>');
    else if (path === '/login' && method === 'POST') {
        const login = data as Record<string, unknown> | undefined, ok = login?.email === 'demo@example.invalid' && login.password === 'demo-password';
        status = ok ? 200 : 401;
        type = 'application/json; charset=utf-8';
        body = JSON.stringify({ ok });
        if (ok)
            headers['Set-Cookie'] = 'demo_session=local-only; HttpOnly; SameSite=Lax; Path=/';
    }
    else if (path === '/logout' && method === 'POST') {
        type = 'application/json; charset=utf-8';
        body = '{"ok":true}';
        headers['Set-Cookie'] = 'demo_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax';
    }
    else if (path === '/robots.txt') {
        type = 'text/plain; charset=utf-8';
        body = 'User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n';
    }
    else if (path === '/sitemap.xml') {
        type = 'application/xml; charset=utf-8';
        body = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + realPaths.map(p => `<url><loc>http://catalog.invalid${p}</loc></url>`).join('') + '</urlset>';
    }
    else if (path === '/static/site.css') {
        type = 'text/css; charset=utf-8';
        body = 'body{font:18px system-ui,sans-serif;max-width:64rem;margin:2rem auto;padding:1rem;color:#202020;background:#fff}a{color:#123d85}nav a{margin-right:1rem}label{display:block;margin:1rem 0}input,button{font:inherit}main{min-height:24rem}';
    }
    else if (path === '/llms.txt') {
        type = 'text/plain; charset=utf-8';
        body = '# Local catalog\nA research demonstration.\n';
    }
    else {
        status = 404;
        type = 'text/plain; charset=utf-8';
        body = 'Not Found\n';
    }
    return { status, headers: { ...headers, 'Content-Type': type, 'Content-Length': String(Buffer.byteLength(body)) }, body };
}
export function site(req: ParsedRequest, res: ServerResponse): void {
    const response = siteResponse(new URL(req.url ?? '/', 'http://local.invalid').pathname, req.method ?? 'GET', req.body);
    res.writeHead(response.status, response.headers);
    res.end(req.method === 'HEAD' ? '' : response.body);
}
/** Demo-only bounded parser, installed before either middleware. */
export async function parseBody(req: IncomingMessage): Promise<unknown> {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method ?? ''))
        return undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += Buffer.byteLength(chunk as Buffer);
        if (size > 16384)
            throw new Error('body too large');
        chunks.push(Buffer.from(chunk as Buffer));
    }
    const body = Buffer.concat(chunks).toString('utf8');
    if (!body)
        return undefined;
    if (String(req.headers['content-type']).includes('application/json'))
        return JSON.parse(body) as unknown;
    if (String(req.headers['content-type']).includes('application/x-www-form-urlencoded'))
        return Object.fromEntries(new URLSearchParams(body));
    return body;
}
export interface Demo {
    server: Server;
    guard?: AgentGuard;
    url: string;
    close(): Promise<void>;
}
export async function startDemo(kind: 'express' | 'node' | 'hono' | 'fastify' | 'koa', config: AgentGuardConfig | false = demoConfig(), port = 0): Promise<Demo> {
    const guard = config ? createAgentGuard(config) : undefined;
    let server: Server;
    let closeRuntime: (() => Promise<void>) | undefined;
    if (kind === 'express') {
        const { default: express } = await import('express');
        const { agentGuard } = await import('../../src/adapters/express.js');
        const app = express();
        app.disable('x-powered-by');
        app.disable('etag');
        app.use(express.json({ limit: 16384 }), express.urlencoded({ extended: false, limit: 16384 }));
        if (guard)
            app.use(agentGuard(guard));
        app.use(site);
        server = createServer(app);
    }
    else if (kind === 'fastify') {
        const { default: fastify } = await import('fastify');
        const { agentGuard } = await import('../../src/adapters/fastify.js');
        const app = fastify({ bodyLimit: 16384 });
        app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, async (_req: import('fastify').FastifyRequest, body: string) => Object.fromEntries(new URLSearchParams(body)));
        if (guard) await app.register(agentGuard(guard));
        app.all('/*', async (req, reply) => {
            const response = siteResponse(new URL(req.url, 'http://local.invalid').pathname, req.method, req.body);
            return reply.headers(response.headers).code(response.status).send(req.method === 'HEAD' ? '' : response.body);
        });
        await app.ready();
        server = app.server;
        closeRuntime = () => app.close();
    }
    else if (kind === 'koa') {
        const { default: Koa } = await import('koa');
        const { agentGuard } = await import('../../src/adapters/koa.js');
        const app = new Koa();
        app.use(async (ctx, next) => {
            try { (ctx.req as ParsedRequest).body = await parseBody(ctx.req); }
            catch { ctx.status = 400; ctx.body = 'Bad Request\n'; return; }
            await next();
        });
        if (guard) app.use(agentGuard(guard));
        app.use(ctx => {
            const response = siteResponse(ctx.path, ctx.method, (ctx.req as ParsedRequest).body);
            ctx.body = response.body;
            ctx.set(response.headers);
            ctx.status = response.status;
        });
        server = createServer(app.callback());
    }
    else if (kind === 'hono') {
        const { Hono } = await import('hono');
        const { getRequestListener } = await import('@hono/node-server');
        const { agentGuard } = await import('../../src/adapters/hono.js');
        const app = new Hono();
        if (guard) app.use('*', agentGuard(guard));
        app.all('*', async c => {
            let data: unknown;
            try {
                if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
                    const text = await c.req.text();
                    if (Buffer.byteLength(text) > 16384) throw new Error('body too large');
                    data = c.req.header('content-type')?.includes('application/json') ? JSON.parse(text || 'null') as unknown : Object.fromEntries(new URLSearchParams(text));
                }
            } catch { return new Response('Bad Request\n', { status: 400 }); }
            const response = siteResponse(c.req.path, c.req.method, data);
            return new Response(c.req.method === 'HEAD' ? null : response.body, { status: response.status, headers: response.headers });
        });
        server = createServer(getRequestListener(app.fetch));
    }
    else {
        const middleware = guard ? agentGuardNode(guard) : undefined;
        server = createServer((req: ParsedRequest, res) => {
            void (async () => {
                req.body = await parseBody(req);
                if (middleware)
                    middleware(req, res, () => site(req, res));
                else
                    site(req, res);
            })().catch(() => { res.writeHead(400); res.end('Bad Request\n'); });
        });
    }
    const local = await listenLocal(server, port);
    return { server, guard, url: local.url, async close() { await guard?.close(); await local.close(); await closeRuntime?.(); } };
}
