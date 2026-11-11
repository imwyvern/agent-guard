import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { createAgentGuard, AgentGuardConfigError, type AgentGuardConfig, type AgentGuardEvent } from '../../src/index.js';
import { Trap } from '../../src/core/trap.js';
import { Registry } from '../../src/canary/registry.js';
import { Decoys } from '../../src/decoys/index.js';
import { fakeData } from '../../src/decoys/fake-data.js';
import { browserUA } from '../../examples/shared/site.js';
import { config, request, event, verifiedResolver } from '../helpers.js';
import { allTrap, confirm, response, trapConfig } from '../helpers/trap.js';

afterEach(() => vi.unstubAllEnvs());

it.each([
    { delay: { ms: -1 } }, { delay: { ms: 3001 } }, { delay: { ms: .5 } },
    { delay: { maxConcurrent: 0 } }, { delay: { maxConcurrent: 50001 } },
    { rateLimit: { capacity: 0 } }, { rateLimit: { capacity: Infinity } },
    { rateLimit: { refillPerSec: -1 } }, { rateLimit: { refillPerSec: .5 } },
    { block: { ttlMs: -1 } }, { block: { ttlMs: 0 } }, { block: { ttlMs: 86400001 } },
    { block: { maxKeys: 0 } }, { block: { maxKeys: 50001 } }, { block: { maxKeys: NaN } },
    { gate: { minScore: -1 } }, { gate: { minScore: .1 } },
    { circuit: { inspectP99Ns: -1 } }, { circuit: { eventLoopDelayMs: Infinity } },
    { circuit: { eventLoopDelayMs: .1 } },
    { delay: { enabled: 'true' } }, { block: { enabled: 1 } }, { maze: { enabled: null } },
    { delay: null }, { rateLimit: [] }, { gate: 'bad' }, null, [],
])('rejects invalid trap configuration %j', trap => {
    expect(() => createAgentGuard(config({ mode: 'trap', trap: trap as AgentGuardConfig['trap'] }))).toThrow(AgentGuardConfigError);
});

it('accepts boundary values while every enabled flag remains opt-in', async () => {
    const guard = createAgentGuard(config({ mode: 'trap', trap: {
        delay: { ms: 3000, maxConcurrent: 50000 }, rateLimit: { capacity: 1, refillPerSec: 0 },
        block: { ttlMs: 86400000, maxKeys: 50000 }, gate: { minScore: 0 },
        circuit: { inspectP99Ns: 0, eventLoopDelayMs: 0 }, maze: {},
    } }));
    try {
        await confirm(guard);
        expect(response(await guard.inspect(request('/.env'))).status).toBe(200);
        expect((await guard.inspect(request('/'))).action).toBe('pass');
        expect(guard.prometheusText()).toContain('agent_guard_trap_maze_active 0\n');
    } finally { await guard.close(); }
});

it.each([undefined, {}, { maze: { enabled: false } }, { maze: { enabled: true } }])('keeps trap mode with default-off features identical to detect (%j)', async trap => {
    const c = config(), registry = new Registry(c.canary.registry, c.canary.secret, 'AG-CANARY-');
    new Decoys(c, registry);
    const shared = { ...c, canary: { ...c.canary, registry: registry.data } };
    const detect = createAgentGuard(shared), disabled = createAgentGuard({ ...shared, mode: 'trap', trap });
    try {
        for (const input of [request('/'), request('/.env'), request('/api/internal/archive/anything')]) {
            const a = await detect.inspect(input), b = await disabled.inspect(input);
            expect(b.action).toBe(a.action);
            if (a.action === 'respond') expect(response(b)).toEqual(a.response);
            expect(b.events.map(e => e.event)).toEqual(a.events.map(e => e.event));
            expect(b.events.some(e => e.event.startsWith('trap_'))).toBe(false);
        }
    } finally { await detect.close(); await disabled.close(); }
});

