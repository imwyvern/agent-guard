import { afterEach, expect, it, vi } from 'vitest';
import { createAgentGuard, AgentGuardConfigError, lintSample, type AgentGuardConfig, type AgentGuardEvent } from '../../src/index.js';
import { Maze } from '../../src/core/maze.js';
import { config, request, verifiedResolver } from '../helpers.js';
import { confirm, response } from '../helpers/trap.js';
import { entryFrom, mazeConfig, mazeLinks } from '../helpers/maze.js';
import { browserUA } from '../../examples/shared/site.js';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';

afterEach(() => vi.unstubAllEnvs());

it.each([
    { maxDepth: -1 }, { maxDepth: 65 }, { maxDepth: .5 }, { maxPages: 0 }, { maxPages: NaN },
    { maxBytes: 0 }, { maxBytes: Infinity }, { maxDurationMs: 0 }, { maxDurationMs: 86400001 },
    { maxConcurrent: 0 }, { maxConcurrent: 8193 }, { bytesPerMinute: 0 }, { bytesPerMinute: .1 },
])('rejects invalid maze budgets %j', options => {
    expect(() => createAgentGuard(mazeConfig(options))).toThrow(AgentGuardConfigError);
});

it('AC-19: a single decoy and timing regularity alone never grant maze access', async () => {
    vi.useFakeTimers();
    const guard = createAgentGuard(mazeConfig()), headers = { 'user-agent': browserUA };
    try {
        for (let i = 0; i < 21; i++) { await guard.inspect(request('/', { headers })); vi.advanceTimersByTime(100); }
        const decoy = await guard.inspect(request('/.env', { headers }));
        expect(decoy.events[0]?.automation_score).toBe(1);
        expect(response(decoy).body).not.toContain('ARCHIVE_INDEX');
        const denied = await guard.inspect(request(new Maze(mazeConfig()).entry, { headers }));
        expect(response(denied)).toMatchObject({ status: 404, body: 'Not Found\n' });
        expect(denied.events).toEqual([]);
        expect(guard.prometheusText()).toContain('agent_guard_trap_maze_active 0\n');
    } finally { await guard.close(); }
});

it.each([
    { maxPages: 3 }, { maxDepth: 1 }, { maxBytes: 1 }, { maxDurationMs: 10 },
])('AC-20: budget %j stops every subsequent walk with one event', async options => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const events: AgentGuardEvent[] = [], sent: AgentGuardEvent[] = [];
    const guard = createAgentGuard({ ...mazeConfig(options), onEvent: e => events.push(e), alerts: { adapters: [{ name: 'local', send: async p => { sent.push(p.event); return { ok: true }; } }] } });
    try {
        await confirm(guard);
        const entry = entryFrom(response(await guard.inspect(request('/.env'))).body);
        let path = entry, successes = 0;
        for (let i = 0; i < 5; i++) {
            const page = response(await guard.inspect(request(path)));
            if (page.status === 404) break;
            successes++;
            path = mazeLinks(page.body)[0]!;
            if ('maxDurationMs' in options) vi.setSystemTime(Date.now() + 10);
        }
        expect(successes).toBe('maxPages' in options ? 3 : 'maxDepth' in options ? 2 : 'maxBytes' in options ? 0 : 1);
        for (const retry of [path, entry, entry]) expect(response(await guard.inspect(request(retry))).status).toBe(404);
        expect(events.filter(e => e.event === 'exhaust_budget_spent')).toHaveLength(1);
        expect(guard.prometheusText()).toContain('agent_guard_trap_maze_active 0\n');
        expect(guard.prometheusText()).toContain('agent_guard_events_total{type="exhaust_budget_spent"} 1\n');
        await guard.close();
        expect(sent.filter(e => e.event === 'exhaust_budget_spent')).toHaveLength(1);
    } finally { await guard.close(); }
});

it('AC-22: forged, tampered and truncated nodes do not admit sessions or spend the page budget', async () => {
    const guard = createAgentGuard(mazeConfig({ maxPages: 2 }));
    try {
        await confirm(guard);
        const path = entryFrom(response(await guard.inspect(request('/.env'))).body), prefix = '/api/internal/archive/';
        const other = new Maze({ ...mazeConfig(), canary: { ...config().canary, secret: 'different-secret' } }).entry;
        for (const bad of [prefix + 'A'.repeat(43), path.slice(0, -1), path + '0', path.slice(0, -1) + (path.endsWith('0') ? '1' : '0'), other,
            prefix + '01' + path.slice(prefix.length + 2), path + '/', prefix + '%00', prefix + 'x'.repeat(9000)]) {
            const result = await guard.inspect(request(bad));
            if (result.action === 'respond') expect(result.response).toMatchObject({ status: 404, body: 'Not Found\n' });
            expect(result.events.some(e => e.event === 'exhaust_budget_spent')).toBe(false);
            expect(guard.prometheusText()).toContain('agent_guard_trap_maze_active 0\n');
        }
        for (let i = 0; i < 2; i++) expect(response(await guard.inspect(request(path))).status).toBe(200);
        expect((await guard.inspect(request(path))).events.filter(e => e.event === 'exhaust_budget_spent')).toHaveLength(1);
    } finally { await guard.close(); }
});

