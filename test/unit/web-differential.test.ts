import { expect, it, vi } from 'vitest';
import { configIp } from '../../src/web/request.js';
import { createAgentGuard } from '../../src/core/inspect.js';
import { createWebGuard, memoryStore, type WebGuardConfig, type WebInspectContext } from '../../src/web/index.js';
import type { AGDecision, AGRequest, AgentGuardConfig, AgentGuardEvent } from '../../src/types.js';
import { request } from '../helpers.js';
import { response } from '../helpers/trap.js';
import { fixedRegistry, fixedToken, mazeEntry, prefix, quietCircuit, replayToken, secret, webConfig } from '../helpers/web.js';

const browser = { 'user-agent': 'Mozilla/5.0 Chrome/130.0' }, curl = { 'user-agent': 'curl/8.0' };
const replay = request('/', { headers: { ...curl, authorization: replayToken } });
const maze = { maze: { enabled: true, maxPages: 2 }, circuit: quietCircuit };
const bodyRead = vi.fn(() => { throw new Error('ordinary body was read'); });
const unreadBody = Object.defineProperty({}, 'password', { enumerable: true, get: bodyRead });
interface Fixture {
    name: string; req: AGRequest; action: AGDecision['action']; status?: number;
    events: AgentGuardEvent['event'][]; context?: WebInspectContext; options?: Partial<WebGuardConfig>;
    before?: readonly AGRequest[]; safeMaze?: boolean;
}
const f = (name: string, req: AGRequest, events: Fixture['events'] = [], status?: number, extra: Partial<Fixture> = {}): Fixture =>
    ({ name, req, action: status === undefined ? 'pass' : 'respond', status, events, ...extra });
