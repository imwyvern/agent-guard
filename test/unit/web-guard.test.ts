import { afterEach, expect, it, vi } from 'vitest';
import type { AGRequest, AgentGuardEvent } from '../../src/types.js';
import { createWebGuard, memoryStore } from '../../src/web/index.js';
import type { WebGuard, WebGuardConfig } from '../../src/web/index.js';
import { webCrypto } from '../../src/crypto/web.js';
import { nodeCrypto } from '../../src/crypto/node.js';
import { mazeRoot, encodeMazeNode, mazeMac } from '../../src/core/maze-nodes.js';

const guards: WebGuard[] = [];
function config(overrides: Partial<WebGuardConfig> = {}): WebGuardConfig {
    return { project: 'web-test', env: 'test', projectSeed: 'fixture seed', canary: { secret: 'fixture secret', registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } }, store: memoryStore(), ...overrides };
}
function guard(overrides: Partial<WebGuardConfig> = {}): WebGuard { const g = createWebGuard(config(overrides)); guards.push(g); return g; }
function req(path = '/', headers: AGRequest['headers'] = {}, ip = '192.0.2.1'): AGRequest { return { method: 'GET', path, headers, ip, query: {} }; }
function token(body: string): string { return body.match(/AG-CANARY-[0-9A-HJKMNP-TV-Z]{12}-[0-9A-HJKMNP-TV-Z]{6}/)![0]; }
async function bait(g: WebGuard): Promise<string> { return token(await (await g.handle(new Request('https://host.invalid/.env')))!.text()); }
afterEach(async () => { for (const g of guards.splice(0)) await g.close(); });