it('never activates trap flags in detect mode, even after replay and manual enable', async () => {
    const guard = createAgentGuard(config({ trap: allTrap }));
    try {
        await confirm(guard);
        guard.setTrapEnabled(true);
        expect(response(await guard.inspect(request('/.env'))).status).toBe(200);
        expect((await guard.inspect(request('/'))).action).toBe('pass');
        expect(guard.prometheusText()).toContain('agent_guard_trap_enabled 0\n');
    } finally { await guard.close(); }
});

it.each(['', 'on', 'anything'])('environment value %j never overrides detect mode or the manual kill switch', async value => {
    vi.stubEnv('AGENT_GUARD_TRAP', value);
    const detect = createAgentGuard(config({ trap: allTrap })), trap = createAgentGuard(trapConfig());
    try {
        expect(detect.prometheusText()).toContain('agent_guard_trap_enabled 0\n');
        expect(trap.prometheusText()).toContain('agent_guard_trap_enabled 1\n');
        trap.setTrapEnabled(false);
        expect(trap.prometheusText()).toContain('agent_guard_trap_enabled 0\n');
    } finally { await detect.close(); await trap.close(); }
});

it('AC-17/19: a human and a single curl decoy hit stay unconfirmed and incur no extra timer', async () => {
    vi.useFakeTimers();
    const guard = createAgentGuard(trapConfig());
    try {
        const baseline = vi.getTimerCount();
        for (const pause of [850, 140, 2100, 370]) {
            vi.advanceTimersByTime(pause);
            expect((await guard.inspect(request('/', { headers: { 'user-agent': browserUA, referer: 'https://site.invalid/list' } }))).action).toBe('pass');
        }
        for (const headers of [{ 'user-agent': browserUA, referer: 'https://site.invalid/list' }, { 'user-agent': 'curl/8.0' }]) {
            const hit = await guard.inspect(request('/.env', { headers }));
            expect(response(hit).status).toBe(200);
            expect(hit.events.map(e => e.event)).toEqual(['decoy_hit']);
            expect(vi.getTimerCount()).toBe(baseline);
        }
        expect(guard.prometheusText()).toContain('agent_guard_trap_blocked 0\n');
        expect(guard.prometheusText()).toContain('agent_guard_trap_delayed 0\n');
    } finally { await guard.close(); }
});

it('automation_score alone never gates or blocks a periodic browser, even before one decoy', async () => {
    vi.useFakeTimers();
    const guard = createAgentGuard(trapConfig());
    try {
        const headers = { 'user-agent': browserUA };
        for (let i = 0; i < 21; i++) {
            await guard.inspect(request('/', { headers }));
            vi.advanceTimersByTime(100);
        }
        const hit = await guard.inspect(request('/.env', { headers }));
        expect(hit.events[0]?.automation_score).toBe(1);
        expect(hit.events[0]?.score).toBe(50);
        expect(response(hit).status).toBe(200);
        expect(guard.prometheusText()).toContain('agent_guard_trap_delayed 0\n');
        expect((await guard.inspect(request('/', { headers }))).action).toBe('pass');
    } finally { await guard.close(); }
});

it('keeps a fresh single decoy outside even a zero score threshold, requiring another detection observation', async () => {
    vi.useFakeTimers();
    const guard = createAgentGuard(trapConfig({ gate: { minScore: 0 } }));
    try {
        expect(response(await guard.inspect(request('/.env'))).status).toBe(200);
        expect(guard.prometheusText()).toContain('agent_guard_trap_delayed 0\n');
        const second = guard.inspect(request('/.env'));
        await vi.advanceTimersByTimeAsync(0);
        expect(guard.prometheusText()).toContain('agent_guard_trap_delayed 1\n');
        await vi.advanceTimersByTimeAsync(60);
        expect(response(await second).status).toBe(200);
        expect(response(await guard.inspect(request('/.env'))).status).toBe(429);
        expect(guard.prometheusText()).toContain('agent_guard_trap_blocked 0\n');
    } finally { await guard.close(); }
});