// Frozen, named input table. Signals are compared as sets (sorted arrays); random IDs/timestamps are excluded.
const fixtures: readonly Fixture[] = Object.freeze([
    f('browser home', request('/', { headers: browser, body: unreadBody })),
    f('browser list', request('/list', { headers: browser, body: unreadBody })),
    f('browser item', request('/item/1', { headers: browser })),
    f('browser pricing', request('/pricing', { headers: browser })),
    f('browser static', request('/static/site.css', { headers: browser })),
    f('ordinary POST body stays unread', request('/', { method: 'POST', headers: browser, body: unreadBody })),
    f('D1 env', request('/.env'), ['decoy_hit'], 200),
    f('D1 local', request('/.env.local'), ['decoy_hit'], 200),
    f('D1 production', request('/.env.production'), ['decoy_hit'], 200),
    f('D1 backup', request('/.env.bak'), ['decoy_hit'], 200),
    f('D2 admin', request('/api/internal/admin'), ['decoy_hit'], 401),
    f('D2 child', request('/api/internal/admin/users'), ['decoy_hit'], 401),
    f('D2 bearer', request('/api/internal/admin', { headers: { ...curl, authorization: 'Bearer inert' } }), ['decoy_hit'], 403),
    f('D3 notes', request('/internal/ops-notes'), ['decoy_hit'], 200),
    f('D4 schema', request('/api/internal/openapi.json'), ['decoy_hit'], 200),
    f('D5 GET', request('/api/internal/auth/login'), ['decoy_hit'], 405),
    f('D5 POST', request('/api/internal/auth/login', { method: 'POST', body: 'password=ordinary' }), ['decoy_hit'], 401),
    f('HEAD decoy', request('/.env', { method: 'HEAD' }), ['decoy_hit'], 200),
    f('authorization replay', replay, ['canary_replay']),
    f('arbitrary header replay', request('/', { headers: { ...curl, 'x-api-key': replayToken } }), ['canary_replay']),
    f('query replay', request('/', { query: { key: replayToken } }), ['canary_replay']),
    f('path replay', request('/use/' + replayToken), ['canary_replay']),
    f('nested JSON replay', request('/login', { method: 'POST', body: { deep: { password: replayToken } } }), ['canary_replay']),
    f('form replay', request('/login', { method: 'POST', headers: { ...curl, 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + replayToken }), ['canary_replay']),
    f('custom prefix replay', request('/', { query: { key: fixedToken('0123456789AB', 'ACME-CANARY-') } }), ['canary_replay'], undefined,
        { options: { canary: { secret, prefix: 'ACME-CANARY-', registry: fixedRegistry('ACME-CANARY-') } } }),
    f('tampered checksum', request('/', { query: { key: replayToken.slice(0, -1) + 'X' } })),
    f('truncated token', request('/', { query: { key: replayToken.slice(0, -2) } })),
    f('wrong-secret token', request('/', { query: { key: fixedToken('0123456789AB', prefix, 'wrong-secret') } })),
    ...['Googlebot', 'bingbot'].flatMap(ua => [
        f(ua + ' home bypass', request('/', { headers: { 'user-agent': ua } }), ['crawler_bypass']),
        f(ua + ' decoy bypass', request('/.env', { headers: { 'user-agent': ua } }), ['crawler_bypass'], 404),
        f(ua + ' maze bypass', request(mazeEntry, { headers: { 'user-agent': ua } }), ['crawler_bypass'], 404, { options: { mode: 'trap', trap: maze } }),
    ]),
    f('custom verified crawler', request('/.env', { headers: { 'user-agent': 'Googlebot' } }), ['crawler_bypass'], 404,
        { options: { crawler: { verify: 'custom', customVerify: async () => true } } }),
    f('custom rejected crawler', request('/.env', { headers: { 'user-agent': 'Googlebot' } }), ['decoy_hit'], 200,
        { options: { crawler: { verify: 'custom', customVerify: async () => false } } }),
    f('custom rejected crawler replay', request('/', { headers: { 'user-agent': 'Googlebot', authorization: replayToken } }), ['canary_replay'], undefined,
        { options: { crawler: { verify: 'custom', customVerify: async () => false } } }),
    f('MCP decoy tool', request('/mcp', { method: 'POST' }), ['decoy_hit'], 200, { context: { mcp: { toolName: 'export_customer_records' } } }),
    f('MCP real tool', request('/mcp', { method: 'POST' }), [], undefined, { context: { mcp: { toolName: 'list_products' } } }),
    f('MCP arguments replay', request('/mcp', { method: 'POST', body: { token: replayToken } }), ['canary_replay'], undefined, { context: { mcp: { toolName: 'list_products' } } }),
    f('GQL decoy field', request('/graphql', { method: 'POST' }), ['decoy_hit'], 200, { context: { graphql: { fieldName: 'internalAdminUsers' } } }),
    f('GQL declared AI field', request('/graphql', { headers: { 'user-agent': 'GPTBot' } }), ['decoy_hit'], 200, { context: { graphql: { fieldName: 'internalAdminUsers' } } }),
    f('GQL real field', request('/graphql', { method: 'POST' }), [], undefined, { context: { graphql: { fieldName: 'products' } } }),
    f('GQL variables replay', request('/graphql', { method: 'POST', body: { variables: { token: replayToken } } }), ['canary_replay'], undefined, { context: { graphql: { fieldName: 'products' } } }),
    f('oversized URL', request('/' + 'a'.repeat(9000))),
    f('oversized header discards token', request('/', { headers: { ...browser, 'x-large': 'a'.repeat(17000), authorization: replayToken } })),
    f('many headers discard late token', request('/', { headers: { ...browser, ...Object.fromEntries(Array.from({ length: 110 }, (_, i) => ['x-' + i, 'a'])), authorization: replayToken } })),
    f('malformed path', request('/%ZZ/%E0%A4%A', { headers: browser })),
    f('empty UA', request('/', { headers: {} })),
    f('IPv6 decoy', request('/.env', { ip: '2001:db8::1' }), ['decoy_hit'], 200),
    f('IPv4 mapped decoy', request('/.env', { ip: '::ffff:192.0.2.1' }), ['decoy_hit'], 200),
    f('untrusted forwarded IP', request('/.env', { headers: { ...curl, 'x-forwarded-for': '198.51.100.1, 203.0.113.8' } }), ['decoy_hit'], 200),
    f('trusted rightmost forwarded IP', request('/.env', { headers: { ...curl, 'x-forwarded-for': '198.51.100.1, 203.0.113.8' } }), ['decoy_hit'], 200,
        { options: { ipHeader: 'x-forwarded-for' } }),
    f('allowlisted IP', request('/.env'), [], undefined, { options: { allowlist: { ips: ['192.0.2.1'] } } }),
    f('allowlisted UA', request('/.env'), [], undefined, { options: { allowlist: { uaPatterns: [/curl/] } } }),
    f('allowlisted header', request('/.env', { headers: { ...curl, 'x-allow': 'fixed-allow-token' } }), [], undefined,
        { options: { allowlist: { headerToken: { name: 'x-allow', value: 'fixed-allow-token' } } } }),
    f('trap unconfirmed env has no maze', request('/.env'), ['decoy_hit'], 200, { options: { mode: 'trap', trap: maze } }),
    f('trap unconfirmed valid maze', request(mazeEntry), [], 404, { options: { mode: 'trap', trap: maze } }),
    f('trap confirmed maze page', request(mazeEntry), [], 200, { options: { mode: 'trap', trap: maze }, before: [replay], safeMaze: true }),
    f('trap forged MAC preserves budget', request(mazeEntry), [], 200, { options: { mode: 'trap', trap: { ...maze, maze: { enabled: true, maxPages: 1 } } }, before: [replay, request(mazeEntry.slice(0, -1) + 'X')], safeMaze: true }),
    f('trap maze exhaustion', request(mazeEntry), ['exhaust_budget_spent'], 404, { options: { mode: 'trap', trap: { ...maze, maze: { enabled: true, maxPages: 1 } } }, before: [replay, request(mazeEntry)] }),
    f('trap replay blocks key', replay, ['canary_replay', 'trap_block'], 403, { options: { mode: 'trap', trap: { block: { enabled: true }, circuit: quietCircuit } } }),
    f('trap confirmed rate limit', request('/.env'), ['decoy_hit'], 429, { options: { mode: 'trap', trap: { rateLimit: { enabled: true, capacity: 1, refillPerSec: 0 }, circuit: quietCircuit } }, before: [replay, request('/.env')] }),
]);

function eventFields(e: AgentGuardEvent) {
    return { event: e.event, severity: e.severity, decoy: e.decoy, canary: e.canary && { id: e.canary.id, found_in: e.canary.found_in, field: e.canary.field, placement: e.canary.placement },
        crawler: e.crawler?.verified, signals: [...(e.signals ?? [])].sort(), client_key: e.req.client_key, ip: e.req.ip };
}
function headers(d: AGDecision) { return d.action === 'respond' ? Object.fromEntries([...new Headers(d.response.headers)].sort()) : undefined; }
it('contains at least forty frozen, uniquely named fixtures', () => {
    expect(Object.isFrozen(fixtures)).toBe(true); expect(fixtures.length).toBeGreaterThanOrEqual(40);
    expect(new Set(fixtures.map(f => f.name)).size).toBe(fixtures.length);
});
it.each(fixtures)('$name', async fixture => {
    const c = webConfig(fixture.options), node = createAgentGuard({ ...structuredCloneConfig(c), ...(c.ipHeader ? { clientIp: (req: AGRequest) => configIp(String(req.headers[c.ipHeader!.toLowerCase()] ?? ''), c.ipHeader!) } : {}) }), web = createWebGuard({ ...structuredCloneConfig(c), store: memoryStore() });
    try {
        for (const req of fixture.before ?? []) {
            const a = await node.inspect(req), b = await web.inspect(req);
            expect(b.action).toBe(a.action); expect(headers(b)).toEqual(headers(a));
            if (a.action === 'respond' && b.action === 'respond') { expect(b.response.status).toBe(a.response.status); expect(b.response.body).toBe(a.response.body); }
        }
        const a = await node.inspect(fixture.req, fixture.context), b = await web.inspect(fixture.req, fixture.context);
        for (const d of [a, b]) {
            expect(d.action).toBe(fixture.action); expect(d.events.map(e => e.event)).toEqual(fixture.events);
            if (fixture.status !== undefined) expect(response(d).status).toBe(fixture.status);
        }
        expect(b.events.map(eventFields)).toEqual(a.events.map(eventFields));
        if (fixture.name === 'trusted rightmost forwarded IP') expect(b.events[0]?.req.ip).toBe('203.0.113.8');
        if (fixture.name === 'untrusted forwarded IP') expect(b.events[0]?.req.ip).toBe('192.0.2.1');
        expect(headers(b)).toEqual(headers(a));
        if (a.action === 'respond' && b.action === 'respond') {
            expect(b.response.body).toBe(a.response.body);
            if (fixture.req.method === 'HEAD') expect(b.response.body).toBe('');
            if (fixture.safeMaze) {
                const h = new Headers(b.response.headers);
                expect(h.get('x-robots-tag')).toContain('noindex'); expect(h.get('cache-control')).toBe('no-store'); expect(h.has('set-cookie')).toBe(false);
                expect(b.response.body).not.toMatch(/https?:\/\//i); expect(Buffer.byteLength(b.response.body)).toBeLessThanOrEqual(8192);
            }
            if (fixture.name === 'trap unconfirmed env has no maze') expect(b.response.body).not.toContain('ARCHIVE_INDEX');
        }
        expect(bodyRead).not.toHaveBeenCalled();
    } finally { await node.close(); await web.close(); }
});
function structuredCloneConfig(c: AgentGuardConfig): AgentGuardConfig { return { ...c, canary: { ...c.canary, registry: structuredClone(c.canary.registry) } }; }

it('without store degrades incident, timing, block, rate limiting and maze admission with one warning per guard', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const web = createWebGuard(webConfig({ mode: 'trap', trap: { ...maze, block: { enabled: true }, rateLimit: { enabled: true, capacity: 1, refillPerSec: 0 } } }));
    try {
        for (let i = 0; i < 25; i++) {
            const d = await web.inspect(i % 2 ? replay : request('/.env'));
            if (d.action === 'respond') expect(d.response.status).toBe(200);
            for (const e of d.events) { expect(e.incident).toBeUndefined(); expect(e.automation_score).toBeUndefined(); }
        }
        expect(response(await web.inspect(request(mazeEntry))).status).toBe(404);
        expect(warn).toHaveBeenCalledTimes(1); expect(warn.mock.calls[0]![0]).toContain('StateStore');
    } finally { await web.close(); }
});

it.each([
    { path: '/mcp', context: { mcp: { toolName: 'export_customer_records' } } },
    { path: '/graphql', context: { graphql: { fieldName: 'internalAdminUsers' } } },
])('scans Request bodies with scenario context ($path)', async ({ path, context }) => {
    const c = webConfig({ clientIp: () => '192.0.2.1' }), node = createAgentGuard(structuredCloneConfig(c)), web = createWebGuard({ ...structuredCloneConfig(c), store: memoryStore() });
    const body = JSON.stringify({ token: replayToken });
    try {
        const a = await node.inspect(request(path, { method: 'POST', headers: curl, body }), context);
        const input = new Request('http://127.0.0.1' + path, { method: 'POST', headers: curl, body });
        const b = await web.inspect(input, context);
        expect(b.events.map(eventFields)).toEqual(a.events.map(eventFields));
        expect(response(b)).toEqual(response(a)); expect(input.bodyUsed).toBe(false);
        expect(b.events.map(e => e.event)).toEqual(['canary_replay', 'decoy_hit']);
    } finally { await node.close(); await web.close(); }
});