it('passes ordinary Requests without HMAC, body consumption or implicit forwarded IP trust', async () => {
    const events: AgentGuardEvent[] = [], g = guard({ onEvent: e => events.push(e) }), hmac = vi.spyOn(webCrypto, 'hmacSha256'), hash = vi.spyOn(webCrypto, 'sha256');
    const request = new Request('https://host.invalid/', { method: 'POST', body: 'untouched', headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(await g.handle(request)).toBeNull(); expect(request.bodyUsed).toBe(false);
    expect(await g.handle(new Request('https://host.invalid/'))).toBeNull();
    expect(hmac).not.toHaveBeenCalled(); expect(hash).toHaveBeenCalledTimes(1);
    await g.handle(new Request('https://host.invalid/.env', { headers: { 'x-forwarded-for': '1.2.3.4' } }));
    expect(events.find(e => e.event === 'decoy_hit')?.req.ip).toBe('unknown');
});
it('serves inert decoys with noindex/no-store, returns HEAD without a body and detects later replay', async () => {
    const g = guard(), response = await g.handle(new Request('https://host.invalid/.env'));
    expect(response).toBeInstanceOf(Response); expect(response!.status).toBe(200);
    expect(response!.headers.get('x-robots-tag')).toContain('noindex'); expect(response!.headers.get('cache-control')).toBe('no-store');
    const canary = token(await response!.text());
    const decision = await g.inspect(req('/api/real', { authorization: canary }));
    expect(decision.events.find(e => e.event === 'canary_replay')?.canary?.found_in).toBe('header');
    const head = await g.handle(new Request('https://host.invalid/.env', { method: 'HEAD' }));
    expect(head!.status).toBe(200); expect(head!.body).toBeNull();
});
it('verifies unregistered modern tokens across guard instances and supports legacy registry candidates', async () => {
    const canary = await bait(guard()), second = guard();
    expect((await second.inspect(req('/', { authorization: canary }))).events.some(e => e.event === 'canary_replay')).toBe(true);
    const g = guard({ canary: { secret: 'fixture secret', registry: { version: 1, prefix: 'AG-CANARY-', canaries: [{ id: 'legacy', token: 'legacy-inert-value', placement: 'legacy', env: 'test', createdAt: '2026-01-01' }] } } });
    expect((await g.inspect(req('/', { authorization: 'legacy-inert-value' }))).events[0]?.canary?.id).toBe('legacy');
});
it('bypasses claimed crawlers by default, with no replay escalation, bait, block, maze or delay', async () => {
    const g = guard({ mode: 'trap', trap: { delay: { enabled: true, ms: 3000 }, block: { enabled: true }, maze: { enabled: true } } });
    const canary = await bait(g), hmac = vi.spyOn(webCrypto, 'hmacSha256');
    const decision = await g.inspect(req('/.env', { 'user-agent': 'Googlebot', authorization: canary }));
    expect(decision).toMatchObject({ action: 'respond', response: { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not Found\n' } });
    expect(decision.events).toHaveLength(1); expect(decision.events[0]).toMatchObject({ event: 'crawler_bypass', severity: 'debug', crawler: { verified: false }, signals: [] });
    expect(hmac).not.toHaveBeenCalled();
    const maze = await g.inspect(req('/api/internal/archive/invalid', { 'user-agent': 'Googlebot' }));
    expect(maze.action === 'respond' && maze.response.status).toBe(404);
    expect((await g.inspect(req('/', { 'user-agent': 'Googlebot' }))).action).toBe('pass');
});
it.each([true, false])('uses a custom verifier result (%s) without DNS', async verified => {
    const customVerify = vi.fn(async () => verified), g = guard({ crawler: { verify: 'custom', customVerify } });
    const decision = await g.inspect(req('/.env', { 'user-agent': 'Googlebot' }));
    expect(customVerify).toHaveBeenCalledWith('192.0.2.1', 'Googlebot');
    expect(decision.action === 'respond' && decision.response.status).toBe(verified ? 404 : 200);
    expect(decision.events[0]).toMatchObject(verified ? { event: 'crawler_bypass', severity: 'debug', crawler: { verified: true } } : { event: 'decoy_hit', crawler: { verified: false }, req: { ua_class: 'spoofed_crawler' } });
});
it.each([undefined, false])('custom verification fails open unless explicitly disabled (%s)', async failOpen => {
    for (const customVerify of [async () => { throw new Error('offline'); }, () => new Promise<boolean>(() => {})]) {
        const g = guard({ crawler: { verify: 'custom', customVerify, timeoutMs: 1, failOpen } });
        const d = await g.inspect(req('/.env', { 'user-agent': 'Googlebot' }));
        expect(d.action === 'respond' && d.response.status).toBe(failOpen === false ? 200 : 404);
    }
});
it('disables state features with exactly one warning per guard when no store is supplied', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), g = guard({ store: undefined, mode: 'trap', trap: { block: { enabled: true }, rateLimit: { enabled: true, capacity: 1, refillPerSec: 0 }, gate: { minScore: 0 } } });
    const canary = await bait(g);
    for (let i = 0; i < 25; i++) {
        const d = await g.inspect(req('/.env', { authorization: canary }));
        expect(d.action === 'respond' && d.response.status).toBe(200);
        expect(d.events.every(e => !e.incident && e.automation_score === undefined)).toBe(true);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/incident.*rateLimit.*block.*timing.*StateStore/);
    expect(g.prometheusText()).toContain('agent_guard_timing_state_size 0');
});
it('persists blocks and honors the kill switch with an async StateStore', async () => {
    const backing = memoryStore(), store = { get: async <T>(k: string) => backing.get<T>(k), set: async <T>(k: string, v: T, ttl: number) => { await backing.set(k, v, ttl); }, delete: async (k: string) => { await backing.delete(k); } };
    const g = guard({ store, mode: 'trap', trap: { block: { enabled: true } } }), canary = await bait(g);
    const replay = await g.inspect(req('/', { authorization: canary }));
    expect(replay.events.some(e => e.event === 'canary_replay' && e.incident?.confidence === 'high')).toBe(true);
    expect(replay.action === 'respond' && replay.response.status).toBe(403);
    expect((await g.inspect(req('/'))).action).toBe('respond');
    g.setTrapEnabled(false); expect((await g.inspect(req('/'))).action).toBe('pass');
    g.setTrapEnabled(true); expect((await g.inspect(req('/'))).action).toBe('respond');
    expect(g.prometheusText()).toContain('agent_guard_trap_blocked 1');
});
it('enforces block TTL and maxKeys without retaining stale client blocks', async () => {
    const g = guard({ mode: 'trap', trap: { block: { enabled: true, ttlMs: 10, maxKeys: 1 } } }), canary = await bait(g);
    expect((await g.inspect(req('/', { authorization: canary }, '192.0.2.1'))).action).toBe('respond');
    expect((await g.inspect(req('/', { authorization: canary }, '198.51.100.1'))).action).toBe('respond');
    expect((await g.inspect(req('/', {}, '192.0.2.1'))).action).toBe('pass');
    vi.useFakeTimers(); vi.advanceTimersByTime(11);
    expect((await g.inspect(req('/', {}, '198.51.100.1'))).action).toBe('pass');
});
it('applies rate limiting only after the existing multi-hit gate', async () => {
    const g = guard({ mode: 'trap', trap: { rateLimit: { enabled: true, capacity: 1, refillPerSec: 0 }, gate: { minScore: 0 } } });
    for (const expected of [200, 200, 429]) {
        const d = await g.inspect(req('/.env')); expect(d.action === 'respond' && d.response.status).toBe(expected);
    }
    g.setTrapEnabled(false); const d = await g.inspect(req('/.env')); expect(d.action === 'respond' && d.response.status).toBe(200);
});
it('expires rate buckets after 30 minutes even when ordinary traffic keeps client state active', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const g = guard({ mode: 'trap', trap: { rateLimit: { enabled: true, capacity: 1, refillPerSec: 0 }, gate: { minScore: 0 } } });
    await g.inspect(req('/.env')); await g.inspect(req('/.env'));
    const limited = await g.inspect(req('/.env')); expect(limited.action === 'respond' && limited.response.status).toBe(429);
    const start = Date.now();
    vi.setSystemTime(start + 29 * 60_000); await g.inspect(req('/ordinary'));
    vi.setSystemTime(start + 31 * 60_000);
    const renewed = await g.inspect(req('/.env')); expect(renewed.action === 'respond' && renewed.response.status).toBe(200);
});
it('serializes concurrent requests so a store-backed rate bucket cannot overspend', async () => {
    const g = guard({ mode: 'trap', trap: { rateLimit: { enabled: true, capacity: 2, refillPerSec: 0 }, gate: { minScore: 0 } } });
    await g.inspect(req('/.env'));
    const decisions = await Promise.all(Array.from({ length: 10 }, () => g.inspect(req('/.env'))));
    expect(decisions.filter(d => d.action === 'respond' && d.response.status === 200)).toHaveLength(2);
    expect(decisions.filter(d => d.action === 'respond' && d.response.status === 429)).toHaveLength(8);
});
it('retains ordered incident features and timing scores only with a store', async () => {
    const g = guard();
    await g.inspect(req('/robots.txt')); const d = await g.inspect(req('/.env'));
    expect(d.events[0]?.incident).toMatchObject({ sequence: ['robots', 'D1'], confidence: 'medium' });
    for (let i = 0; i < 20; i++) await g.inspect(req('/'));
    expect((await g.inspect(req('/.env'))).events[0]?.automation_score).toEqual(expect.any(Number));
});
it('bounds body scanning to configured paths and bytes and leaves host body readable', async () => {
    const g = guard({ limits: { maxBodyBytes: 80 } }), canary = await bait(g);
    const request = new Request('https://host.invalid/login', { method: 'POST', body: canary + 'x'.repeat(500) });
    expect((await g.inspect(request)).events[0]?.canary?.found_in).toBe('body');
    expect(request.bodyUsed).toBe(false); expect((await request.text()).length).toBeGreaterThan(500);
    const outside = new Request('https://host.invalid/login', { method: 'POST', body: 'x'.repeat(90) + canary });
    expect((await g.inspect(outside)).events).toEqual([]);
    const ordinary = new Request('https://host.invalid/ordinary', { method: 'POST', body: canary });
    expect((await g.inspect(ordinary)).events).toEqual([]); expect(ordinary.bodyUsed).toBe(false);
});
it('scans query keys and headers, bounds candidate work, and never authenticates truncated credentials', async () => {
    const g = guard(), canary = await bait(g);
    const d = await g.inspect(new Request('https://host.invalid/?token=' + canary + '&token=other'));
    expect(d.events[0]).toMatchObject({ event: 'canary_replay', req: { path: '/', query_keys: ['token'] }, canary: { found_in: 'query', field: 'token' } });
    const bounded = guard({ limits: { maxCanaryCandidates: 0 }, allowlist: { headerToken: { name: 'x-test', value: 'allow' } } });
    expect((await bounded.inspect(req('/', { authorization: canary }))).events).toEqual([]);
    expect((await bounded.inspect(req('/.env', { 'x-test': 'allow' }))).action).toBe('pass');
});
it('uses only the configured IP header or explicit clientIp callback', async () => {
    const g = guard({ ipHeader: 'CF-Connecting-IP' });
    const d = await g.inspect(new Request('https://host.invalid/.env', { headers: { 'cf-connecting-ip': '192.0.2.3', 'x-forwarded-for': '1.2.3.4' } }));
    expect(d.events[0]?.req.ip).toBe('192.0.2.3');
    const custom = guard({ ipHeader: 'x-real-ip', clientIp: () => '198.51.100.7' });
    expect((await custom.inspect(new Request('https://host.invalid/.env'))).events[0]?.req.ip).toBe('198.51.100.7');
});
it('authenticates maze nodes but refuses admission and omits links without a store', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = guard({ store: undefined, mode: 'trap', trap: { maze: { enabled: true }, gate: { minScore: 0 } } });
    const canary = await bait(g), node = encodeMazeNode(mazeRoot, 0, 0, mazeMac(mazeRoot, 0, 0, 'fixture secret', nodeCrypto));
    const d = await g.inspect(req('/api/internal/archive/' + node, { authorization: canary }));
    expect(d.action === 'respond' && d.response.status).toBe(404);
    const env = await g.inspect(req('/.env', { authorization: canary }));
    expect(env.action === 'respond' && env.response.body).not.toContain('ARCHIVE_INDEX');
    const tampered = node.slice(0, -1) + (node.endsWith('0') ? '1' : '0');
    const invalid = await g.inspect(req('/api/internal/archive/' + tampered, { authorization: canary }));
    expect(invalid.action === 'respond' && invalid.response.status).toBe(404);
});
it('serves bounded maze sessions only after confirmation and spends the page budget', async () => {
    const g = guard({ mode: 'trap', trap: { maze: { enabled: true, maxPages: 1 }, gate: { minScore: 0 } } });
    const canary = await bait(g), env = await g.inspect(req('/.env', { authorization: canary }));
    const entry = env.action === 'respond' && env.response.body.match(/ARCHIVE_INDEX=(\S+)/)?.[1]; expect(entry).toBeTruthy();
    const first = await g.inspect(req(String(entry)));
    expect(first.action === 'respond' && first.response.status).toBe(200);
    if (first.action === 'respond') { expect(first.response.headers['Cache-Control']).toBe('no-store'); expect(first.response.body).not.toMatch(/https?:|cookie/i); }
    const second = await g.inspect(req(String(entry)));
    expect(second.action === 'respond' && second.response.status).toBe(404); expect(second.events.some(e => e.event === 'exhaust_budget_spent')).toBe(true);
});
it.each([undefined, false, true])('Web trap delay requires explicit enablement and caps at 3000 ms (%s)', async enabled => {
    vi.spyOn(webCrypto, 'hmacSha256').mockImplementation(async (secret, data) => nodeCrypto.hmacSha256(secret, data));
    vi.spyOn(webCrypto, 'sha256').mockImplementation(async data => nodeCrypto.sha256(data));
    vi.useFakeTimers();
    const g = guard({ mode: 'trap', trap: { delay: { enabled, ms: 10_000 }, gate: { minScore: 0 } } });
    const canary = await bait(g);
    let resolved = false;
    const pending = g.inspect(req('/.env', { authorization: canary })).then(d => { resolved = true; return d; });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(enabled !== true);
    if (enabled === true) { await vi.advanceTimersByTimeAsync(2999); expect(resolved).toBe(false); await vi.advanceTimersByTimeAsync(1); }
    expect((await pending).action).toBe('respond');
});
it('releases a pending trap delay when disabled or closed', async () => {
    vi.spyOn(webCrypto, 'hmacSha256').mockImplementation(async (secret, data) => nodeCrypto.hmacSha256(secret, data));
    vi.spyOn(webCrypto, 'sha256').mockImplementation(async data => nodeCrypto.sha256(data));
    vi.useFakeTimers();
    const g = guard({ mode: 'trap', trap: { delay: { enabled: true, ms: 3000 } } }), canary = await bait(g);
    const pending = g.inspect(req('/.env', { authorization: canary })); await vi.advanceTimersByTimeAsync(0);
    g.setTrapEnabled(false); expect((await pending).action).toBe('respond');
    expect(g.prometheusText()).toContain('agent_guard_trap_delayed 0');
});
it('validates Web config and rejects Node-only resources at create time', () => {
    expect(() => createWebGuard(config({ canary: { secret: 'fixture', registry: '/tmp/registry.json' } }))).toThrow(/registry.*object/);
    expect(() => createWebGuard(config({ crawler: { ipRangesFile: '/tmp/ranges.json' } }))).toThrow(/Node-only/);
    expect(() => createWebGuard(config({ alerts: { adapters: [{ name: 'smtp', send: async () => ({ ok: true }) }] } }))).toThrow(/SMTP.*webhook/);
    expect(() => createWebGuard(config({ crawler: { verify: 'custom' } }))).toThrow(/customVerify/);
    expect(() => createWebGuard(config({ crawler: { verify: 'dns' } }))).toThrow(/DNS.*Node-only/);
    expect(() => createWebGuard(config({ project: '' }))).toThrow(/project/);
    expect(() => createWebGuard(config({ ipHeader: 'bad header' }))).toThrow(/ipHeader/);
});
it('isolates log/observer exceptions, redacts local IPs, and rejects inspection after close', async () => {
    const events: AgentGuardEvent[] = [], g = guard({ log: { keepIp: false, sink: () => { throw new Error('sink'); } }, onEvent: e => { events.push(e); throw new Error('observer'); } });
    expect((await g.inspect(req('/.env'))).action).toBe('respond'); expect(events[0]?.req.ip).toBeUndefined();
    expect(g.prometheusText()).toContain('agent_guard_requests_inspected_total 1');
    await g.close(); await expect(g.inspect(req('/'))).rejects.toThrow(/closed/);
});