it('applies a configured score gate to decoys but never uses score alone for block', async () => {
    vi.useFakeTimers();
    const guard = createAgentGuard(trapConfig({ delay: { enabled: false }, gate: { minScore: 120 } }));
    try {
        expect(response(await guard.inspect(request('/.env'))).status).toBe(200);
        expect(response(await guard.inspect(request('/.env'))).status).toBe(200);
        expect(response(await guard.inspect(request('/.env'))).status).toBe(429);
        for (let i = 0; i < 25; i++) expect(response(await guard.inspect(request('/.env'))).status).toBe(429);
        expect((await guard.inspect(request('/'))).action).toBe('pass');
        expect(guard.prometheusText()).toContain('agent_guard_trap_blocked 0\n');
    } finally { await guard.close(); }
});

it('adds the asynchronous delay only to confirmed decoys and preserves real pages', async () => {
    vi.useFakeTimers();
    const guard = createAgentGuard(trapConfig({ block: { enabled: false }, rateLimit: { enabled: false } }));
    try {
        await confirm(guard);
        expect((await guard.inspect(request('/'))).action).toBe('pass');
        let done = false;
        const pending = guard.inspect(request('/.env')).then(value => { done = true; return value; });
        await vi.advanceTimersByTimeAsync(59);
        expect(done).toBe(false);
        expect(guard.prometheusText()).toContain('agent_guard_trap_delayed 1\n');
        await vi.advanceTimersByTimeAsync(1);
        expect(response(await pending).status).toBe(200);
        expect(guard.prometheusText()).toContain('agent_guard_trap_delayed 0\n');
    } finally { await guard.close(); }
});

it('retains the D5 300–600ms login delay and stacks the trap delay', async () => {
    vi.useFakeTimers();
    const c = trapConfig({ block: { enabled: false }, rateLimit: { enabled: false } }), guard = createAgentGuard(c);
    try {
        await confirm(guard);
        let done = false;
        const pending = guard.inspect(request('/api/internal/auth/login', { method: 'POST' })).then(value => { done = true; return value; });
        await vi.advanceTimersByTimeAsync(fakeData(c.projectSeed).loginDelay + 59);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(response(await pending).status).toBe(401);
    } finally { await guard.close(); }
});

it('refills token buckets independently and never rate-limits real pages', async () => {
    vi.useFakeTimers();
    const guard = createAgentGuard(trapConfig({ block: { enabled: false }, delay: { enabled: false }, rateLimit: { enabled: true, capacity: 1, refillPerSec: 2 } }));
    try {
        await confirm(guard);
        expect(response(await guard.inspect(request('/.env'))).status).toBe(200);
        const denied = response(await guard.inspect(request('/.env')));
        expect(denied.status).toBe(429);
        expect(denied.headers['Cache-Control']).toBe('no-store');
        expect(denied.headers).not.toHaveProperty('Set-Cookie');
        expect((await guard.inspect(request('/'))).action).toBe('pass');
        vi.advanceTimersByTime(499);
        expect(response(await guard.inspect(request('/.env'))).status).toBe(429);
        vi.advanceTimersByTime(1);
        expect(response(await guard.inspect(request('/.env'))).status).toBe(200);
        expect(response(await guard.inspect(request('/.env', { ip: '198.51.100.1' }))).status).toBe(200);
    } finally { await guard.close(); }
});

