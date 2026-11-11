import { expect, it, vi } from 'vitest';
import { createAgentGuard, type AgentGuardEvent, type AGDecision } from '../../src/index.js';
import { Timing, automationScore } from '../../src/core/timing.js';
import { Registry } from '../../src/canary/registry.js';
import { Decoys } from '../../src/decoys/index.js';
import { config, request } from '../helpers.js';

const browser = { 'user-agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36' };

it.each([
    ['constant', Array<number>(20).fill(100)],
    ['nearly constant', Array.from({ length: 20 }, (_, i) => 50 + i % 2)],
])('scores %s intervals as strongly mechanical', (_name, intervals) => {
    expect(automationScore(intervals)).toBeGreaterThanOrEqual(.8);
    expect(automationScore(intervals)).toBeLessThanOrEqual(1);
});

it('scores human-like pauses and jitter near zero', () => {
    const intervals = [80, 2400, 150, 4000, 90, 700, 120, 3100, 400, 5200, 110, 1900, 70, 800, 3000, 180, 6000, 250, 1100, 95];
    expect(automationScore(intervals)).toBeGreaterThanOrEqual(0);
    expect(automationScore(intervals)).toBeLessThanOrEqual(.4);
});

it('does not score modest human-like irregularity as strongly mechanical', () => {
    const intervals = Array.from({ length: 20 }, (_, i) => [850, 1000, 1150, 900, 1100][i % 5]!);
    expect(automationScore(intervals)).toBeLessThan(.8);
});

it('treats zero-mean intervals as mechanical and skips empty samples', () => {
    expect(automationScore(Array<number>(20).fill(0))).toBe(1);
    expect(automationScore([])).toBeUndefined();
});

it('is independent of interval units and clamps high CV to zero', () => {
    const intervals = [85, 100, 115, 90, 110];
    expect(automationScore(intervals)).toBeCloseTo(automationScore(intervals.map(n => n * 1000))!);
    expect(automationScore([0, 0, 0, 10000])).toBe(0);
});

it('requires exactly 20 intervals (21 requests) by default', () => {
    const timing = new Timing();
    expect(timing.windowSize).toBe(20);
    for (let i = 0; i < 20; i++) expect(timing.record('a', i * 100)).toBeUndefined();
    expect(timing.record('a', 2000)).toBe(1);
    expect(timing.record('b', 2000)).toBeUndefined();
});

it('uses only the latest N intervals after the ring wraps', () => {
    const timing = new Timing(4);
    for (let i = 0; i <= 4; i++) timing.record('a', i * 100);
    expect(timing.record('a', 10000)).toBe(0);
    for (let i = 1; i < 4; i++) expect(timing.record('a', 10000 + i * 100)).toBe(0);
    expect(timing.record('a', 10400)).toBe(1);
});

it('clamps backward clock movement and saturates uint32 intervals without wrapping', () => {
    const timing = new Timing(2);
    timing.record('backward', 100);
    timing.record('backward', 50);
    expect(timing.record('backward', 0)).toBe(1);
    timing.record('overflow', 0);
    timing.record('overflow', 0);
    expect(timing.record('overflow', 0x1_0000_0000)).toBe(0);
});

it('evicts the least recently used client and starts its warm-up over', () => {
    const timing = new Timing(2, 2);
    for (const key of ['a', 'b']) {
        timing.record(key, 0);
        timing.record(key, 100);
        expect(timing.record(key, 200)).toBe(1);
    }
    expect(timing.record('a', 300)).toBe(1);
    timing.record('c', 0);
    expect(timing.size).toBe(2);
    expect(timing.record('a', 400)).toBe(1);
    expect(timing.record('b', 300)).toBeUndefined();
    expect(timing.size).toBe(2);
});

it('caps the default timing LRU at 2048 keys', () => {
    const timing = new Timing();
    expect(timing.capacity).toBe(2048);
    for (let i = 0; i <= timing.capacity; i++) timing.record(String(i), 0);
    expect(timing.size).toBe(2048);
    expect(timing.record('0', 100)).toBeUndefined();
    expect(timing.size).toBe(2048);
});

it('rejects invalid timing window sizes and capacities', () => {
    for (const value of [0, -1, .5, NaN, Infinity]) {
        expect(() => new Timing(value)).toThrow(RangeError);
        expect(() => new Timing(20, value)).toThrow(RangeError);
    }
});

