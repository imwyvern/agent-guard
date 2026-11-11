import { it, expect, vi } from 'vitest';
import { createAgentGuard, generateCanary } from '../../src/index.js';
import { CanaryTracing } from '../../src/canary/tracing.js';
import { Registry } from '../../src/canary/registry.js';
import { Decoys } from '../../src/decoys/index.js';
import { config, request, verifiedResolver } from '../helpers.js';

it('reports first delivery → replay provenance, elapsed time, and distinct client keys capped at 8', async () => {
    vi.useFakeTimers();
    try {
        const guard = createAgentGuard(config());
        const env = await guard.inspect(request('/.env'));
        if (env.action !== 'respond') throw new Error('expected decoy');
        const token = /^ADMIN_API_TOKEN=(.+)$/m.exec(env.response.body)![1]!;
        vi.advanceTimersByTime(1000);
        await guard.inspect(request('/.env.local')); // Does not reset first issuance.
        vi.advanceTimersByTime(2000);
        const replay = () => guard.inspect(request('/api/auth/check?source=example', { headers: { 'user-agent': 'curl/8.0', authorization: `Bearer ${token}` } }));
        const first = (await replay()).events[0]!;
        expect(first.canary).toEqual({ id: token.slice(10, 22), placement: 'D1:/.env#ADMIN_API_TOKEN', env: 'demo', found_in: 'header', field: 'authorization', leaked_at: 'D1:/.env#ADMIN_API_TOKEN', replayed_at: '/api/auth/check', dwell_ms: 3000, client_keys_seen: 1 });
        expect((await replay()).events[0]?.canary?.client_keys_seen).toBe(1);
        for (let i = 1; i <= 10; i++) {
            const result = await guard.inspect(request('/anywhere', { ip: `198.51.${i}.1`, headers: { authorization: token } }));
            expect(result.action).toBe('pass');
            expect(result.events[0]?.canary?.client_keys_seen).toBe(Math.min(i + 1, 8));
        }
        await guard.close();
    } finally { vi.useRealTimers(); }
});

it('omits dwell after restart, before delivery, and for unregistered signed tokens', async () => {
    const c = config(), registry = new Registry(c.canary.registry, c.canary.secret, 'AG-CANARY-');
    new Decoys(c, registry);
    const entry = registry.data.canaries[0]!;
    const first = createAgentGuard({ ...c, canary: { ...c.canary, registry: registry.data } });
    await first.inspect(request('/.env'));
    const input = request('/ordinary', { headers: { authorization: entry.token } });
    expect((await first.inspect(input)).events[0]?.canary?.dwell_ms).toBeGreaterThanOrEqual(0);
    await first.close();
    const restarted = createAgentGuard({ ...c, canary: { ...c.canary, registry: registry.data } });
    expect((await restarted.inspect(input)).events[0]?.canary).not.toHaveProperty('dwell_ms');
    const signed = generateCanary({ secret: c.canary.secret });
    expect((await restarted.inspect(request('/', { headers: { authorization: signed.token } }))).events[0]?.canary).toMatchObject({ placement: 'unregistered', leaked_at: 'unregistered', client_keys_seen: 1 });
    expect((await restarted.inspect(request('/', { headers: { authorization: signed.token } }))).events[0]?.canary).not.toHaveProperty('dwell_ms');
    await restarted.close();
});

it('only records canaries actually delivered in decoy bodies, including D3/D4 and legacy tokens', async () => {
    const c = config({ crawler: { resolver: verifiedResolver } });
    const registry = new Registry(c.canary.registry, c.canary.secret, 'AG-CANARY-');
    new Decoys(c, registry);
    const guard = createAgentGuard({ ...c, canary: { ...c.canary, registry: registry.data } });
    await guard.inspect(request('/.env', { method: 'HEAD' }));
    await guard.inspect(request('/.env', { headers: { 'user-agent': 'Googlebot' }, ip: '66.249.66.1' }));
    const envToken = registry.data.canaries[0]!.token;
    expect((await guard.inspect(request('/', { headers: { authorization: envToken } }))).events[0]?.canary).not.toHaveProperty('dwell_ms');
    await guard.inspect(request('/internal/ops-notes'));
    await guard.inspect(request('/api/internal/openapi.json'));
    for (const entry of registry.data.canaries) {
        const canary = (await guard.inspect(request('/', { headers: { authorization: entry.token } }))).events[0]!.canary!;
        expect('dwell_ms' in canary).toBe(!entry.placement.startsWith('D1:'));
    }
    await guard.close();
    const entry = { ...registry.data.canaries[0]!, token: 'LEGACY-INERT-TOKEN' };
    const legacy = new Registry({ ...registry.data, canaries: [entry] }, c.canary.secret, 'AG-CANARY-');
    const traces = new CanaryTracing();
    traces.delivered(entry.token, legacy);
    expect(traces.replay(entry, '/replay', 'a').dwell_ms).toBeGreaterThanOrEqual(0);
});

it('bounds tracing LRU, expires records after 24h, and starts dwell on delivery after a replay', () => {
    let now = 0;
    const traces = new CanaryTracing(() => now, 2);
    const c = config(), registry = new Registry(c.canary.registry, c.canary.secret, 'AG-CANARY-');
    const a = registry.placement('test:a', 'demo'), b = registry.placement('test:b', 'demo'), d = registry.placement('test:d', 'demo');
    expect(traces.replay(a, '/', 'a')).not.toHaveProperty('dwell_ms');
    now = 100;
    traces.delivered(a.token, registry);
    traces.delivered(b.token, registry);
    now = 150;
    expect(traces.replay(a, '/', 'b')).toMatchObject({ dwell_ms: 50, client_keys_seen: 2 });
    traces.delivered(d.token, registry); // a was recently read, so b is evicted.
    expect(traces.size).toBe(2);
    expect(traces.replay(b, '/', 'a')).not.toHaveProperty('dwell_ms');
    now += 24 * 60 * 60_000;
    expect(traces.replay(d, '/', 'a')).not.toHaveProperty('dwell_ms');
});