it('AC-23: pages have ten relative nofollow links, safety headers, no external URLs and pass placement lint', async () => {
    const c = { ...mazeConfig(), decoys: { basePath: '/private/v2/' } }, guard = createAgentGuard(c);
    try {
        await confirm(guard);
        let path = entryFrom(response(await guard.inspect(request('/.env'))).body);
        expect(path).toMatch(/^\/private\/v2\/archive\/[0-9A-HJKMNP-TV-Z]{43}$/);
        expect(guard.robotsLines()).toContain('Disallow: /private/v2/archive/');
        for (let i = 0; i < 3; i++) {
            const page = response(await guard.inspect(request(path)));
            expect(page.status).toBe(200);
            expect(page.headers['X-Robots-Tag']).toContain('noindex');
            expect(page.headers['X-Robots-Tag']).toContain('nofollow');
            expect(page.headers['Cache-Control']).toBe('no-store');
            expect(Object.keys(page.headers).map(s => s.toLowerCase())).not.toContain('set-cookie');
            expect(page.body).not.toMatch(/https?:\/\//i);
            const links = mazeLinks(page.body);
            expect(links).toHaveLength(10);
            expect(new Set(links).size).toBe(10);
            expect(links.every(link => link.startsWith('/private/v2/archive/'))).toBe(true);
            expect(page.body.match(/rel="nofollow"/g)).toHaveLength(10);
            expect(lintSample({ name: 'maze', body: page.body, capBytes: 8192 })).toEqual([]);
            path = links[0]!;
        }
        expect(response(await guard.inspect(request(path, { method: 'HEAD' })))).toMatchObject({ status: 200, body: '' });
        expect(response(await guard.inspect(request(path, { method: 'POST' })))).toMatchObject({ status: 404 });
    } finally { await guard.close(); }
});

it('AC-21: global byte reservations span keys and reset after one minute, without reviving a spent session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const c = mazeConfig(), maze = new Maze(c), size = Buffer.byteLength(maze.respond(maze.entry, 'sizing').response.body);
    const guard = createAgentGuard(mazeConfig({ bytesPerMinute: size * 2 }));
    try {
        for (const ua of ['a', 'b', 'c', 'd']) await confirm(guard, { headers: { 'user-agent': ua } });
        const entry = entryFrom(response(await guard.inspect(request('/.env', { headers: { 'user-agent': 'a' } }))).body);
        for (const ua of ['a', 'b']) expect(response(await guard.inspect(request(entry, { headers: { 'user-agent': ua } }))).status).toBe(200);
        const third = await guard.inspect(request(entry, { headers: { 'user-agent': 'c' } }));
        expect(response(third).status).toBe(404);
        expect(third.events.filter(e => e.event === 'exhaust_budget_spent')).toHaveLength(1);
        vi.setSystemTime(Date.now() + 60_000);
        expect(response(await guard.inspect(request(entry, { headers: { 'user-agent': 'c' } }))).status).toBe(404);
        expect(response(await guard.inspect(request(entry, { headers: { 'user-agent': 'd' } }))).status).toBe(200);
    } finally { await guard.close(); }
});

it('expired active sessions free concurrency; spent records expire on a fixed window, never request recency', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const maze = new Maze(mazeConfig({ maxConcurrent: 1, maxDurationMs: 100 }));
    expect(maze.respond(maze.entry, 'a').response.status).toBe(200);
    expect(maze.respond(maze.entry, 'b').response.status).toBe(404);
    vi.setSystemTime(Date.now() + 100);
    expect(maze.size).toBe(0);
    expect(maze.respond(maze.entry, 'a').spent).toBe(true);
    expect(maze.respond(maze.entry, 'a').spent).toBe(false);
    expect(maze.respond(maze.entry, 'b').response.status).toBe(200);
    vi.setSystemTime(Date.now() + 30 * 60_000 + 100);
    expect(maze.respond(maze.entry, 'a').response.status).toBe(200);
});