it('omits automation_score during warm-up and isolates inspected client keys', async () => {
    vi.useFakeTimers();
    const emitted: AgentGuardEvent[] = [];
    const guard = createAgentGuard(config({ onEvent: e => emitted.push(e) }));
    try {
        for (let i = 0; i < 20; i++) {
            const result = await guard.inspect(request('/wp-admin', { headers: browser }));
            expect(result.events).toHaveLength(1);
            expect(result.events[0]).not.toHaveProperty('automation_score');
            vi.advanceTimersByTime(100);
        }
        const result = await guard.inspect(request('/wp-admin', { headers: browser }));
        expect(result.events[0]?.automation_score).toBeGreaterThanOrEqual(.8);
        expect(result.events[0]?.automation_score).toBeLessThanOrEqual(1);
        expect(emitted.at(-1)).toEqual(result.events[0]);
        const second = await guard.inspect(request('/wp-admin', { headers: browser, ip: '198.51.100.1' }));
        expect(second.events[0]).not.toHaveProperty('automation_score');
        expect(second.events[0]?.req.client_key).not.toBe(result.events[0]?.req.client_key);
    } finally { await guard.close(); }
});

it('keeps periodic ordinary browser requests quiet and excludes allowlisted requests', async () => {
    vi.useFakeTimers();
    const emitted: AgentGuardEvent[] = [];
    const guard = createAgentGuard(config({ onEvent: e => emitted.push(e) }));
    const allowed = createAgentGuard(config({ allowlist: { ips: ['192.0.2.1'] } }));
    try {
        for (let i = 0; i < 30; i++) {
            expect(await guard.inspect(request('/', { headers: browser }))).toEqual({ action: 'pass', events: [] });
            expect(await allowed.inspect(request('/.env'))).toEqual({ action: 'pass', events: [] });
            vi.advanceTimersByTime(100);
        }
        expect(emitted).toEqual([]);
        expect(allowed.prometheusText()).toContain('agent_guard_timing_state_size 0\n');
        expect(allowed.prometheusText()).toContain('agent_guard_client_state_size 0\n');
    } finally { await guard.close(); await allowed.close(); }
});

it('preserves decoy and replay responses, event types, severity, signals and scores', async () => {
    vi.useFakeTimers();
    const c = config();
    const registry = new Registry(c.canary.registry, c.canary.secret, 'AG-CANARY-');
    new Decoys(c, registry);
    const shared = { ...c, canary: { ...c.canary, registry: registry.data } };
    const timed = createAgentGuard(shared), baseline = createAgentGuard(shared);
    const stable = (decision: AGDecision) => ({
        action: decision.action,
        ...(decision.action === 'respond' ? { response: decision.response } : {}),
        events: decision.events.map(e => ({ event: e.event, severity: e.severity, signals: e.signals, score: e.score, decoy: e.decoy })),
    });
    try {
        // Quiet requests build timing history without contributing any detection signal.
        for (let i = 0; i < 21; i++) {
            await timed.inspect(request('/', { headers: browser }));
            vi.advanceTimersByTime(100);
        }
        const inputs = [request('/.env', { headers: browser }), request('/normal', { headers: { ...browser, authorization: registry.data.canaries[0]!.token } })];
        for (const input of inputs) {
            const a = await timed.inspect(input), b = await baseline.inspect(input);
            expect(a.events).toHaveLength(1);
            expect(a.events[0]?.automation_score).toBeGreaterThanOrEqual(.8);
            expect(b.events[0]).not.toHaveProperty('automation_score');
            expect(stable(a)).toEqual(stable(b));
            vi.advanceTimersByTime(100);
        }
        expect(timed.metrics().decoy_hits.D1).toBe(1);
        expect(timed.metrics().canary_replays).toBe(1);
    } finally { await timed.close(); await baseline.close(); }
});

it('bounds timing state independently of the existing client map during inspection', async () => {
    const guard = createAgentGuard(config());
    try {
        for (let i = 0; i < 2050; i++)
            await guard.inspect(request('/', { headers: { 'user-agent': `Mozilla/5.0 timing-${i}` } }));
        expect(guard.prometheusText()).toContain('agent_guard_client_state_size 2050\n');
        expect(guard.prometheusText()).toContain('agent_guard_timing_state_size 2048\n');
    } finally { await guard.close(); }
});
