import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AGRequest, AgentGuardEvent } from '../../src/types.js';
import { createWebGuard, memoryStore, webhookAdapter } from '../../src/web/index.js';
import type { WebGuard, WebGuardConfig } from '../../src/web/index.js';
import { fromEnv, withAgentGuard } from '../../src/adapters/workers.js';
import { agentGuardMiddleware } from '../../src/adapters/next.js';
import { denoHandler } from '../../src/adapters/deno.js';
import { bunHandler } from '../../src/adapters/bun.js';
import { honoWeb } from '../../src/adapters/hono-web.js';
import type { HonoWebContext } from '../../src/adapters/hono-web.js';

const guards: WebGuard[] = [];
function guard(overrides: Partial<WebGuardConfig> = {}): WebGuard {
    const g = createWebGuard({ project: 'adapters', env: 'test', projectSeed: 'fixture seed', store: memoryStore(),
        canary: { secret: 'fixture secret', registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } }, ...overrides });
    guards.push(g); return g;
}
function request(path = '/', headers?: HeadersInit): Request { return new Request('https://host.invalid' + path, { headers }); }
function decoy(response: Response): void {
    expect(response.status).toBe(200);
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(response.headers.get('cache-control')).toBe('no-store');
}
afterEach(async () => { for (const g of guards.splice(0)) await g.close(); });

describe('Workers', () => {
    it('delegates the original request, env, context and host response without reading the body', async () => {
        const req = new Request('https://host.invalid/ordinary', { method: 'POST', body: 'host body' });
        const env = { binding: 'value' }, ctx = { waitUntil: vi.fn() }, response = new Response('host response', { status: 202 });
        const handler = { fetch: vi.fn((_r: Request, _e: typeof env, _c: typeof ctx) => response), scheduled: vi.fn() };
        const wrapped = withAgentGuard(guard(), handler);
        expect(await wrapped.fetch(req, env, ctx)).toBe(response);
        expect(handler.fetch).toHaveBeenCalledExactlyOnceWith(req, env, ctx);
        expect(req.bodyUsed).toBe(false); expect(await req.text()).toBe('host body');
        expect(wrapped.scheduled).toBe(handler.scheduled);
    });
    it('intercepts a decoy and never calls the inner fetch', async () => {
        const inner = { fetch: vi.fn(() => new Response('host')) };
        decoy(await withAgentGuard(guard(), inner).fetch(request('/.env'), {}, { waitUntil: vi.fn() }));
        expect(inner.fetch).not.toHaveBeenCalled();
    });
    it('passes the context through and flushes alerts with waitUntil using a mocked fetch', async () => {
        const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
        const g = guard({ alerts: { adapters: [webhookAdapter({ url: 'https://alerts.invalid/hook', secret: 'fixture signing key' })] } });
        const handle = vi.spyOn(g, 'handle'), pending: Promise<unknown>[] = [];
        const ctx = { waitUntil: vi.fn((p: Promise<unknown>) => { pending.push(p); }) };
        decoy(await withAgentGuard(g, { fetch: () => new Response('host') }).fetch(request('/.env'), {}, ctx));
        expect(handle.mock.calls[0]?.[1]).toBe(ctx);
        expect(ctx.waitUntil).toHaveBeenCalledTimes(1); expect(pending[0]).toBeInstanceOf(Promise);
        await Promise.all(pending);
        expect(send).toHaveBeenCalledTimes(1);
        expect(g.prometheusText()).toContain('agent_guard_alerts_sent_total 1');
    });
    it('fails open on guard errors and preserves host errors without retrying fetch', async () => {
        const g = guard(), response = new Response('host'), inner = { fetch: vi.fn(() => response) };
        vi.spyOn(g, 'handle').mockRejectedValue(new Error('inspection failed'));
        expect(await withAgentGuard(g, inner).fetch(request('/.env'), {}, {})).toBe(response);
        expect(inner.fetch).toHaveBeenCalledTimes(1);
        const hostError = new Error('host failed'), failing = { fetch: vi.fn(() => { throw hostError; }) };
        await expect(withAgentGuard(g, failing).fetch(request(), {}, {})).rejects.toBe(hostError);
        expect(failing.fetch).toHaveBeenCalledTimes(1);
    });
});

