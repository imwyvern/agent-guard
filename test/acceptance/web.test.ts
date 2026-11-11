import { afterEach, expect, it, vi } from 'vitest';
import { createWebGuard, memoryStore, webhookAdapter, type WebGuard, type WebGuardConfig } from '../../src/web/index.js';
import type { AgentGuardEvent, AlertPayload } from '../../src/types.js';
import { AgentGuardConfigError } from '../../src/config.js';
import { webCrypto } from '../../src/crypto/web.js';
import { browserUA, realPaths, siteResponse } from '../../examples/shared/site.js';
import { decoyPaths, receiver, request } from '../helpers.js';
import { response, tokenFrom } from '../helpers/trap.js';
import { entryFrom, mazeLinks } from '../helpers/maze.js';
import { fixedRegistry, fixedToken, mazeEntry, quietCircuit, replayToken, secret, webConfig } from '../helpers/web.js';

const guards: WebGuard[] = [];
function setup(options: Partial<WebGuardConfig> = {}) {
    const events: AgentGuardEvent[] = [], alerts: AlertPayload[] = [];
    const guard = createWebGuard(webConfig({ store: memoryStore(), onEvent: e => events.push(e), alerts: { adapters: [{ name: 'capture', send: async a => { alerts.push(a); return { ok: true }; } }] }, ...options }));
    guards.push(guard);
    const handle = (path: string, init: RequestInit = {}) => guard.handle(new Request('http://127.0.0.1' + path, { headers: { 'user-agent': browserUA }, ...init }));
    return { guard, events, alerts, handle };
}
const mazeOptions = { mode: 'trap' as const, trap: { maze: { enabled: true, maxPages: 3 }, circuit: quietCircuit } };
async function confirm(guard: WebGuard, ua = 'curl/8.0') {
    const req = (path: string) => request(path, { headers: { 'user-agent': ua } });
    const token = tokenFrom(response(await guard.inspect(req('/.env'))).body);
    await guard.inspect(request('/', { headers: { 'user-agent': ua, authorization: token } }));
    return entryFrom(response(await guard.inspect(req('/.env'))).body);
}
function safePage(r: { headers: Headers; body: string }) {
    expect(r.headers.get('x-robots-tag')).toContain('noindex'); expect(r.headers.get('x-robots-tag')).toContain('nofollow');
    expect(r.headers.get('cache-control')).toBe('no-store'); expect(r.headers.has('set-cookie')).toBe(false);
    expect(Buffer.byteLength(r.body)).toBeLessThanOrEqual(8192); expect(r.body).not.toMatch(/https?:\/\//i);
}
afterEach(async () => { for (const g of guards.splice(0)) await g.close(); });

it('AC-1: sixty human requests pass to host unchanged with no alerts', async () => {
    const { guard, events, alerts, handle } = setup();
    for (let i = 0; i < 60; i++) {
        const path = [...realPaths, '/logout', '/static/site.css', '/robots.txt', '/sitemap.xml'][i % 9]!;
        const init = i % 9 === 3 ? { method: 'POST', body: JSON.stringify({ password: i % 2 ? 'wrong' : 'demo-password' }) } : {};
        expect(await handle(path, init)).toBeNull();
        const host = siteResponse(path, init.method ?? 'GET');
        expect(await handle(path, init) ?? host).toEqual(host);
    }
    await guard.close(); expect(events).toEqual([]); expect(alerts).toEqual([]);
});
it('AC-2: delivered D1 and D3 secrets replay critically with provenance and signed loopback alerts', async () => {
    const hook = await receiver();
    try {
        const { guard, handle, events } = setup({ alerts: { adapters: [webhookAdapter({ url: hook.url, secret: 'webhook-test-secret' })] } });
        const token = tokenFrom(await (await handle('/.env'))!.text());
        const password = /<dt>Password<\/dt><dd>([^<]+)/.exec(await (await handle('/internal/ops-notes'))!.text())![1]!;
        const start = performance.now();
        expect(await handle('/list', { headers: { authorization: token } })).toBeNull();
        expect(await handle('/login', { method: 'POST', body: JSON.stringify({ password }) })).toBeNull();
        await guard.close();
        const replays = events.filter(e => e.event === 'canary_replay'); expect(replays).toHaveLength(2);
        expect(replays[0]).toMatchObject({ severity: 'critical', canary: { placement: 'D1:/.env#ADMIN_API_TOKEN', found_in: 'header', field: 'authorization' } });
        expect(replays[1]).toMatchObject({ severity: 'critical', canary: { placement: 'D3:/internal/ops-notes#password', found_in: 'body' } });
        expect(hook.deliveries.every(d => d.valid)).toBe(true);
        expect(hook.deliveries.find(d => d.payload.event.event === 'canary_replay')!.time - start).toBeLessThan(1000);
    } finally { await hook.close(); }
});
it('AC-3: custom prefix query/header/JSON/form replay; tamper rejected', async () => {
    const prefix = 'ACME-CANARY-', token = fixedToken('0123456789AB', prefix);
    const { guard, events, handle } = setup({ canary: { secret, prefix, registry: fixedRegistry(prefix) } });
    for (const [path, init] of [
        ['/?key=' + token, {}], ['/', { headers: { 'x-custom': token } }],
        ['/login', { method: 'POST', body: JSON.stringify({ deep: { value: token } }) }],
        ['/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + token }],
    ] as [string, RequestInit][]) expect(await handle(path, init)).toBeNull();
    expect(events.filter(e => e.event === 'canary_replay').map(e => e.canary?.found_in)).toEqual(['query', 'header', 'body', 'body']);
    await handle('/?key=' + token.slice(0, -1) + 'X'); await guard.close();
    expect(events.filter(e => e.event === 'canary_replay')).toHaveLength(4);
});
it('AC-4: custom verified Googlebot receives Web 404 on every decoy without alert delivery', async () => {
    const { guard, alerts, handle } = setup({ crawler: { verify: 'custom', customVerify: async () => true } });
    for (const path of decoyPaths) {
        const r = (await handle(path, { headers: { 'user-agent': 'Googlebot' } }))!;
        expect(r.status).toBe(404); expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8'); expect(await r.text()).toBe('Not Found\n');
    }
    await guard.close(); expect(alerts).toEqual([]);
});
it('AC-5: custom rejected crawler reaches decoy and emits spoof signal', async () => {
    const { guard, alerts } = setup({ crawler: { verify: 'custom', customVerify: async () => false } });
    const d = await guard.inspect(request('/.env', { headers: { 'user-agent': 'Googlebot' } }));
    expect(response(d).status).toBe(200); expect(d.events[0]?.signals).toContain('ua_spoof_crawler');
    await guard.close(); expect(alerts).toHaveLength(1);
});
it.skip('AC-6: hung DNS resolver is Node-only; Web rejects DNS configuration', () => {});
it('AC-6 Web equivalent: hanging custom verifier times out and bypasses safely', async () => {
    const { guard } = setup({ crawler: { verify: 'custom', customVerify: () => new Promise(() => {}), timeoutMs: 10 } });
    expect(response(await guard.inspect(request('/.env', { headers: { 'user-agent': 'Googlebot' } }))).status).toBe(404);
});
it('AC-7: all decoys are safe, bounded, cookie-free; HEAD preserves headers and empties body', async () => {
    const { handle } = setup();
    for (const path of decoyPaths) {
        const r = (await handle(path))!, body = await r.text(); safePage({ headers: r.headers, body });
        if (path === '/internal/ops-notes') expect(body).toContain('<meta name="robots" content="noindex,nofollow,noarchive">');
        const head = (await handle(path, { method: 'HEAD' }))!;
        expect(head.status).toBe(r.status); expect([...head.headers]).toEqual([...r.headers]); expect(await head.text()).toBe('');
    }
});
it.skip('AC-8 robots append: Web has no host response lure transformer', () => {});
it('AC-8 host robots and sitemap pass through unchanged', async () => {
    const { handle } = setup(); expect(await handle('/robots.txt')).toBeNull(); expect(await handle('/sitemap.xml')).toBeNull();
});
it('AC-9: real pages pass for browsers and accepted/rejected claimed crawlers', async () => {
    for (const verified of [true, false]) {
        const { handle, guard, alerts } = setup({ crawler: { verify: 'custom', customVerify: async () => verified } });
        for (const ua of [browserUA, 'Googlebot']) for (const path of realPaths) expect(await handle(path, { headers: { 'user-agent': ua } })).toBeNull();
        await guard.close(); expect(alerts).toEqual([]);
    }
});
it('AC-10: ordinary Web inspection consumes no body or HMAC; latency gates run in bench:latency:web', async () => {
    const { guard } = setup(), hmac = vi.spyOn(webCrypto, 'hmacSha256');
    const r = new Request('http://127.0.0.1/', { method: 'POST', body: replayToken });
    for (let i = 0; i < 100; i++) expect(await guard.handle(r)).toBeNull();
    expect(r.bodyUsed).toBe(false); expect(hmac).not.toHaveBeenCalled();
});
it('AC-11: Web inspection makes no outbound or DNS probes', async () => {
    const { guard } = setup();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('outbound forbidden'); });
    await guard.inspect(request('/')); await guard.inspect(request('/.env')); await guard.inspect(request('/.env', { headers: { 'user-agent': 'Googlebot' } }));
    expect(fetch).not.toHaveBeenCalled();
});
it('AC-12: invalid mode throws AgentGuardConfigError', () => {
    expect(() => createWebGuard(webConfig({ mode: 'invalid' as 'detect' }))).toThrow(AgentGuardConfigError);
});
it('AC-13: hanging loopback webhook cannot block responses; ctx.waitUntil owns delivery', async () => {
    const hook = await receiver([200], true), pending: Promise<unknown>[] = [];
    try {
        const { guard } = setup({ alerts: { adapters: [webhookAdapter({ url: hook.url, secret: 'webhook-test-secret', timeoutMs: 20 })] } });
        let settled = false;
        const r = await guard.handle(new Request('http://127.0.0.1/.env'), { waitUntil: p => { pending.push(p); void p.then(() => { settled = true; }); } });
        expect(r!.status).toBe(200); expect(pending).toHaveLength(1); expect(settled).toBe(false);
        expect(await guard.handle(new Request('http://127.0.0.1/'))).toBeNull();
        hook.failPending(); await Promise.all(pending);
    } finally { await hook.close(); }
});
it('AC-14: one hundred identical hits deliver once; next alert reports 99 deduplications', async () => {
    const { guard, alerts } = setup();
    for (let i = 0; i < 100; i++) await guard.inspect(request('/.env'));
    await guard.inspect(request('/internal/ops-notes')); await guard.close();
    expect(alerts).toHaveLength(2); expect(alerts[1]?.summary.deduped).toBe(99);
});
it.skip('AC-15: CLI filesystem scan is Node-only and remains in the Node acceptance suite', () => {});
it('AC-16: detect and maze-disabled trap leave archive missing routes to the host', async () => {
    for (const options of [{}, { mode: 'trap' as const }]) {
        const { handle } = setup(options); expect(await handle('/api/internal/archive/anything')).toBeNull();
    }
});
it('AC-17: human traffic and single unconfirmed decoys never delay/rate-limit/block', async () => {
    const { guard, handle } = setup({ mode: 'trap', trap: { delay: { enabled: true, ms: 3000 }, rateLimit: { enabled: true, capacity: 1 }, block: { enabled: true }, circuit: quietCircuit } });
    for (const path of realPaths) expect(await handle(path, { headers: { 'user-agent': browserUA, referer: 'http://127.0.0.1/list' } })).toBeNull();
    expect((await handle('/.env'))!.status).toBe(200);
    expect(guard.prometheusText()).toContain('agent_guard_trap_delayed 0'); expect(guard.prometheusText()).toContain('agent_guard_trap_blocked 0');
});
it('AC-18: Googlebot/Bingbot ua-bypass never enter trap or maze even with a replay', async () => {
    const { guard } = setup({ ...mazeOptions, trap: { ...mazeOptions.trap, block: { enabled: true }, delay: { enabled: true, ms: 3000 } } });
    for (const ua of ['Googlebot', 'bingbot']) for (const path of ['/', ...decoyPaths, mazeEntry]) {
        const d = await guard.inspect(request(path, { headers: { 'user-agent': ua, authorization: replayToken } }));
        expect(d.events).toHaveLength(1); expect(d.events[0]).toMatchObject({ event: 'crawler_bypass', severity: 'debug', crawler: { verified: false } });
        if (path === '/') expect(d.action).toBe('pass'); else { expect(response(d).status).toBe(404); expect(response(d).body).toBe('Not Found\n'); }
    }
    expect(guard.prometheusText()).toContain('agent_guard_trap_maze_active 0');
});
it('AC-19: an unconfirmed env hit and valid maze entry consume no maze budget', async () => {
    const { guard } = setup(mazeOptions);
    expect(response(await guard.inspect(request('/.env'))).body).not.toContain('ARCHIVE_INDEX');
    expect(response(await guard.inspect(request(mazeEntry))).status).toBe(404);
    expect(guard.prometheusText()).toContain('agent_guard_trap_maze_active 0');
});
it('AC-20/23: replay opens a bounded safe walk; exhaustion emits once across retries', async () => {
    const { guard, events } = setup(mazeOptions); let path = await confirm(guard);
    for (let i = 0; i < 3; i++) {
        const page = response(await guard.inspect(request(path))); expect(page.status).toBe(200);
        safePage({ headers: new Headers(page.headers), body: page.body });
        const links = mazeLinks(page.body); expect(links).toHaveLength(10); expect(new Set(links).size).toBe(10); path = links[0]!;
    }
    for (let i = 0; i < 3; i++) expect(response(await guard.inspect(request(path))).status).toBe(404);
    expect(events.filter(e => e.event === 'exhaust_budget_spent')).toHaveLength(1);
});
it('AC-21: 100 confirmed clients respect a 20-session cap and keep host traffic passing', async () => {
    const { guard } = setup({ ...mazeOptions, alerts: { adapters: [] } });
    const clients = Array.from({ length: 100 }, (_, i) => 'web-walker-' + i);
    await Promise.all(clients.map(ua => guard.inspect(request('/', { headers: { 'user-agent': ua, authorization: replayToken } }))));
    const pages = await Promise.all(clients.map(ua => guard.inspect(request(mazeEntry, { headers: { 'user-agent': ua } }))));
    expect(pages.filter(d => response(d).status === 200)).toHaveLength(20); expect(pages.filter(d => response(d).status === 404)).toHaveLength(80);
    expect(guard.prometheusText()).toContain('agent_guard_trap_maze_active 20');
    expect(await guard.handle(new Request('http://127.0.0.1/'))).toBeNull();
});
it('AC-22: forged/truncated MACs are 404 and preserve the last valid page budget', async () => {
    const { guard, events } = setup({ ...mazeOptions, trap: { ...mazeOptions.trap, maze: { enabled: true, maxPages: 1 } } });
    const entry = await confirm(guard);
    for (const path of [entry.slice(0, -1) + 'X', entry.slice(0, -3), '/api/internal/archive/forged']) expect(response(await guard.inspect(request(path))).status).toBe(404);
    expect(events.some(e => e.event === 'exhaust_budget_spent')).toBe(false);
    expect(response(await guard.inspect(request(entry))).status).toBe(200);
});
it.each([
    { maxBytes: 1 }, { bytesPerMinute: 1 }, { maxDepth: 0 }, { maxDurationMs: 10 },
])('AC-23: maze respects additional resource bounds %j', async limits => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { guard, events } = setup({ ...mazeOptions, trap: { ...mazeOptions.trap, maze: { enabled: true, ...limits } } });
    const entry = await confirm(guard), first = response(await guard.inspect(request(entry)));
    let path = entry;
    if ('maxDepth' in limits) { expect(first.status).toBe(200); path = mazeLinks(first.body)[0]!; }
    if ('maxDurationMs' in limits) { expect(first.status).toBe(200); vi.setSystemTime(Date.now() + 11); }
    expect(response(await guard.inspect(request(path))).status).toBe(404);
    expect(events.filter(e => e.event === 'exhaust_budget_spent')).toHaveLength(1);
});
it('AC-24: inspect p99 circuit opens once and restores detection', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { guard, events } = setup({ mode: 'trap', trap: { block: { enabled: true }, circuit: { inspectP99Ns: 1 } } });
    await guard.inspect(request('/')); vi.setSystemTime(Date.now() + 251);
    for (let i = 0; i < 3; i++) expect(response(await guard.inspect(request('/.env'))).status).toBe(200);
    expect(events.filter(e => e.event === 'trap_circuit_open')).toHaveLength(1);
    expect(guard.prometheusText()).toContain('agent_guard_trap_enabled 0');
});
it('store-backed replay gates delay and rate limit while real pages still pass', async () => {
    const { guard } = setup({ mode: 'trap', trap: { delay: { enabled: true, ms: 20 }, rateLimit: { enabled: true, capacity: 1, refillPerSec: 0 }, circuit: quietCircuit } });
    await guard.inspect(request('/', { headers: { 'user-agent': 'curl/8.0', authorization: replayToken } }));
    const started = performance.now(); expect(response(await guard.inspect(request('/.env'))).status).toBe(200); expect(performance.now() - started).toBeGreaterThanOrEqual(18);
    const limited = response(await guard.inspect(request('/.env'))); expect(limited.status).toBe(429); expect(new Headers(limited.headers).get('cache-control')).toBe('no-store');
    expect((await guard.inspect(request('/'))).action).toBe('pass');
});
it('store-backed replay blocks only its client key and manual kill switch restores host pass', async () => {
    const { guard } = setup({ mode: 'trap', trap: { block: { enabled: true }, circuit: quietCircuit } });
    expect(response(await guard.inspect(request('/', { headers: { 'user-agent': 'curl/8.0', authorization: replayToken } }))).status).toBe(403);
    expect(response(await guard.inspect(request('/'))).status).toBe(403);
    expect((await guard.inspect(request('/', { headers: { 'user-agent': 'other' } }))).action).toBe('pass');
    guard.setTrapEnabled(false); expect((await guard.inspect(request('/'))).action).toBe('pass');
});
it('without store: one warning, no incident/timing/403/429/delay or maze admission', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { guard } = setup({ store: undefined, mode: 'trap', trap: { delay: { enabled: true, ms: 3000 }, maze: { enabled: true }, block: { enabled: true }, rateLimit: { enabled: true, capacity: 1, refillPerSec: 0 }, circuit: quietCircuit } });
    for (let i = 0; i < 25; i++) {
        const d = await guard.inspect(request('/.env', { headers: { authorization: replayToken } }));
        expect(response(d).status).toBe(200); expect(response(d).body).not.toContain('ARCHIVE_INDEX');
        for (const e of d.events) { expect(e.incident).toBeUndefined(); expect(e.automation_score).toBeUndefined(); }
    }
    expect(response(await guard.inspect(request(mazeEntry, { headers: { authorization: replayToken } }))).status).toBe(404);
    expect(warn).toHaveBeenCalledTimes(1); expect(warn.mock.calls[0]![0]).toContain('StateStore');
});
it('callback canaries are explicit, metadata-only, signed and cookie-free', async () => {
    const { guard, handle, events } = setup({ canary: { secret, registry: fixedRegistry(), callback: { baseUrl: 'http://127.0.0.1' } } });
    const body = await (await handle('/.env'))!.text(), callback = /^CALLBACK_URL=(.+)$/m.exec(body)![1]!, path = new URL(callback).pathname;
    for (const method of ['GET', 'HEAD']) {
        const r = (await handle(path, { method }))!; expect(r.status).toBe(204); expect(await r.text()).toBe('');
        expect(r.headers.get('cache-control')).toBe('no-store'); expect(r.headers.has('set-cookie')).toBe(false);
    }
    expect(events.filter(e => e.event === 'canary_callback')).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain(path.slice('/ag/cb/'.length));
    expect(await handle('/ag/cb/invalid')).toBeNull();
    await guard.close();
});
it('store-backed incident sequence and timing score survive repeated in-process inspection', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { guard } = setup();
    await guard.inspect(request('/robots.txt'));
    const decoy = await guard.inspect(request('/.env'));
    expect(decoy.events[0]?.incident).toMatchObject({ sequence: ['robots', 'D1'], confidence: 'medium' });
    for (let i = 0; i < 21; i++) { vi.setSystemTime(Date.now() + 100); await guard.inspect(request('/')); }
    const timed = await guard.inspect(request('/.env'));
    expect(timed.events[0]?.automation_score).toEqual(expect.any(Number));
    expect(timed.events[0]?.signals).toContain('robots_then_disallowed');
});
