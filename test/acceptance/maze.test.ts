import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDemo, type Demo } from '../../examples/shared/site.js';
import { lintSample, type AgentGuardConfig, type AgentGuardEvent } from '../../src/index.js';
import { Maze } from '../../src/core/maze.js';
import { tokenFrom } from '../helpers/trap.js';
import { entryFrom, mazeConfig, mazeLinks } from '../helpers/maze.js';
import { verifiedResolver } from '../helpers.js';

afterEach(() => vi.unstubAllEnvs());

async function get(demo: Demo, path: string, ua = 'maze-walker', method = 'GET') {
    const r = await fetch(demo.url + path, { method, headers: { 'user-agent': ua } });
    return { status: r.status, body: await r.text(), headers: r.headers };
}
async function seed(demo: Demo, ua = 'maze-walker') {
    const decoy = await get(demo, '/.env', ua);
    const r = await fetch(demo.url + '/', { headers: { 'user-agent': ua, authorization: tokenFrom(decoy.body) } });
    await r.text();
    return entryFrom((await get(demo, '/.env', ua)).body);
}

for (const runtime of ['express', 'node', 'hono', 'fastify', 'koa'] as const) describe(`${runtime} maze acceptance`, () => {
    async function using(c: AgentGuardConfig, fn: (demo: Demo, events: AgentGuardEvent[]) => Promise<void>) {
        const events: AgentGuardEvent[] = [], demo = await startDemo(runtime, { ...c, onEvent: e => events.push(e) });
        try { await fn(demo, events); } finally { await demo.close(); }
    }
    it('AC-19: a single /.env and unconfirmed entry traversal stay outside the maze', async () => {
        await using(mazeConfig(), async (demo, events) => {
            expect((await get(demo, '/.env')).body).not.toContain('ARCHIVE_INDEX');
            const entry = new Maze(mazeConfig()).entry;
            const missing = await get(demo, entry);
            expect(missing.status).toBe(404); expect(missing.body).toBe('Not Found\n');
            expect(events.map(e => e.event)).toEqual(['decoy_hit']);
            expect(demo.guard!.prometheusText()).toContain('agent_guard_trap_maze_active 0\n');
        });
    });
    it('AC-20/23: replay opens a safe bounded walk; exhaustion emits exactly once across retries', async () => {
        await using(mazeConfig({ maxPages: 3 }), async (demo, events) => {
            const entry = await seed(demo);
            let path = entry;
            for (let i = 0; i < 3; i++) {
                const page = await get(demo, path);
                expect(page.status).toBe(200);
                expect(page.headers.get('x-robots-tag')).toContain('noindex');
                expect(page.headers.get('x-robots-tag')).toContain('nofollow');
                expect(page.headers.get('cache-control')).toBe('no-store');
                expect(page.headers.has('set-cookie')).toBe(false);
                expect(page.body).not.toMatch(/https?:\/\//i);
                expect(lintSample({ name: runtime, body: page.body, capBytes: 8192 })).toEqual([]);
                const links = mazeLinks(page.body);
                expect(links).toHaveLength(10);
                expect(links.every(link => link.startsWith('/api/internal/archive/'))).toBe(true);
                expect(page.body.match(/rel="nofollow"/g)).toHaveLength(10);
                path = links[0]!;
            }
            for (const retry of [path, entry, path, entry]) {
                const missing = await get(demo, retry);
                expect(missing.status).toBe(404); expect(missing.body).toBe('Not Found\n');
            }
            expect(events.filter(e => e.event === 'exhaust_budget_spent')).toHaveLength(1);
            expect(demo.guard!.prometheusText()).toContain('agent_guard_trap_maze_active 0\n');
        });
    });
    it('AC-22: forged, tampered and truncated MACs preserve the valid session budget', async () => {
        await using(mazeConfig({ maxPages: 1 }), async (demo, events) => {
            const entry = await seed(demo);
            for (const path of [entry.slice(0, -1), entry + '0', entry.slice(0, -1) + (entry.endsWith('0') ? '1' : '0'), '/api/internal/archive/' + 'A'.repeat(43)]) {
                const missing = await get(demo, path);
                expect(missing.status).toBe(404); expect(missing.body).toBe('Not Found\n');
            }
            expect(events.filter(e => e.event === 'exhaust_budget_spent')).toEqual([]);
            expect(demo.guard!.prometheusText()).toContain('agent_guard_trap_maze_active 0\n');
            expect((await get(demo, entry, 'maze-walker', 'HEAD')).status).toBe(200);
            expect((await get(demo, entry)).status).toBe(404);
            expect(events.filter(e => e.event === 'exhaust_budget_spent')).toHaveLength(1);
        });
    });
    it('verified Googlebot and allowlisted clients see native 404 at valid entry paths', async () => {
        for (const bypass of ['crawler', 'allowlist'] as const) {
            const c = { ...mazeConfig(), crawler: { resolver: verifiedResolver }, ...(bypass === 'allowlist' ? { allowlist: { uaPatterns: [/allowed-bot/] } } : {}) };
            await using(c, async (demo, events) => {
                const entry = await seed(demo), native = await startDemo(runtime, false);
                try {
                    const ua = bypass === 'crawler' ? 'Googlebot' : 'allowed-bot';
                    const actual = await get(demo, entry, ua), expected = await get(native, entry, ua);
                    expect(actual.status).toBe(404); expect(actual.body).toBe(expected.body);
                    expect(actual.headers.get('content-type')).toBe(expected.headers.get('content-type'));
                    expect(events.filter(e => e.event === 'crawler_bypass')).toHaveLength(bypass === 'crawler' ? 1 : 0);
                    expect(events.filter(e => e.event === 'exhaust_budget_spent')).toEqual([]);
                    expect(demo.guard!.prometheusText()).toContain('agent_guard_trap_maze_active 0\n');
                } finally { await native.close(); }
            });
        }
    });
    it('AC-21: 100 confirmed walkers respect a global 20-session cap', async () => {
        await using(mazeConfig(), async (demo, events) => {
            const entry = await seed(demo), token = tokenFrom((await get(demo, '/.env')).body);
            const uas = Array.from({ length: 100 }, (_, i) => `maze-confirmed-${i}`);
            await Promise.all(uas.map(async ua => {
                const r = await fetch(demo.url + '/', { headers: { 'user-agent': ua, authorization: token } });
                await r.text();
            }));
            const pages = await Promise.all(uas.map(ua => get(demo, entry, ua)));
            expect(pages.filter(p => p.status === 200)).toHaveLength(20);
            expect(pages.filter(p => p.status === 404)).toHaveLength(80);
            expect(demo.guard!.prometheusText()).toContain('agent_guard_trap_maze_active 20\n');
            expect(events.filter(e => e.event === 'exhaust_budget_spent')).toEqual([]);
            expect((await get(demo, '/')).status).toBe(200);
        });
    });
    it('AC-21: a global byte cap rejects all pages that would exceed it', async () => {
        await using(mazeConfig({ bytesPerMinute: 1 }), async (demo, events) => {
            const entry = await seed(demo);
            for (let i = 0; i < 4; i++) expect((await get(demo, entry)).status).toBe(404);
            expect(events.filter(e => e.event === 'exhaust_budget_spent')).toHaveLength(1);
            expect(demo.guard!.prometheusText()).toContain('agent_guard_trap_maze_active 0\n');
        });
    });
    it('runtime switches and the maze-only circuit immediately stop generation', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        await using({ ...mazeConfig(), trap: { maze: { enabled: true }, circuit: { inspectP99Ns: 1 } } }, async (demo, events) => {
            const entry = await seed(demo);
            expect((await get(demo, entry)).status).toBe(200);
            vi.stubEnv('AGENT_GUARD_TRAP', 'off');
            expect((await get(demo, entry)).status).toBe(404);
            expect(demo.guard!.prometheusText()).toContain('agent_guard_trap_maze_active 0\n');
            vi.stubEnv('AGENT_GUARD_TRAP', 'on');
            demo.guard!.setTrapEnabled(false);
            expect((await get(demo, entry)).status).toBe(404);
            demo.guard!.setTrapEnabled(true);
            expect((await get(demo, entry)).status).toBe(200);
            vi.setSystemTime(Date.now() + 251);
            for (let i = 0; i < 3; i++) expect((await get(demo, entry)).status).toBe(404);
            expect(events.filter(e => e.event === 'trap_circuit_open')).toHaveLength(1);
            expect(events.filter(e => e.event === 'exhaust_budget_spent')).toEqual([]);
        });
    });
});