it('logs every 403, blocks exactly one client key, and expires without renewing from historical high confidence', async () => {
    vi.useFakeTimers();
    const logged: AgentGuardEvent[] = [], c = trapConfig({ delay: { enabled: false }, rateLimit: { enabled: false } });
    const guard = createAgentGuard({ ...c, log: { sink: e => logged.push(e) } });
    try {
        await confirm(guard);
        for (const path of ['/', '/.env']) {
            const denied = await guard.inspect(request(path));
            expect(response(denied).status).toBe(403);
            expect(denied.events.at(-1)?.event).toBe('trap_block');
            expect(response(denied).headers['Cache-Control']).toBe('no-store');
            expect(response(denied).headers).not.toHaveProperty('Set-Cookie');
        }
        expect(logged.filter(e => e.event === 'trap_block')).toHaveLength(3); // includes replay request
        expect((await guard.inspect(request('/', { ip: '198.51.100.1' }))).action).toBe('pass');
        // A different UA has a different key, even on the same network.
        expect((await guard.inspect(request('/', { headers: { 'user-agent': browserUA } }))).action).toBe('pass');
        vi.advanceTimersByTime(999);
        expect(response(await guard.inspect(request('/'))).status).toBe(403);
        vi.advanceTimersByTime(1);
        expect(guard.prometheusText()).toContain('agent_guard_trap_blocked 0\n');
        expect((await guard.inspect(request('/'))).action).toBe('pass');
        expect(response(await guard.inspect(request('/.env'))).status).toBe(200);
        expect(guard.prometheusText()).toContain('agent_guard_events_total{type="trap_block"} 4\n');
    } finally { await guard.close(); }
});

it('block wins over rate-limit and delay, including HEAD requests', async () => {
    vi.useFakeTimers();
    const guard = createAgentGuard(trapConfig());
    try {
        await confirm(guard);
        const denied = await guard.inspect(request('/.env', { method: 'HEAD' }));
        expect(response(denied)).toMatchObject({ status: 403, body: '' });
        expect(guard.prometheusText()).toContain('agent_guard_trap_delayed 0\n');
    } finally { await guard.close(); }
});

it.each([{ ips: ['192.0.2.1'] }, { cidrs: ['192.0.2.0/24'] }, { uaPatterns: [/curl/] }, { headerToken: { name: 'X-Allow', value: 'yes' } }])('allowlist %j stays ahead of canary scanning and trap', async allowlist => {
    const guard = createAgentGuard({ ...trapConfig(), allowlist });
    try {
        for (let i = 0; i < 4; i++) expect(await guard.inspect(request('/.env', { headers: { 'user-agent': 'curl/8.0', 'x-allow': 'yes' } }))).toEqual({ action: 'pass', events: [] });
        expect(guard.prometheusText()).toContain('agent_guard_trap_blocked 0\n');
    } finally { await guard.close(); }
});

it('never confirms verified crawlers that present a real canary, on decoy or ordinary paths', async () => {
    const guard = createAgentGuard({ ...trapConfig(), crawler: { resolver: verifiedResolver } });
    try {
        const token = await confirm(guard);
        const headers = { 'user-agent': 'Googlebot', authorization: token };
        const bypass = await guard.inspect(request('/.env', { headers, ip: '66.249.66.1' }));
        expect(response(bypass).status).toBe(404);
        expect(bypass.events.some(e => e.event === 'crawler_bypass')).toBe(true);
        expect((await guard.inspect(request('/', { headers, ip: '66.249.66.1' }))).action).toBe('pass');
        expect((await guard.inspect(request('/', { headers: { 'user-agent': 'Googlebot' }, ip: '66.249.66.1' }))).action).toBe('pass');
        expect(guard.prometheusText()).toContain('agent_guard_trap_blocked 1\n'); // curl key only
    } finally { await guard.close(); }
});

it('bounds confirmation and token bucket LRUs to 8192 keys', () => {
    const trap = new Trap('trap', { rateLimit: { enabled: true, capacity: 1, refillPerSec: 0 } });
    try {
        for (let i = 0; i <= 8192; i++) {
            trap.observe(event({ event: 'canary_replay', req: { method: 'GET', path: '/', client_key: String(i) } }));
            expect(trap.limited(String(i))).toBe(false);
        }
        expect(trap.gated('0', 0)).toBe(false);
        expect(trap.gated('8192', 0)).toBe(true);
        expect(trap.limited('8192')).toBe(true);
        expect(trap.limited('0')).toBe(false);
    } finally { trap.close(); }
});

