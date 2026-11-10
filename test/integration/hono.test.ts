import { it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { agentGuard } from '../../src/adapters/hono.js';
import { createAgentGuard, generateCanary, type AgentGuardEvent } from '../../src/index.js';
import { config } from '../helpers.js';

it('Hono caps the request target before query parsing and retains query/prototype key semantics', async () => {
    const events: AgentGuardEvent[] = [], secret = 'url-cap-secret';
    const guard = createAgentGuard(config({ limits: { maxUrlLength: 100, maxQueryParams: 3 }, canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } }, onEvent: event => events.push(event) }));
    const app = new Hono();
    app.use('*', agentGuard(guard));
    app.all('*', c => c.text('host'));
    try {
        const token = generateCanary({ secret }).token;
        await app.request('/?__proto__=' + token);
        await app.request('/?key=one&key=' + token);
        await app.request('/?a=1&b=2&c=3&key=' + token);
        expect(events.filter(event => event.event === 'canary_replay')).toHaveLength(2);
        expect(await (await app.request('/.env?padding=' + 'x'.repeat(200))).text()).toBe('host');
        expect(events.some(event => event.event === 'decoy_hit')).toBe(false);
    } finally { await guard.close(); }
});

it('Hono scans a capped cloned body and preserves the full downstream body without blocking', async () => {
    const events: AgentGuardEvent[] = [], secret = 'body-cap-secret';
    const guard = createAgentGuard(config({ canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } }, limits: { maxBodyBytes: 128 }, onEvent: event => events.push(event) }));
    const token = generateCanary({ secret }).token;
    const app = new Hono();
    app.use('*', agentGuard(guard));
    app.post('/login', async c => c.text(await c.req.text()));
    try {
        for (const body of [token + 'x'.repeat(10000), 'x'.repeat(10000) + token]) {
            const response = await app.request('/login', { method: 'POST', body });
            expect(response.status).toBe(200);
            expect(await response.text()).toBe(body);
        }
        expect(events.filter(event => event.event === 'canary_replay')).toHaveLength(1);
        expect(events.find(event => event.event === 'canary_replay')?.canary?.found_in).toBe('body');
    } finally { await guard.close(); }
});

it('Hono scans custom body paths including PUT/PATCH, malformed JSON and form data', async () => {
    const events: AgentGuardEvent[] = [];
    const guard = createAgentGuard(config({ canaryScan: { bodyPaths: ['/custom/*'] }, onEvent: event => events.push(event) }));
    const token = generateCanary({ secret: 'local-demo-secret-never-use-in-production' }).token;
    const app = new Hono();
    app.use('*', agentGuard(guard));
    app.all('*', async c => c.text(await c.req.text()));
    try {
        for (const [method, type, body] of [
            ['PUT', 'application/json', '{"token":"' + token + '"'],
            ['PATCH', 'application/x-www-form-urlencoded', 'password=' + encodeURIComponent(token)],
        ]) {
            expect(await (await app.request('/custom/login', { method, headers: { 'content-type': type! }, body })).text()).toBe(body);
        }
        expect(events.filter(event => event.event === 'canary_replay')).toHaveLength(2);
        await app.request('/other', { method: 'POST', body: token });
        expect(events.filter(event => event.event === 'canary_replay')).toHaveLength(2);
    } finally { await guard.close(); }
});

it('Hono passes ordinary streams and failed inspection through and preserves oversized lure responses', async () => {
    const guard = createAgentGuard(config({ lures: { htmlComment: { paths: ['/large', '/binary', '/error'] } } }));
    const app = new Hono();
    app.use('*', agentGuard(guard));
    const large = 'x'.repeat(1024 * 1024 + 20);
    app.get('/large', c => c.html(large));
    app.get('/binary', () => new Response(new Uint8Array([255, 254, 0])));
    app.get('/error', () => new Response('unavailable', { status: 503, headers: { 'content-type': 'text/html' } }));
    let entered = false;
    app.post('/stream', async c => { entered = true; return c.text(await c.req.text()); });
    try {
        expect(await (await app.request('/large')).text()).toBe(large);
        expect([...new Uint8Array(await (await app.request('/binary')).arrayBuffer())]).toEqual([255, 254, 0]);
        expect(await (await app.request('/error')).text()).toBe('unavailable');
        // An unscanned path reaches the downstream handler before body completion.
        let finish: (() => void) | undefined;
        const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('body')); finish = () => controller.close(); } });
        const pending = app.request('/stream', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
        await vi.waitFor(() => expect(entered).toBe(true));
        finish!();
        expect(await (await pending).text()).toBe('body');
        await guard.close();
        expect(await (await app.request('/binary')).arrayBuffer()).toHaveProperty('byteLength', 3);
    } finally { await guard.close(); }
});

it('built Hono ESM/CJS subpaths preserve custom scan caps and lure config from root guards', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    for (const format of ['esm', 'cjs']) {
        const root = (format === 'esm' ? await import('../../dist/index.js') : require('../../dist/index.cjs')) as typeof import('../../src/index.js');
        const adapter = (format === 'esm' ? await import('../../dist/hono.js') : require('../../dist/hono.cjs')) as typeof import('../../src/adapters/hono.js');
        const events: AgentGuardEvent[] = [];
        const guard = root.createAgentGuard(config({ limits: { maxBodyBytes: 0 }, onEvent: event => events.push(event), lures: { robots: 'append' } }));
        const app = new Hono();
        app.use('*', adapter.agentGuard(guard));
        app.get('/robots.txt', c => c.text('User-agent: *\n'));
        app.post('/login', async c => c.text(await c.req.text()));
        try {
            expect(await (await app.request('/robots.txt')).text()).toContain('Disallow: /.env');
            const token = generateCanary({ secret: 'local-demo-secret-never-use-in-production' }).token;
            expect(await (await app.request('/login', { method: 'POST', body: token })).text()).toBe(token);
            expect(events.some(event => event.event === 'canary_replay')).toBe(false);
        } finally { await guard.close(); }
    }
});