describe('Workers env', () => {
    const valid = { AG_CANARY_SECRET: 'fixture secret', AG_PROJECT_SEED: 'fixture seed' };
    it.each([undefined, '', '   ', null, 42, false, {}])('rejects a missing or invalid secret (%j)', secret => {
        expect(() => fromEnv({ ...valid, AG_CANARY_SECRET: secret })).toThrow(/AG_CANARY_SECRET.*non-empty string/);
    });
    it.each([undefined, '', 42])('requires an explicit project seed (%j)', seed => {
        expect(() => fromEnv({ ...valid, AG_PROJECT_SEED: seed })).toThrow(/AG_PROJECT_SEED/);
    });
    it('uses non-secret defaults, serves decoys and trusts only the platform IP header', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const g = fromEnv(valid); guards.push(g);
        decoy((await g.handle(request('/.env')))!);
        const decision = await g.inspect(request('/.env', { 'CF-Connecting-IP': '198.51.100.8', 'x-forwarded-for': '1.2.3.4' }));
        expect(decision.events[0]).toMatchObject({ event: 'decoy_hit', project: 'default', env: 'production', req: { ip: '198.51.100.8' } });
        expect((await g.inspect(request('/.env', { 'x-forwarded-for': '1.2.3.4' }))).events[0]?.req.ip).toBe('unknown');
    });
    it('honors project, env, mode and an explicitly configured forwarded IP header', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const g = fromEnv({ ...valid, AG_PROJECT: 'configured', AG_ENV: 'staging', AG_MODE: 'trap', AG_IP_HEADER: 'X-Forwarded-For' }); guards.push(g);
        const decision = await g.inspect(request('/.env', { 'CF-Connecting-IP': '192.0.2.1', 'x-forwarded-for': '1.2.3.4, 198.51.100.9' }));
        expect(decision.events[0]).toMatchObject({ project: 'configured', env: 'staging', req: { ip: '198.51.100.9' } });
    });
    it('rejects invalid modes without including binding values in errors', () => {
        expect(() => fromEnv({ ...valid, AG_MODE: 'unsupported' })).toThrow('AG_MODE must be detect or trap');
    });
});

describe('Next', () => {
    it('returns a standard Response on decoys and undefined for ordinary requests', async () => {
        const middleware = agentGuardMiddleware(guard());
        const response = await middleware(request('/.env'));
        expect(response).toBeInstanceOf(Response); decoy(response!);
        expect(await middleware(request('/ordinary'))).toBeUndefined();
    });
    it('passes the event to the guard as its execution context', async () => {
        const g = guard(), handle = vi.spyOn(g, 'handle'), event = { waitUntil: vi.fn() }, req = request('/.env');
        await agentGuardMiddleware(g)(req, event);
        expect(handle).toHaveBeenCalledExactlyOnceWith(req, event);
        expect(event.waitUntil).toHaveBeenCalledTimes(1);
    });
    it('fails open with undefined if inspection throws', async () => {
        const g = guard(); vi.spyOn(g, 'handle').mockImplementation(() => { throw new Error('inspection failed'); });
        expect(await agentGuardMiddleware(g)(request('/.env'))).toBeUndefined();
    });
});