it('bounds blocks with LRU eviction and grants incident=high without relying on event severity', () => {
    const trap = new Trap('trap', { block: { enabled: true, maxKeys: 2 } });
    const observe = (key: string) => trap.observe(event({ req: { method: 'GET', path: '/', client_key: key }, incident: { id: 'incident', sequence: ['D1', 'D2'], first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), confidence: 'high' } }));
    try {
        observe('a'); observe('b');
        expect(trap.blocked('a')).toBe(true);
        observe('c');
        expect(trap.blocked('b')).toBe(false);
        expect(trap.blocked('a')).toBe(true);
        expect(trap.blocked('c')).toBe(true);
        expect(trap.snapshot().blocked).toBe(2);
    } finally { trap.close(); }
});

it('AC-21: admits only 20 extra delays for 100 distinct confirmed clients, skips the rest, and keeps host passes healthy', async () => {
    vi.useFakeTimers();
    const guard = createAgentGuard(trapConfig({ block: { enabled: false }, rateLimit: { enabled: false } }));
    try {
        const keys = Array.from({ length: 100 }, (_, i) => ({ headers: { 'user-agent': `confirmed-client-${i}` } }));
        for (const key of keys) await confirm(guard, key);
        let completed = 0;
        const pending = keys.map(key => guard.inspect(request('/.env', key)).then(value => { completed++; return value; }));
        await vi.advanceTimersByTimeAsync(0);
        expect(guard.prometheusText()).toContain('agent_guard_trap_delayed 20\n');
        expect(completed).toBe(80);
        expect((await guard.inspect(request('/', { ip: '198.51.100.1' }))).action).toBe('pass');
        await vi.advanceTimersByTimeAsync(60);
        expect((await Promise.all(pending)).every(value => response(value).status === 200)).toBe(true);
        expect(guard.prometheusText()).toContain('agent_guard_trap_delayed 0\n');
    } finally { await guard.close(); }
});

it('AC-24: opens once on inspect p99, serves detect responses after opening, and supports manual reset', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const events: AgentGuardEvent[] = [];
    const guard = createAgentGuard({ ...trapConfig({ circuit: { inspectP99Ns: 1 } }), onEvent: e => events.push(e) });
    try {
        await confirm(guard);
        vi.setSystemTime(Date.now() + 251);
        for (let i = 0; i < 5; i++) expect(response(await guard.inspect(request('/.env'))).status).toBe(200);
        expect(events.filter(e => e.event === 'trap_circuit_open')).toHaveLength(1);
        expect(events.filter(e => e.event === 'decoy_hit')).toHaveLength(6);
        expect(guard.prometheusText()).toContain('agent_guard_trap_enabled 0\n');
        expect(guard.prometheusText()).toContain('agent_guard_events_total{type="trap_circuit_open"} 1\n');
        guard.setTrapEnabled(true);
        expect(response(await guard.inspect(request('/.env'))).status).toBe(403);
        expect(guard.prometheusText()).toContain('agent_guard_trap_enabled 1\n');
    } finally { await guard.close(); }
});

it('trips on the cheap event-loop drift probe and releases outstanding delays', async () => {
    vi.useFakeTimers();
    vi.spyOn(process.hrtime, 'bigint').mockReturnValueOnce(0n).mockReturnValue(300_000_000n);
    const trap = new Trap('trap', { delay: { enabled: true, ms: 1000 }, circuit: { eventLoopDelayMs: 10 } });
    try {
        const pending = trap.delay();
        vi.advanceTimersByTime(250);
        expect(trap.checkCircuit(() => 0)).toBe(true);
        await pending;
        expect(trap.snapshot()).toMatchObject({ enabled: false, delayed: 0 });
        expect(trap.checkCircuit(() => Infinity)).toBe(false);
    } finally { trap.close(); }
});

