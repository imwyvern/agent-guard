import { it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import fastify from 'fastify';
import Koa from 'koa';
import { agentGuard as fastifyGuard } from '../../src/adapters/fastify.js';
import { agentGuard as koaGuard } from '../../src/adapters/koa.js';
import type { ParsedRequest } from '../../src/adapters/node.js';
import { createAgentGuard, generateCanary, type AgentGuard, type AgentGuardConfig, type AgentGuardEvent } from '../../src/index.js';
import { parseBody, startDemo } from '../../examples/shared/site.js';
import { listenLocal } from '../../examples/shared/loopback.js';
import { config, verifiedResolver } from '../helpers.js';

type Runtime = 'fastify' | 'koa';
type HostResponse = { body: string | Buffer | Readable; status?: number; headers?: Record<string, string> };
async function startHost(kind: Runtime, guard: AgentGuard | AgentGuardConfig, host: (path: string) => HostResponse = () => ({ body: 'host' })) {
    if (kind === 'fastify') {
        const app = fastify({ trustProxy: true });
        await app.register(fastifyGuard(guard));
        app.all('/*', (req, reply) => {
            const response = host(new URL(req.url, 'http://local.invalid').pathname);
            return reply.headers(response.headers ?? {}).code(response.status ?? 200).send(response.body);
        });
        await app.ready();
        const local = await listenLocal(app.server);
        return { url: local.url, async close() { await local.close(); await app.close(); } };
    }
    const app = new Koa({ proxy: true });
    app.use(koaGuard(guard));
    app.use(ctx => {
        const response = host(ctx.path);
        ctx.body = response.body;
        ctx.set(response.headers ?? {});
        ctx.status = response.status ?? 200;
    });
    return listenLocal(createServer(app.callback()));
}

for (const kind of ['fastify', 'koa'] as const) {
    it(`${kind}: bounds queries, preserves repeated/prototype keys and never matches a truncated decoy URL`, async () => {
        const events: AgentGuardEvent[] = [], secret = 'url-cap-secret';
        const host = await startHost(kind, config({ limits: { maxUrlLength: 100, maxQueryParams: 3 }, decoys: { paths: { D1: '/' + 'x'.repeat(99) } }, canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } }, onEvent: event => events.push(event) }));
        try {
            const token = generateCanary({ secret }).token;
            await fetch(host.url + '/?__proto__=' + token);
            await fetch(host.url + '/?key=one&key=' + token);
            await fetch(host.url + '/?a=1&b=2&c=3&key=' + token);
            expect(events.filter(event => event.event === 'canary_replay')).toHaveLength(2);
            for (const target of ['/' + 'x'.repeat(100), '/.env?padding=' + 'x'.repeat(200)])
                expect(await (await fetch(host.url + target)).text()).toBe('host');
            expect(events.some(event => event.event === 'decoy_hit')).toBe(false);
        } finally { await host.close(); }
    });

    it(`${kind}: uses the socket address with proxy trust enabled in the host; clientIp can explicitly override it`, async () => {
        for (const override of [false, true]) {
            const events: AgentGuardEvent[] = [];
            const guard = createAgentGuard(config({ allowlist: { ips: ['192.0.2.1'] }, clientIp: override ? () => '192.0.2.1' : undefined, onEvent: event => events.push(event) }));
            const inspect = vi.spyOn(guard, 'inspect');
            const host = await startHost(kind, guard);
            try {
                const response = await fetch(host.url + '/.env', { headers: { 'x-forwarded-for': '192.0.2.1', 'cf-connecting-ip': '192.0.2.1' } });
                expect((await response.text()).includes('ADMIN_API_TOKEN=')).toBe(!override);
                expect(inspect.mock.calls[0]?.[0].ip).toBe('127.0.0.1');
                expect(events.some(event => event.event === 'decoy_hit')).toBe(!override);
            } finally { await guard.close(); await host.close(); }
        }
    });

    it(`${kind}: synchronous/asynchronous inspection and lure hook errors fail open`, async () => {
        const guard = createAgentGuard(config({ lures: { robots: 'append' } }));
        const inspect = vi.spyOn(guard, 'inspect');
        inspect.mockImplementationOnce(() => { throw new Error('inspection failed'); });
        inspect.mockRejectedValueOnce(new Error('inspection rejected'));
        vi.spyOn(guard, 'robotsLines').mockImplementation(() => { throw new Error('transform failed'); });
        const host = await startHost(kind, guard, () => ({ body: 'host', headers: { etag: 'original' } }));
        try {
            for (const path of ['/.env', '/.env', '/robots.txt']) {
                const response = await fetch(host.url + path);
                expect(response.status).toBe(200);
                expect(response.headers.get('etag')).toBe('original');
                expect(await response.text()).toBe('host');
            }
        } finally { await guard.close(); await host.close(); }
    });

    it(`${kind}: transforms opted-in buffers/strings, custom llms targets and validators, including exactly 1 MiB`, async () => {
        const large = 'x'.repeat(1024 * 1024);
        const host = await startHost(kind, config({ decoys: { paths: { D4: ['/custom/spec.json'] } }, lures: { robots: 'append', llmsTxt: true, htmlComment: { paths: ['/html', '/limit'] } } }), path => ({
            body: path === '/limit' ? large : Buffer.from('original é\n'),
            headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(path === '/limit' ? large : 'original é\n')), etag: 'old', 'content-md5': 'old', 'x-app': 'kept' },
        }));
        try {
            for (const [path, suffix] of [['/robots.txt?source=1', 'Disallow: /.env'], ['/llms.txt', 'Internal API reference: /custom/spec.json'], ['/html', '<!-- TODO(ops)'], ['/limit', '<!-- TODO(ops)']]) {
                const response = await fetch(host.url + path);
                const body = await response.text();
                expect(body.startsWith(path === '/limit' ? large : 'original é\n')).toBe(true);
                expect(body).toContain(suffix);
                expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
                expect(response.headers.has('etag')).toBe(false);
                expect(response.headers.has('content-md5')).toBe(false);
                expect(response.headers.get('x-app')).toBe('kept');
            }
        } finally { await host.close(); }
    });

    it(`${kind}: leaves streams, large, compressed, binary, non-200, HEAD and unselected responses unchanged`, async () => {
        const large = 'x'.repeat(1024 * 1024 + 1), compressed = gzipSync('compressed');
        const host = await startHost(kind, config({ lures: { htmlComment: { paths: ['/stream', '/large', '/compressed', '/binary', '/error', '/created', '/partial', '/head'] } } }), path => ({
            body: path === '/stream' ? Readable.from(['stream']) : path === '/large' ? large : path === '/compressed' ? compressed : path === '/binary' ? Buffer.from([255, 254, 0]) : 'original',
            status: path === '/error' ? 503 : path === '/created' ? 201 : path === '/partial' ? 206 : 200,
            headers: { 'content-type': path === '/binary' ? 'application/octet-stream' : 'text/html', etag: 'original', 'content-md5': 'original', ...(path === '/compressed' ? { 'content-encoding': 'gzip' } : {}) },
        }));
        try {
            for (const [path, expected] of [['/stream', 'stream'], ['/large', large], ['/compressed', 'compressed'], ['/error', 'original'], ['/created', 'original'], ['/partial', 'original'], ['/ordinary', 'original'], ['/robots.txt', 'original'], ['/llms.txt', 'original'], ['/head', '']]) {
                const response = await fetch(host.url + path, path === '/head' ? { method: 'HEAD' } : undefined);
                expect(await response.text()).toBe(expected);
                expect(response.headers.get('etag')).toBe('original');
                expect(response.headers.get('content-md5')).toBe('original');
            }
            expect([...new Uint8Array(await (await fetch(host.url + '/binary')).arrayBuffer())]).toEqual([255, 254, 0]);
        } finally { await host.close(); }
    });

    it(`${kind}: manual/off robots settings preserve host responses`, async () => {
        for (const robots of ['manual', 'off'] as const) {
            const host = await startHost(kind, config({ lures: { robots } }));
            try { expect(await (await fetch(host.url + '/robots.txt')).text()).toBe('host'); }
            finally { await host.close(); }
        }
    });

    it(`${kind}: demo body parsers enforce the 16 KiB cap before inspection`, async () => {
        const demo = await startDemo(kind, config());
        try {
            const response = await fetch(demo.url + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(16384) }) });
            expect(response.status).toBe(kind === 'fastify' ? 413 : 400);
            expect(demo.guard!.metrics().requests_inspected).toBe(0);
        } finally { await demo.close(); }
    });

    it(`${kind}: built ESM/CJS subpaths retain root guard limits and lure configuration`, async () => {
        const { createRequire } = await import('node:module');
        const require = createRequire(import.meta.url);
        for (const format of ['esm', 'cjs']) {
            const root = (format === 'esm' ? await import('../../dist/index.js') : require('../../dist/index.cjs')) as typeof import('../../src/index.js');
            const events: AgentGuardEvent[] = [];
            const guard = root.createAgentGuard(config({ limits: { maxQueryParams: 0 }, lures: { robots: 'append' }, onEvent: event => events.push(event) }));
            const adapter = format === 'esm' ? await import(`../../dist/${kind}.js`) : require(`../../dist/${kind}.cjs`);
            let close: () => Promise<void>, url: string;
            if (kind === 'fastify') {
                const app = fastify();
                await app.register((adapter as typeof import('../../src/adapters/fastify.js')).agentGuard(guard));
                app.all('/*', () => 'host');
                await app.ready();
                const local = await listenLocal(app.server);
                url = local.url;
                close = async () => { await local.close(); await app.close(); };
            } else {
                const app = new Koa();
                app.use((adapter as typeof import('../../src/adapters/koa.js')).agentGuard(guard));
                app.use(ctx => { ctx.body = 'host'; });
                const local = await listenLocal(createServer(app.callback()));
                url = local.url;
                close = local.close;
            }
            try {
                expect(await (await fetch(url + '/robots.txt')).text()).toContain('Disallow: /.env');
                await fetch(url + '/?token=' + generateCanary({ secret: 'local-demo-secret-never-use-in-production' }).token);
                expect(events.some(event => event.event === 'canary_replay')).toBe(false);
            } finally { await guard.close(); await close(); }
        }
    });
}