describe.each(['deno', 'bun'] as const)('%s', runtime => {
    const info = { remoteAddr: { hostname: '198.51.100.11', port: 1234, transport: 'tcp' } };
    const server = { requestIP: vi.fn(() => ({ address: '198.51.100.11', family: 'IPv4', port: 1234 })) };
    function wrap(g: WebGuard, next: (req: Request, context?: unknown) => Response | Promise<Response>) {
        return runtime === 'deno' ? (req: Request) => denoHandler(g, next)(req, info) : (req: Request) => bunHandler(g, next)(req, server);
    }
    it('delegates the original request and runtime context and preserves the host response and body', async () => {
        const response = new Response('host response', { status: 201 }), next = vi.fn(() => response);
        const req = new Request('https://host.invalid/ordinary', { method: 'POST', body: 'untouched' });
        expect(await wrap(guard(), next)(req)).toBe(response);
        expect(next).toHaveBeenCalledExactlyOnceWith(req, runtime === 'deno' ? info : server);
        expect(req.bodyUsed).toBe(false); expect(await req.text()).toBe('untouched');
    });
    it('intercepts decoys, records the direct connection IP and ignores forwarded headers', async () => {
        const events: AgentGuardEvent[] = [], next = vi.fn(() => new Response('host'));
        const g = guard({ onEvent: e => events.push(e) }), req = request('/.env', { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.5' });
        decoy(await wrap(g, next)(req));
        expect(next).not.toHaveBeenCalled();
        expect(events[0]?.req.ip).toBe('198.51.100.11');
        if (runtime === 'bun') expect(server.requestIP).toHaveBeenCalledWith(req);
    });
    it.each([true, false])('keeps a configured IP header authoritative (present: %s)', async present => {
        const events: AgentGuardEvent[] = [], g = guard({ ipHeader: 'x-real-ip', onEvent: e => events.push(e) });
        await wrap(g, () => new Response())(request('/.env', present ? { 'x-real-ip': '192.0.2.9' } : {}));
        expect(events[0]?.req.ip).toBe(present ? '192.0.2.9' : 'unknown');
    });
    it('keeps an explicit clientIp callback authoritative', async () => {
        const events: AgentGuardEvent[] = [], g = guard({ clientIp: () => '192.0.2.17', onEvent: e => events.push(e) });
        await wrap(g, () => new Response())(request('/.env'));
        expect(events[0]?.req.ip).toBe('192.0.2.17');
    });
    it('allows an absent runtime context', async () => {
        const events: AgentGuardEvent[] = [], g = guard({ onEvent: e => events.push(e) }), next = vi.fn(() => new Response());
        decoy(await (runtime === 'deno' ? denoHandler(g, next)(request('/.env')) : bunHandler(g, next)(request('/.env'))));
        expect(events[0]?.req.ip).toBe('unknown'); expect(next).not.toHaveBeenCalled();
    });
    it('fails open on guard errors', async () => {
        const g = guard(), response = new Response('host'), next = vi.fn(() => response);
        vi.spyOn(g, 'handle').mockRejectedValue(new Error('inspection failed'));
        expect(await wrap(g, next)(request('/.env'))).toBe(response);
        expect(next).toHaveBeenCalledTimes(1);
    });
    it('preserves host errors without retrying the host', async () => {
        const error = new Error('host failed'), next = vi.fn(() => { throw error; });
        await expect(wrap(guard(), next)(request('/ordinary'))).rejects.toBe(error);
        expect(next).toHaveBeenCalledTimes(1);
    });
});

describe('Hono Web', () => {
    it('assigns the guard Response on a decoy and does not call next', async () => {
        const c: HonoWebContext = { req: { raw: request('/.env') }, res: new Response('host') }, next = vi.fn(async () => {});
        await honoWeb(guard())(c, next);
        decoy(c.res!); expect(next).not.toHaveBeenCalled();
    });
    it('calls next for an ordinary request and preserves the host response and request body', async () => {
        const req = new Request('https://host.invalid/ordinary', { method: 'POST', body: 'host body' }), response = new Response('host');
        const c = { req: { raw: req }, res: response }, next = vi.fn(async () => {});
        await honoWeb(guard())(c, next);
        expect(next).toHaveBeenCalledTimes(1); expect(c.res).toBe(response); expect(req.bodyUsed).toBe(false);
    });
    it('passes the execution context to the guard', async () => {
        const g = guard(), handle = vi.spyOn(g, 'handle'), ctx = { waitUntil: vi.fn() };
        const c = { req: { raw: request('/.env') }, res: new Response(), executionCtx: ctx };
        await honoWeb(g)(c, async () => {});
        expect(handle).toHaveBeenCalledExactlyOnceWith(c.req.raw, ctx);
        expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    });
    it('still inspects requests when the host execution context getter is unavailable', async () => {
        const c: HonoWebContext = { req: { raw: request('/.env') }, get executionCtx(): never { throw new Error('unavailable'); } };
        const next = vi.fn(async () => {});
        await honoWeb(guard())(c, next);
        decoy(c.res!); expect(next).not.toHaveBeenCalled();
    });
    it('fails open when the guard throws', async () => {
        const g = guard(), next = vi.fn(async () => {}), response = new Response('host');
        vi.spyOn(g, 'handle').mockRejectedValue(new Error('inspection failed'));
        const c = { req: { raw: request('/.env') }, res: response };
        await honoWeb(g)(c, next);
        expect(next).toHaveBeenCalledTimes(1); expect(c.res).toBe(response);
    });
    it('preserves errors from next without retrying it', async () => {
        const error = new Error('host failed'), next = vi.fn(async () => { throw error; });
        await expect(honoWeb(guard())({ req: { raw: request('/ordinary') }, res: new Response() }, next)).rejects.toBe(error);
        expect(next).toHaveBeenCalledTimes(1);
    });
});

describe('configured client IP', () => {
    it.each([
        ['x-forwarded-for', '1.2.3.4, 198.51.100.9', '198.51.100.9'],
        ['X-Forwarded-For', ' , 1.2.3.4, , 198.51.100.9, , ', '198.51.100.9'],
        ['x-forwarded-for', ' , , ', 'unknown'],
        ['x-forwarded-for', '', 'unknown'],
        ['x-real-ip', ' 198.51.100.9 ', '198.51.100.9'],
        ['CF-Connecting-IP', ' 198.51.100.9 ', '198.51.100.9'],
        ['x-real-ip', '1.2.3.4, 198.51.100.9', '1.2.3.4, 198.51.100.9'],
    ])('uses %s value %j as %s for both Web and structured requests', async (ipHeader, value, expected) => {
        const g = guard({ ipHeader }), headers = { [ipHeader.toLowerCase()]: value };
        const structured: AGRequest = { method: 'GET', path: '/.env', headers, query: {}, ip: '192.0.2.1' };
        for (const req of [request('/.env', headers), structured]) expect((await g.inspect(req)).events[0]?.req.ip).toBe(expected);
    });
    it('does not trust any forwarded header without explicit configuration', async () => {
        const g = guard();
        expect((await g.inspect(request('/.env', { 'x-forwarded-for': '1.2.3.4, 198.51.100.9', 'x-real-ip': '1.2.3.5', 'cf-connecting-ip': '1.2.3.6' }))).events[0]?.req.ip).toBe('unknown');
    });
});
