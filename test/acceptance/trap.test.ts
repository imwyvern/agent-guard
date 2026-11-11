import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDemo, browserUA, type Demo } from '../../examples/shared/site.js';
import type { AgentGuardConfig, AgentGuardEvent } from '../../src/index.js';
import { Registry } from '../../src/canary/registry.js';
import { Decoys } from '../../src/decoys/index.js';
import { config, decoyPaths, verifiedResolver } from '../helpers.js';
import { allTrap, tokenFrom, trapConfig } from '../helpers/trap.js';

afterEach(() => vi.unstubAllEnvs());

async function snapshot(demo: Demo, path: string, headers = { 'user-agent': browserUA }) {
    const result = await fetch(demo.url + path, { headers });
    return { status: result.status, body: await result.text(), headers: Object.fromEntries([...result.headers].filter(([name]) => !['date', 'connection', 'keep-alive'].includes(name))) };
}
async function seed(demo: Demo, ua = 'trap-client'): Promise<string> {
    const token = tokenFrom((await snapshot(demo, '/.env', { 'user-agent': ua })).body);
    const replay = await fetch(demo.url + '/', { headers: { 'user-agent': ua, authorization: token } });
    await replay.text();
    return token;
}
function noTrap(events: AgentGuardEvent[]): void { expect(events.some(e => e.event.startsWith('trap_'))).toBe(false); }

