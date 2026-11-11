import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { startDemo } from '../../examples/shared/site.js';
import { listenLocal } from '../../examples/shared/loopback.js';
import { wrap } from '../../src/adapters/node.js';
import { config } from '../helpers.js';
for (const kind of ['express', 'node', 'hono', 'fastify', 'koa'] as const)
    it(`${kind}: request matrix, dotenv aliases, 401/403/405 and inert fake OpenAPI`, async () => {
        const demo = await startDemo(kind, config());
        try {
            for (const path of ['/.env', '/.env.local', '/.env.production', '/.env.bak']) {
                const r = await fetch(demo.url + path);
                expect(r.status).toBe(200);
                const text = await r.text();
                expect(text.trim().split('\n')).toHaveLength(15);
                expect(text.match(/AG-CANARY-/g)).toHaveLength(3);
                expect(text).toContain('@db-internal.invalid:5432/');
            }
            const unauth = await fetch(demo.url + '/api/internal/admin');
            expect(unauth.status).toBe(401);
            expect(await unauth.json()).toEqual({ error: 'missing internal token', hint: 'see /api/internal/openapi.json' });
            expect((await fetch(demo.url + '/api/internal/admin/users', { headers: { authorization: 'Bearer anything' } })).status).toBe(403);
            const get = await fetch(demo.url + '/api/internal/auth/login');
            expect(get.status).toBe(405);
            expect(get.headers.get('allow')).toBe('POST');
            const start = performance.now();
            expect((await fetch(demo.url + '/api/internal/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=anything' })).status).toBe(401);
            expect(performance.now() - start).toBeGreaterThanOrEqual(300);
            expect(performance.now() - start).toBeLessThan(650);
            const spec = await (await fetch(demo.url + '/api/internal/openapi.json')).json() as {
                openapi: string;
                servers: Array<{
                    url: string;
                }>;
                paths: Record<string, unknown>;
            };
            expect(spec.openapi).toBe('3.1.0');
            expect(spec.servers[0]?.url).toBe('/');
            expect(Object.keys(spec.paths)).toHaveLength(7);
            expect(Object.keys(spec.paths).every(p => p.startsWith('/api/internal/admin/'))).toBe(true);
            expect((await fetch(demo.url + '/missing')).status).toBe(404);
        }
        finally {
            await demo.close();
        }
    });
it('native wrap works with config, append/manual/off and unchanged streams', async () => {
    for (const lures of [{ robots: 'append' as const, llmsTxt: true, htmlComment: { paths: ['/html'] } }, { robots: 'manual' as const }, { robots: 'off' as const }]) {
        const server = createServer(wrap(config({ lures }), (req, res) => { res.statusCode = 200; res.setHeader('Content-Type', req.url === '/html' ? 'text/html' : 'text/plain'); res.setHeader('ETag', 'old'); res.write('original'); res.end(' content'); })), local = await listenLocal(server);
        try {
            const robots = await (await fetch(local.url + '/robots.txt')).text();
            expect(robots.startsWith('original content')).toBe(true);
            expect(robots.includes('Disallow')).toBe(lures.robots === 'append');
            const llms = await (await fetch(local.url + '/llms.txt')).text();
            expect(llms.includes('Internal API reference')).toBe(lures.llmsTxt === true);
            const html = await fetch(local.url + '/html');
            expect((await html.text()).includes('<!--')).toBe(Boolean(lures.htmlComment));
        }
        finally {
            await local.close();
        }
    }
});
it('opt-in transforms preserve explicit headers, raw buffers and error responses; large streams pass through', async () => {
    const configForTest = config({ lures: { robots: 'append', htmlComment: { paths: ['/binary', '/error', '/large'] } } });
    const server = createServer(wrap(configForTest, (req, res) => {
        if (req.url === '/binary') {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-App': 'kept' });
            res.end(Buffer.from([255, 254, 0]));
        }
        else if (req.url === '/error') {
            res.writeHead(503, 'Unavailable', { 'Content-Type': 'text/html', 'X-App': 'kept' });
            res.end('<p>Error</p>');
        }
        else if (req.url === '/large') {
            res.setHeader('Content-Type', 'text/html');
            res.write(Buffer.alloc(1024 * 1024 + 1, 65));
            res.end('end');
        }
        else {
            res.writeHead(200, ['Content-Type', 'text/plain', 'X-App', 'kept']);
            res.end('User-agent: *\n');
        }
    })), local = await listenLocal(server);
    try {
        const binary = await fetch(local.url + '/binary');
        expect(binary.headers.get('x-app')).toBe('kept');
        expect([...new Uint8Array(await binary.arrayBuffer())]).toEqual([255, 254, 0]);
        const error = await fetch(local.url + '/error');
        expect(error.status).toBe(503);
        expect(error.headers.get('x-app')).toBe('kept');
        expect(await error.text()).toBe('<p>Error</p>');
        const large = await (await fetch(local.url + '/large')).text();
        expect(large.length).toBe(1024 * 1024 + 4);
        expect(large.endsWith('end')).toBe(true);
        const robots = await fetch(local.url + '/robots.txt');
        expect(robots.headers.get('x-app')).toBe('kept');
        expect(await robots.text()).toContain('Disallow: /.env');
    }
    finally {
        await local.close();
    }
});
it('built ESM/CJS subpath adapters preserve guard configuration across bundles', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    for (const format of ['esm', 'cjs']) {
        const root = (format === 'esm' ? await import('../../dist/index.js') : require('../../dist/index.cjs')) as typeof import('../../src/index.js');
        const adapter = (format === 'esm' ? await import('../../dist/node.js') : require('../../dist/node.cjs')) as typeof import('../../src/adapters/node.js');
        const guard = root.createAgentGuard(config({ lures: { robots: 'append' } })), server = createServer(adapter.wrap(guard, (_req, res) => res.end('Original\n'))), local = await listenLocal(server);
        try {
            expect(await (await fetch(local.url + '/robots.txt')).text()).toContain('Disallow: /.env');
        }
        finally {
            await guard.close();
            await local.close();
        }
    }
});