it('Fastify hooks cover host routes and native 404s, inspect parsed bodies and short-circuit decoys', async () => {
    const events: AgentGuardEvent[] = [];
    const app = fastify({ trustProxy: true });
    const guard = createAgentGuard(config({ crawler: { resolver: verifiedResolver }, onEvent: event => events.push(event) }));
    const inspect = vi.spyOn(guard, 'inspect');
    await app.register(fastifyGuard(guard));
    const host = vi.fn(() => 'host');
    app.get('/.env', host);
    app.post('/login', req => req.body);
    try {
        const body = { password: generateCanary({ secret: 'local-demo-secret-never-use-in-production' }).token };
        expect((await app.inject({ method: 'POST', url: '/login', payload: body })).json()).toEqual(body);
        expect(inspect.mock.calls[0]?.[0].body).toEqual(body);
        expect(events.filter(event => event.event === 'canary_replay')).toHaveLength(1);
        const decoy = await app.inject('/.env');
        expect(decoy.body).toContain('ADMIN_API_TOKEN=');
        expect(host).not.toHaveBeenCalled();
        const normal = await app.inject('/missing');
        const bypass = await app.inject({ url: '/internal/ops-notes', headers: { 'user-agent': 'Googlebot' } });
        expect(normal.statusCode).toBe(404);
        expect(bypass.statusCode).toBe(404);
        expect(bypass.headers['x-robots-tag']).toBeUndefined();
        expect(bypass.json()).toMatchObject({ error: 'Not Found' });
        expect(events.some(event => event.event === 'crawler_bypass')).toBe(true);
        const before = inspect.mock.calls.length;
        expect((await app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: '{' })).statusCode).toBe(400);
        expect(inspect.mock.calls).toHaveLength(before);
    } finally { await guard.close(); await app.close(); }
});