it.each(['environment', 'manual'] as const)('%s kill switch immediately bypasses delay, 429 and 403, while detection continues', async kind => {
    vi.useFakeTimers();
    const guards = [
        createAgentGuard(trapConfig()),
        createAgentGuard(trapConfig({ block: { enabled: false }, rateLimit: { enabled: false } })),
        createAgentGuard(trapConfig({ block: { enabled: false }, delay: { enabled: false } })),
    ];
    try {
        for (const guard of guards) await confirm(guard);
        expect(response(await guards[2]!.inspect(request('/.env'))).status).toBe(200);
        expect(response(await guards[2]!.inspect(request('/.env'))).status).toBe(429);
        if (kind === 'environment') vi.stubEnv('AGENT_GUARD_TRAP', 'off');
        else for (const guard of guards) guard.setTrapEnabled(false);
        for (const guard of guards) {
            const hit = await guard.inspect(request('/.env'));
            expect(response(hit).status).toBe(200);
            expect(hit.events.some(e => e.event === 'decoy_hit')).toBe(true);
            expect((await guard.inspect(request('/'))).action).toBe('pass');
            expect(guard.prometheusText()).toContain('agent_guard_trap_enabled 0\n');
            expect(guard.prometheusText()).toContain('agent_guard_trap_delayed 0\n');
        }
        if (kind === 'environment') vi.stubEnv('AGENT_GUARD_TRAP', 'on');
        else for (const guard of guards) guard.setTrapEnabled(true);
        expect(response(await guards[0]!.inspect(request('/.env'))).status).toBe(403);
    } finally { for (const guard of guards) await guard.close(); }
});

it('manual disable and close cancel pending trap timers', async () => {
    vi.useFakeTimers();
    const trap = new Trap('trap', { delay: { enabled: true, ms: 3000 } });
    const first = trap.delay();
    trap.setEnabled(false);
    await first;
    expect(trap.snapshot().delayed).toBe(0);
    trap.setEnabled(true);
    const second = trap.delay();
    trap.close();
    await second;
    expect(vi.getTimerCount()).toBe(0);
});

it('validates emitted trap event types against the strict v1 schema', async () => {
    const { $schema: _draft, ...schema } = JSON.parse(readFileSync(new URL('../../schema/event.v1.json', import.meta.url), 'utf8'));
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
    app.post('/', { schema: { body: schema } }, async () => ({ ok: true }));
    const events: AgentGuardEvent[] = [], guard = createAgentGuard({ ...trapConfig({ circuit: { inspectP99Ns: 1 } }), onEvent: e => events.push(e) });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
        await confirm(guard);
        vi.setSystemTime(Date.now() + 251);
        await guard.inspect(request('/.env'));
        const trapEvents = events.filter(e => e.event.startsWith('trap_'));
        expect(trapEvents.map(e => e.event)).toEqual(['trap_block', 'trap_circuit_open']);
        for (const payload of trapEvents) expect((await app.inject({ method: 'POST', url: '/', payload })).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: '/', payload: { ...trapEvents[0], unexpected: true } })).statusCode).toBe(400);
    } finally { await app.close(); await guard.close(); }
});

it('delivers block and circuit alerts through existing adapters while logging every block', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const sent: AgentGuardEvent[] = [];
    const guard = createAgentGuard({ ...trapConfig({ circuit: { inspectP99Ns: 1 } }), alerts: { adapters: [{ name: 'local-test', send: async payload => { sent.push(payload.event); return { ok: true }; } }] } });
    try {
        await confirm(guard);
        await guard.inspect(request('/'));
        vi.setSystemTime(Date.now() + 251);
        await guard.inspect(request('/.env'));
        await guard.close();
        expect(sent.filter(e => e.event === 'trap_block')).toHaveLength(1); // alert dedup, independent of per-403 logs
        expect(sent.filter(e => e.event === 'trap_circuit_open')).toHaveLength(1);
        expect(sent.find(e => e.event === 'trap_block')?.req.ip).toBe('192.0.2.x');
    } finally { await guard.close(); }
});
