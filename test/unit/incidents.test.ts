import { execFileSync } from 'node:child_process';
import { it, expect, vi } from 'vitest';
import { createAgentGuard } from '../../src/index.js';
import { Incidents } from '../../src/core/incidents.js';
import { config, request, verifiedResolver } from '../helpers.js';

it('correlates robots → D1 → D2, isolates client keys, and raises confidence on replay', async () => {
    vi.useFakeTimers();
    try {
        const guard = createAgentGuard(config());
        const first = Date.now();
        expect(await guard.inspect(request('/robots.txt'))).toEqual({ action: 'pass', events: [] });
        vi.advanceTimersByTime(1000);
        const env = await guard.inspect(request('/.env'));
        const beforeReplay = env.events[0]!.incident!;
        expect(beforeReplay).toMatchObject({ sequence: ['robots', 'D1'], confidence: 'medium', first_seen: new Date(first).toISOString(), last_seen: new Date(first + 1000).toISOString() });
        const admin = await guard.inspect(request('/api/internal/admin/users'));
        expect(admin.events[0]?.incident).toMatchObject({ id: beforeReplay.id, sequence: ['robots', 'D1', 'D2'], confidence: 'medium' });
        expect((await guard.inspect(request('/.env', { ip: '198.51.100.1' }))).events[0]?.incident).toBeUndefined();
        expect(env.action).toBe('respond');
        if (env.action !== 'respond') throw new Error('expected decoy');
        const token = /^ADMIN_API_TOKEN=(.+)$/m.exec(env.response.body)![1]!;
        const replay = await guard.inspect(request('/ordinary', { headers: { 'user-agent': 'curl/8.0', authorization: token } }));
        expect(replay.action).toBe('pass');
        expect(replay.events[0]).toMatchObject({ event: 'canary_replay', severity: 'critical', incident: { id: beforeReplay.id, sequence: ['robots', 'D1', 'D2', 'canary_replay'], confidence: 'high' } });
        expect((await guard.inspect(request('/api/internal/admin/users'))).events[0]?.incident?.confidence).toBe('high');
        await guard.close();
    } finally { vi.useRealTimers(); }
});

it('uses a fixed configurable window, expires at its boundary, and validates limits', () => {
    let now = 0;
    const incidents = new Incidents(900_000, () => now);
    incidents.observe('a', 'robots');
    now = 899_999;
    const old = incidents.observe('a', 'D1')!;
    expect(old.sequence).toEqual(['robots', 'D1']);
    now = 900_000;
    expect(incidents.observe('a', 'D2')).toBeUndefined();
    const fresh = incidents.observe('a', 'D3')!;
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.first_seen).toBe(new Date(now).toISOString());
    expect(fresh.sequence).toEqual(['D2', 'D3']);
    for (const windowMs of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
        expect(() => createAgentGuard(config({ incident: { windowMs } }))).toThrow('incident.windowMs');
    expect(new Incidents(0).observe('a', 'canary_replay')).toBeUndefined();
});

it('bounds client LRU and sequence length without lowering cumulative confidence', () => {
    const incidents = new Incidents(1000, () => 0, 2);
    incidents.observe('a', 'robots');
    incidents.observe('b', 'D1');
    const a = incidents.observe('a', 'canary_replay')!;
    incidents.observe('c', 'D1');
    expect(incidents.size).toBe(2);
    expect(incidents.observe('b', 'D2')).toBeUndefined();
    // Reintroduce a, then prove truncation never forgets the replay feature.
    const high = incidents.observe('a', 'canary_replay')!;
    expect(high.id).not.toBe(a.id);
    for (let i = 0; i < 100; i++) incidents.observe('a', 'D1');
    const tail = incidents.observe('a', 'D2')!;
    expect(tail.sequence).toHaveLength(32);
    expect(tail.sequence.at(-1)).toBe('D2');
    expect(tail.confidence).toBe('high');
    const repeated = new Incidents();
    repeated.observe('a', 'D1');
    expect(repeated.observe('a', 'D1')?.confidence).toBe('low');
    repeated.observe('b', 'probe');
    expect(repeated.observe('b', 'GQL')?.confidence).toBe('medium');
});

it('leaves decisions, responses, scores, severities, signals, and event types identical', async () => {
    // A shared registry makes response bytes stable across both guard instances.
    const { Registry } = await import('../../src/canary/registry.js');
    const { Decoys } = await import('../../src/decoys/index.js');
    const c = config({ crawler: { resolver: verifiedResolver } });
    const registry = new Registry(c.canary.registry, c.canary.secret, 'AG-CANARY-');
    new Decoys(c, registry);
    const on = createAgentGuard({ ...c, canary: { ...c.canary, registry: registry.data } });
    const off = createAgentGuard({ ...c, canary: { ...c.canary, registry: registry.data }, incident: { windowMs: 0 } });
    const token = registry.data.canaries[0]!.token;
    const inputs = [request('/robots.txt'), request('/.env'), request('/api/internal/admin/users'), request('/wp-admin'), request('/llms.txt'), request('/normal', { headers: { authorization: token } }), request('/.env', { headers: { 'user-agent': 'Googlebot' }, ip: '66.249.66.1' }), request('/normal')];
    for (const input of inputs) {
        const a = await on.inspect(input), b = await off.inspect(input);
        const stable = (decision: typeof a) => ({ ...decision, events: decision.events.map(({ ts: _ts, event_id: _id, incident: _incident, canary, ...event }) => ({ ...event, ...(canary ? { canary: { ...canary, dwell_ms: 0 } } : {}) })) });
        expect(stable(a)).toEqual(stable(b));
    }
    await on.close(); await off.close();
});

it('keeps 50k correlated clients below the 10,000,000-byte memory gate', () => {
    // A separate process provides explicit GC and excludes Vitest's retained mocks.
    const output = execFileSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', `
        import { Incidents } from './src/core/incidents.ts';
        import { clientKey } from './src/core/client-key.ts';
        global.gc();
        const before = process.memoryUsage();
        const incidents = new Incidents();
        for (let i = 0; i < 50000; i++) {
            const key = clientKey('192.0.2.1', 'memory-client-' + i);
            incidents.observe(key, 'robots');
            incidents.observe(key, 'D1');
            incidents.observe(key, 'D2');
        }
        global.gc();
        const after = process.memoryUsage();
        console.log(JSON.stringify({ clients: incidents.size, heapDeltaBytes: Math.max(0, after.heapUsed - before.heapUsed), arrayBufferDeltaBytes: Math.max(0, after.arrayBuffers - before.arrayBuffers) }));
        if (incidents.observe(clientKey('192.0.2.1', 'memory-client-0'), 'D3').sequence.length !== 4) throw Error('state lost');
        for (let i = 50000; i < 50010; i++) incidents.observe(clientKey('192.0.2.1', 'memory-client-' + i), 'robots');
        if (incidents.size !== 50000 || incidents.observe(clientKey('192.0.2.1', 'memory-client-1'), 'D1') !== undefined) throw Error('LRU cap failed');
    `], { cwd: process.cwd(), encoding: 'utf8' });
    const result = JSON.parse(output) as { clients: number; heapDeltaBytes: number; arrayBufferDeltaBytes: number };
    console.log('50k incident memory:', JSON.stringify(result));
    expect(result.clients).toBe(50_000);
    expect(result.heapDeltaBytes).toBeLessThanOrEqual(10_000_000);
    // Include typed-array backing storage too, so the compact representation is honest.
    expect(result.heapDeltaBytes + result.arrayBufferDeltaBytes).toBeLessThanOrEqual(10_000_000);
});