it('verified crawlers and all allowlist types never enter a valid maze', async () => {
    const c = mazeConfig(), path = new Maze(c).entry;
    const guard = createAgentGuard({ ...c, crawler: { resolver: verifiedResolver } });
    try {
        await confirm(guard);
        const result = await guard.inspect(request(path, { ip: '66.249.66.1', headers: { 'user-agent': 'Googlebot' } }));
        expect(response(result)).toMatchObject({ status: 404, body: 'Not Found\n' });
        expect(result.events.map(e => e.event)).toEqual(['crawler_bypass']);
        expect(guard.prometheusText()).toContain('agent_guard_trap_maze_active 0\n');
    } finally { await guard.close(); }
    for (const allowlist of [{ ips: ['192.0.2.1'] }, { cidrs: ['192.0.2.0/24'] }, { uaPatterns: [/curl/] }, { headerToken: { name: 'X-Allow', value: 'yes' } }]) {
        const allowed = createAgentGuard({ ...c, allowlist });
        try { expect(await allowed.inspect(request(path, { headers: { 'user-agent': 'curl/8.0', 'x-allow': 'yes' } }))).toEqual({ action: 'pass', events: [] }); }
        finally { await allowed.close(); }
    }
});

it('an enabled block still wins on valid maze paths, while forged nodes remain 404 without maze spending', async () => {
    const c = mazeConfig();
    c.trap!.block = { enabled: true };
    const guard = createAgentGuard(c), entry = new Maze(c).entry;
    try {
        await confirm(guard);
        expect(response(await guard.inspect(request(entry))).status).toBe(403);
        const forged = await guard.inspect(request(entry + '0'));
        expect(response(forged).status).toBe(404);
        expect(forged.events).toEqual([]);
        expect(guard.prometheusText()).toContain('agent_guard_trap_maze_active 0\n');
    } finally { await guard.close(); }
});

it('configured D1–D4 combine entry and callback references; maze HTML remains entirely relative', async () => {
    const c = mazeConfig(), guard = createAgentGuard({ ...c, canary: { ...c.canary, callback: { baseUrl: 'https://callback.operator.test' } } });
    try {
        await confirm(guard);
        const entry = new Maze(c).entry;
        for (const path of ['/.env', '/api/internal/admin', '/internal/ops-notes', '/api/internal/openapi.json']) {
            const decoy = response(await guard.inspect(request(path)));
            expect(decoy.body).toContain(entry);
            expect(decoy.body).toContain('https://callback.operator.test/ag/cb/AGCB-CANARY-');
            expect(lintSample({ name: path, body: decoy.body, capBytes: 8192, allowedHosts: ['callback.operator.test'] })).toEqual([]);
        }
        const page = response(await guard.inspect(request(entry)));
        expect(page.status).toBe(200);
        expect(page.body).not.toMatch(/https?:\/\//i);
    } finally { await guard.close(); }
});

it('validates emitted exhaustion events against the strict schema without adding incident steps', async () => {
    const { $schema: _draft, ...schema } = JSON.parse(readFileSync(new URL('../../schema/event.v1.json', import.meta.url), 'utf8'));
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } }), guard = createAgentGuard(mazeConfig({ maxBytes: 1 }));
    app.post('/', { schema: { body: schema } }, async () => ({ ok: true }));
    try {
        await confirm(guard);
        const result = await guard.inspect(request(new Maze(mazeConfig()).entry));
        const event = result.events.find(e => e.event === 'exhaust_budget_spent')!;
        expect(event).toBeDefined(); expect(event.incident).toBeUndefined();
        expect((await app.inject({ method: 'POST', url: '/', payload: event })).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: '/', payload: { ...event, unexpected: true } })).statusCode).toBe(400);
    } finally { await app.close(); await guard.close(); }
});

it.each(['environment', 'manual', 'circuit'] as const)('%s immediately stops maze pages and reports zero active sessions', async kind => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const c: AgentGuardConfig = mazeConfig();
    if (kind === 'circuit') c.trap!.circuit = { inspectP99Ns: 1 };
    const guard = createAgentGuard(c);
    try {
        await confirm(guard);
        const path = entryFrom(response(await guard.inspect(request('/.env'))).body);
        expect(response(await guard.inspect(request(path))).status).toBe(200);
        expect(guard.prometheusText()).toContain('agent_guard_trap_maze_active 1\n');
        if (kind === 'environment') vi.stubEnv('AGENT_GUARD_TRAP', 'off');
        else if (kind === 'manual') guard.setTrapEnabled(false);
        else vi.setSystemTime(Date.now() + 251);
        const stopped = await guard.inspect(request(path));
        expect(response(stopped)).toMatchObject({ status: 404, body: 'Not Found\n' });
        expect(stopped.events.map(e => e.event)).toEqual(kind === 'circuit' ? ['trap_circuit_open'] : []);
        expect(guard.prometheusText()).toContain('agent_guard_trap_maze_active 0\n');
        expect(response(await guard.inspect(request('/.env'))).body).not.toContain('ARCHIVE_INDEX');
    } finally { await guard.close(); }
});