for (const location of ['request', 'raw', 'unparsed'] as const)
    it(`Koa respects ${location} host body parsing and preserves the downstream request`, async () => {
        const events: AgentGuardEvent[] = [], app = new Koa();
        const guard = createAgentGuard(config({ onEvent: event => events.push(event) }));
        const inspect = vi.spyOn(guard, 'inspect');
        if (location !== 'unparsed') app.use(async (ctx, next) => {
            const body = await parseBody(ctx.req);
            if (location === 'raw') (ctx.req as ParsedRequest).body = body;
            else (ctx.request as typeof ctx.request & { body?: unknown }).body = body;
            await next();
        });
        app.use(koaGuard(guard));
        app.use(async ctx => {
            ctx.body = location === 'unparsed' ? await parseBody(ctx.req) : (ctx.request as typeof ctx.request & { body?: unknown }).body ?? (ctx.req as ParsedRequest).body;
        });
        const local = await listenLocal(createServer(app.callback()));
        try {
            const body = { password: generateCanary({ secret: 'local-demo-secret-never-use-in-production' }).token };
            const response = await fetch(local.url + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            expect(await response.json()).toEqual(body);
            expect(inspect.mock.calls[0]?.[0].body).toEqual(location === 'unparsed' ? undefined : body);
            expect(events.filter(event => event.event === 'canary_replay')).toHaveLength(location === 'unparsed' ? 0 : 1);
        } finally { await guard.close(); await local.close(); }
    });

it('Koa crawler bypass preserves the native missing-route response', async () => {
    const app = new Koa(), events: AgentGuardEvent[] = [];
    const guard = createAgentGuard(config({ crawler: { resolver: verifiedResolver }, onEvent: event => events.push(event) }));
    app.use(koaGuard(guard));
    const local = await listenLocal(createServer(app.callback()));
    try {
        const missing = await fetch(local.url + '/missing');
        const bypass = await fetch(local.url + '/.env', { headers: { 'user-agent': 'Googlebot' } });
        expect(bypass.status).toBe(missing.status);
        expect(await bypass.text()).toBe(await missing.text());
        expect(bypass.headers.get('content-type')).toBe(missing.headers.get('content-type'));
        expect(bypass.headers.has('x-robots-tag')).toBe(false);
        expect(events.filter(event => event.event === 'crawler_bypass')).toHaveLength(1);
    } finally { await guard.close(); await local.close(); }
});