for (const runtime of ['express', 'node', 'hono', 'fastify', 'koa'] as const) {
    describe(`${runtime} trap acceptance`, () => {
        async function using(c: AgentGuardConfig, fn: (demo: Demo, native: Demo, events: AgentGuardEvent[]) => Promise<void>) {
            const events: AgentGuardEvent[] = [];
            const demo = await startDemo(runtime, { ...c, onEvent: e => { events.push(e); c.onEvent?.(e); } });
            const native = await startDemo(runtime, false);
            try { await fn(demo, native, events); }
            finally { await demo.close(); await native.close(); }
        }

        it('AC-16 partial: default detect and trap with maze disabled preserve the native archive 404', async () => {
            for (const c of [config(), trapConfig()]) await using(c, async (demo, native, events) => {
                const path = '/api/internal/archive/anything';
                expect(await snapshot(demo, path)).toEqual(await snapshot(native, path));
                expect((await snapshot(demo, path)).status).toBe(404);
                noTrap(events);
            });
        });

        it('default-off trap constructs and preserves homepage and D1 status, headers and body byte-for-byte', async () => {
            const c = config(), registry = new Registry(c.canary.registry, c.canary.secret, 'AG-CANARY-');
            new Decoys(c, registry);
            const shared = { ...c, canary: { ...c.canary, registry: registry.data } };
            const detect = await startDemo(runtime, shared);
            try {
                await using({ ...shared, mode: 'trap' }, async (demo, _native, events) => {
                    for (const path of ['/', '/.env']) expect(await snapshot(demo, path)).toEqual(await snapshot(detect, path));
                    noTrap(events);
                });
            } finally { await detect.close(); }
        });

        it('AC-17: a browser with Referer and irregular pauses gets no delay, 429 or 403 with every core flag on', async () => {
            await using(trapConfig({ delay: { enabled: true, ms: 250 } }), async (demo, native, events) => {
                const headers = { 'user-agent': browserUA, referer: 'https://catalog.invalid/list' };
                for (const [path, pause] of [['/', 7], ['/list', 23], ['/item/1', 3]] as const) {
                    await new Promise(resolve => setTimeout(resolve, pause));
                    expect(await snapshot(demo, path, headers)).toEqual(await snapshot(native, path, headers));
                }
                const start = performance.now(), decoy = await snapshot(demo, '/.env', headers);
                expect(decoy.status).toBe(200);
                expect(performance.now() - start).toBeLessThan(150);
                expect((await snapshot(demo, '/', headers)).status).toBe(200);
                expect(events.filter(e => e.event === 'decoy_hit')).toHaveLength(1);
                noTrap(events);
                expect(demo.guard!.prometheusText()).toContain('agent_guard_trap_blocked 0\n');
            });
        });

        it('AC-18: verified Googlebot and Bingbot see native missing routes, with no delay, 429 or block', async () => {
            const resolver = { ...verifiedResolver, reverse: async () => [...await verifiedResolver.reverse(), 'msnbot-127-0-0-1.search.msn.com'] };
            await using({ ...trapConfig({ delay: { enabled: true, ms: 250 } }), crawler: { resolver } }, async (demo, native, events) => {
                for (const ua of ['Googlebot', 'bingbot']) for (const path of [...decoyPaths, '/api/internal/archive/anything']) {
                    const headers = { 'user-agent': ua }, start = performance.now();
                    expect(await snapshot(demo, path, headers)).toEqual(await snapshot(native, path, headers));
                    expect(performance.now() - start).toBeLessThan(150);
                }
                expect(events.filter(e => e.event === 'crawler_bypass')).toHaveLength(10);
                expect(events.filter(e => e.event === 'decoy_hit')).toHaveLength(0);
                noTrap(events);
                expect(demo.guard!.prometheusText()).toContain('agent_guard_trap_blocked 0\n');
            });
        });

        it('AC-19: a single /.env only detects and does not confirm or consume a trap budget', async () => {
            await using(trapConfig({ delay: { enabled: true, ms: 250 } }), async (demo, _native, events) => {
                const start = performance.now(), hit = await snapshot(demo, '/.env', { 'user-agent': 'curl/8.0' });
                expect(hit.status).toBe(200);
                expect(hit.body).toContain('ADMIN_API_TOKEN=AG-CANARY-');
                expect(performance.now() - start).toBeLessThan(150);
                expect(events.map(e => e.event)).toEqual(['decoy_hit']);
                expect(demo.guard!.prometheusText()).toContain('agent_guard_trap_delayed 0\n');
                expect(demo.guard!.prometheusText()).toContain('agent_guard_trap_blocked 0\n');
            });
        });

        it('replay gates the next decoy delay while real pages and a different client key remain immediate', async () => {
            await using(trapConfig({ block: { enabled: false }, rateLimit: { enabled: false } }), async (demo, _native, events) => {
                await seed(demo);
                const start = performance.now();
                expect((await snapshot(demo, '/.env', { 'user-agent': 'trap-client' })).status).toBe(200);
                expect(performance.now() - start).toBeGreaterThanOrEqual(50);
                const homepage = performance.now();
                expect((await snapshot(demo, '/', { 'user-agent': 'trap-client' })).status).toBe(200);
                expect(performance.now() - homepage).toBeLessThan(50);
                const other = performance.now();
                expect((await snapshot(demo, '/.env', { 'user-agent': 'different-client' })).status).toBe(200);
                expect(performance.now() - other).toBeLessThan(50);
                expect(events.filter(e => e.event === 'canary_replay')).toHaveLength(1);
            });
        });

        it('rate-limits confirmed decoys with 429/no-store, preserving real pages and other keys', async () => {
            await using(trapConfig({ block: { enabled: false }, delay: { enabled: false } }), async demo => {
                await seed(demo);
                const headers = { 'user-agent': 'trap-client' };
                expect((await snapshot(demo, '/.env', headers)).status).toBe(200);
                const limited = await snapshot(demo, '/.env', headers);
                expect(limited.status).toBe(429);
                expect(limited.headers['cache-control']).toBe('no-store');
                expect(limited.headers).not.toHaveProperty('set-cookie');
                const head = await fetch(demo.url + '/.env', { method: 'HEAD', headers });
                expect(head.status).toBe(429);
                expect(await head.text()).toBe('');
                expect((await snapshot(demo, '/', headers)).status).toBe(200);
                expect((await snapshot(demo, '/.env', { 'user-agent': 'different-client' })).status).toBe(200);
            });
        });

        it('blocks only the replaying key until its fixed TTL, logging each 403 with no-store and no cookies', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            await using(trapConfig({ delay: { enabled: false }, rateLimit: { enabled: false } }), async (demo, _native, events) => {
                await seed(demo);
                const headers = { 'user-agent': 'trap-client' };
                for (const path of ['/', '/.env']) {
                    const blocked = await snapshot(demo, path, headers);
                    expect(blocked.status).toBe(403);
                    expect(blocked.headers['cache-control']).toBe('no-store');
                    expect(blocked.headers).not.toHaveProperty('set-cookie');
                }
                expect(events.filter(e => e.event === 'trap_block')).toHaveLength(3);
                expect((await snapshot(demo, '/')).status).toBe(200); // same IP, different key
                vi.setSystemTime(Date.now() + allTrap.block.ttlMs);
                expect((await snapshot(demo, '/', headers)).status).toBe(200);
                expect((await snapshot(demo, '/.env', headers)).status).toBe(200);
                expect(demo.guard!.prometheusText()).toContain('agent_guard_trap_blocked 0\n');
            });
        });

        it('allowlisted IPs always pass decoys to the native host with every trap flag enabled', async () => {
            await using({ ...trapConfig(), clientIp: () => '192.0.2.1', allowlist: { ips: ['192.0.2.1'] } }, async (demo, native, events) => {
                for (const path of [...decoyPaths, ...decoyPaths]) expect(await snapshot(demo, path)).toEqual(await snapshot(native, path));
                expect(events).toEqual([]);
                expect(demo.guard!.prometheusText()).toContain('agent_guard_trap_blocked 0\n');
            });
        });

        it('runtime environment and manual kill switches immediately restore detect responses after blocking', async () => {
            await using(trapConfig(), async demo => {
                await seed(demo);
                const headers = { 'user-agent': 'trap-client' };
                expect((await snapshot(demo, '/', headers)).status).toBe(403);
                vi.stubEnv('AGENT_GUARD_TRAP', 'off');
                for (let i = 0; i < 3; i++) expect((await snapshot(demo, '/.env', headers)).status).toBe(200);
                expect((await snapshot(demo, '/', headers)).status).toBe(200);
                expect(demo.guard!.prometheusText()).toContain('agent_guard_trap_enabled 0\n');
                vi.stubEnv('AGENT_GUARD_TRAP', 'on');
                expect((await snapshot(demo, '/', headers)).status).toBe(403);
                demo.guard!.setTrapEnabled(false);
                expect((await snapshot(demo, '/.env', headers)).status).toBe(200);
                demo.guard!.setTrapEnabled(true);
                expect((await snapshot(demo, '/', headers)).status).toBe(403);
            });
        });

        it('AC-24: an inspect p99 trip emits trap_circuit_open once and restores detection', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            await using(trapConfig({ circuit: { inspectP99Ns: 1 } }), async (demo, _native, events) => {
                await seed(demo);
                vi.setSystemTime(Date.now() + 251);
                const headers = { 'user-agent': 'trap-client' };
                for (let i = 0; i < 3; i++) {
                    const start = performance.now();
                    expect((await snapshot(demo, '/.env', headers)).status).toBe(200);
                    expect(performance.now() - start).toBeLessThan(50);
                }
                expect(events.filter(e => e.event === 'trap_circuit_open')).toHaveLength(1);
                expect(events.filter(e => e.event === 'decoy_hit')).toHaveLength(4);
                expect(demo.guard!.prometheusText()).toContain('agent_guard_trap_enabled 0\n');
            });
        });

        it('AC-21: 100 concurrent confirmed clients respect maxConcurrent=20 and leave the host healthy', async () => {
            let demo: Demo | undefined, maximum = 0;
            const c = trapConfig({ delay: { enabled: true, ms: 100, maxConcurrent: 20 }, block: { enabled: false }, rateLimit: { enabled: false } });
            c.onEvent = e => {
                if (e.event === 'decoy_hit' && demo) maximum = Math.max(maximum, Number(/^agent_guard_trap_delayed (\d+)$/m.exec(demo.guard!.prometheusText())![1]));
            };
            await using(c, async active => {
                demo = active;
                const token = tokenFrom((await snapshot(active, '/.env')).body);
                const clients = Array.from({ length: 100 }, (_, i) => ({ 'user-agent': `concurrent-confirmed-${i}` }));
                await Promise.all(clients.map(async headers => {
                    const replay = await fetch(active.url + '/', { headers: { ...headers, authorization: token } });
                    expect(replay.status).toBe(200);
                    await replay.text();
                }));
                const pending = clients.map(headers => snapshot(active, '/.env', headers));
                const start = performance.now();
                expect((await snapshot(active, '/')).status).toBe(200);
                expect(performance.now() - start).toBeLessThan(100);
                expect((await Promise.all(pending)).every(value => value.status === 200)).toBe(true);
                expect(maximum).toBe(20);
                expect(active.guard!.prometheusText()).toContain('agent_guard_trap_delayed 0\n');
                expect((await snapshot(active, '/')).status).toBe(200);
            });
        });
    });
}
