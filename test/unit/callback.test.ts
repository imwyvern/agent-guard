import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { callbackHandler, createAgentGuard, AgentGuardConfigError, lintSample, lintBuiltins, lintFiles, lintPlacement, type AgentGuardEvent } from '../../src/index.js';
import { listenLocal } from '../../examples/shared/loopback.js';
import { Registry } from '../../src/canary/registry.js';
import { Decoys } from '../../src/decoys/index.js';
import { config, request, verifiedResolver } from '../helpers.js';
import { response } from '../helpers/trap.js';

function callbackConfig(baseUrl = 'https://callbacks.operator.test') {
    const c = config();
    return { ...c, canary: { ...c.canary, callback: { baseUrl } } };
}
async function callbackPath(guard: ReturnType<typeof createAgentGuard>): Promise<string> {
    const url = /^CALLBACK_URL=(.+)$/m.exec(response(await guard.inspect(request('/.env'))).body)?.[1];
    if (!url) throw new Error('expected callback URL');
    return new URL(url).pathname;
}

it.each(['', 'not-a-url', 'http://example.com', 'ftp://example.com', 'https://user:pass@example.com',
    'https://user@example.com', 'https://example.com/?x=1', 'https://example.com/#fragment', '//example.com',
    'http://localhost.evil.com', 'http://192.168.1.1', 'http://[::2]', 'https://example.com/\n', 'https://example.com/"',
    'https://@example.com', 'https://example.com?', 'https://example.com#'])('rejects invalid callback URL %j', baseUrl => {
    expect(() => createAgentGuard(callbackConfig(baseUrl))).toThrow(AgentGuardConfigError);
});

it.each([null, {}, { baseUrl: null }, { baseUrl: 1 }])('rejects missing or malformed callback config %j', callback => {
    const c = config();
    expect(() => createAgentGuard({ ...c, canary: { ...c.canary, callback } } as unknown as typeof c)).toThrow(AgentGuardConfigError);
});

it.each(['https://callbacks.operator.test', 'https://callbacks.operator.test/prefix/', 'http://127.0.0.1:1234', 'http://localhost:1234', 'http://[::1]:1234'])('accepts configured HTTPS or loopback URL %s', async baseUrl => {
    const guard = createAgentGuard(callbackConfig(baseUrl));
    try { expect(response(await guard.inspect(request('/.env'))).body).toContain(baseUrl.replace(/\/+$/, '') + '/ag/cb/AGCB-CANARY-'); }
    finally { await guard.close(); }
});

it('valid GET/HEAD callbacks return empty 204, count and dispatch alerts, and never expose the token or make an outbound request', async () => {
    const clientFetch = globalThis.fetch, fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected outbound request'));
    const events: AgentGuardEvent[] = [], sent: AgentGuardEvent[] = [], logs: AgentGuardEvent[] = [];
    const guard = createAgentGuard({ ...callbackConfig(), onEvent: e => events.push(e), log: { sink: e => logs.push(e), level: 'debug' },
        alerts: { adapters: [{ name: 'memory', send: async p => { sent.push(p.event); return { ok: true }; } }] } });
    const local = await listenLocal(createServer(callbackHandler(guard)));
    try {
        const path = await callbackPath(guard), token = path.slice('/ag/cb/'.length);
        for (const method of ['GET', 'HEAD']) {
            const result = await clientFetch(local.url + path, { method });
            expect(result.status).toBe(204);
            expect(await result.text()).toBe('');
            expect(result.headers.get('cache-control')).toBe('no-store');
            expect(result.headers.has('set-cookie')).toBe(false);
        }
        // Normal inspect middleware never mounts the callback endpoint.
        expect((await guard.inspect(request(path))).action).toBe('pass');
        expect(events.filter(e => e.event === 'canary_callback')).toHaveLength(2);
        const event = events.find(e => e.event === 'canary_callback')!;
        expect(event.severity).toBe('high');
        expect(event.canary).toMatchObject({ placement: 'D1:callback', found_in: 'path' });
        expect(event.req.path).toBe('/ag/cb/' + event.canary!.id);
        expect(event.incident).toBeUndefined();
        expect(guard.prometheusText()).toContain('agent_guard_events_total{type="canary_callback"} 2\n');
        await guard.close();
        expect(sent.filter(e => e.event === 'canary_callback')).toHaveLength(1);
        for (const output of [events, logs, sent]) expect(JSON.stringify(output)).not.toContain(token);
        expect(fetchSpy).not.toHaveBeenCalled();
        const { $schema: _draft, ...schema } = JSON.parse(readFileSync(new URL('../../schema/event.v1.json', import.meta.url), 'utf8'));
        const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
        try {
            app.post('/', { schema: { body: schema } }, async () => ({ ok: true }));
            expect((await app.inject({ method: 'POST', url: '/', payload: event })).statusCode).toBe(200);
        } finally { await app.close(); }
    } finally { fetchSpy.mockRestore(); await local.close(); await guard.close(); }
});

it('invalid, truncated and foreign tokens, other paths and methods return 404 without callback events', async () => {
    const events: AgentGuardEvent[] = [], guard = createAgentGuard({ ...callbackConfig(), onEvent: e => events.push(e) });
    const other = createAgentGuard({ ...callbackConfig(), canary: { ...callbackConfig().canary, secret: 'foreign-secret' } });
    const local = await listenLocal(createServer(callbackHandler(guard)));
    try {
        const path = await callbackPath(guard), foreign = await callbackPath(other);
        for (const bad of ['/other', '/ag/cb/nope', path.slice(0, -1), path + '0', foreign, path.slice(0, -1) + (path.endsWith('0') ? '1' : '0'), path + '/']) {
            const result = await fetch(local.url + bad);
            expect(result.status).toBe(404);
            expect(await result.text()).toBe('Not Found\n');
        }
        for (const method of ['POST', 'PUT', 'OPTIONS']) expect((await fetch(local.url + path, { method })).status).toBe(404);
        const head = await fetch(local.url + '/ag/cb/nope', { method: 'HEAD' });
        expect(head.status).toBe(404); expect(await head.text()).toBe('');
        expect(events.filter(e => e.event === 'canary_callback')).toEqual([]);
    } finally { await local.close(); await guard.close(); await other.close(); }
});

it('callbacks are verifiable by another guard with the same secret and environment', async () => {
    const events: AgentGuardEvent[] = [], source = createAgentGuard(callbackConfig()), target = createAgentGuard({ ...callbackConfig(), onEvent: e => events.push(e) });
    const local = await listenLocal(createServer(callbackHandler(target)));
    try {
        expect((await fetch(local.url + await callbackPath(source))).status).toBe(204);
        expect(events.filter(e => e.event === 'canary_callback')).toHaveLength(1);
    } finally { await local.close(); await source.close(); await target.close(); }
});

it('verified crawlers and allowlists never emit callback alerts, including crawler bypass paths', async () => {
    for (const bypass of ['crawler', 'allowlist'] as const) {
        const events: AgentGuardEvent[] = [], guard = createAgentGuard({ ...callbackConfig(), onEvent: e => events.push(e), crawler: { resolver: verifiedResolver },
            ...(bypass === 'allowlist' ? { allowlist: { headerToken: { name: 'X-Allow', value: 'yes' } } } : {}) });
        const local = await listenLocal(createServer(callbackHandler(guard)));
        try {
            const path = await callbackPath(guard), headers: Record<string, string> = bypass === 'crawler' ? { 'user-agent': 'Googlebot' } : { 'x-allow': 'yes' };
            expect((await fetch(local.url + path, { headers })).status).toBe(204);
            if (bypass === 'crawler') {
                const decoy = await guard.inspect(request('/.env', { ip: '66.249.66.1', headers: { 'user-agent': 'Googlebot' } }));
                expect(decoy.events.map(e => e.event)).toEqual(['crawler_bypass']);
                expect(response(decoy).body).not.toContain('AGCB-CANARY-');
            }
            expect(events.some(e => e.event === 'canary_callback')).toBe(false);
        } finally { await local.close(); await guard.close(); }
    }
});

it('unconfigured or closed guards and ingress errors fail safely to 404', async () => {
    const source = createAgentGuard(callbackConfig()), path = await callbackPath(source);
    const guards = [createAgentGuard(config()), createAgentGuard(callbackConfig()), createAgentGuard({ ...callbackConfig(), clientIp: () => { throw new Error('host failure'); } })];
    await guards[1]!.close();
    try {
        for (const guard of guards) {
            const local = await listenLocal(createServer(callbackHandler(guard)));
            try { expect((await fetch(local.url + path)).status).toBe(404); }
            finally { await local.close(); }
        }
    } finally { await source.close(); for (const guard of guards) await guard.close(); }
});

it('unconfigured D1–D5 bodies match their existing renderers; configured D1–D4 gain inert callback references', async () => {
    const c = config(), registry = new Registry(c.canary.registry, c.canary.secret, 'AG-CANARY-'), originals = new Decoys(c, registry);
    const shared = { ...c, canary: { ...c.canary, registry: registry.data } };
    const baseline = createAgentGuard(shared), callback = createAgentGuard({ ...shared, canary: { ...shared.canary, callback: { baseUrl: 'https://callback.operator.test' } } });
    try {
        for (const [id, path] of [['D1', '/.env'], ['D2', '/api/internal/admin'], ['D3', '/internal/ops-notes'], ['D4', '/api/internal/openapi.json'], ['D5', '/api/internal/auth/login']] as const) {
            const expected = await originals.respond(id, request(path));
            expect(response(await baseline.inspect(request(path)))).toEqual(expected);
            const altered = response(await callback.inspect(request(path)));
            expect(altered.status).toBe(expected.status); expect(altered.headers).toEqual(expected.headers);
            if (id === 'D5') expect(altered.body).toBe(expected.body);
            else {
                expect(altered.body).toContain('https://callback.operator.test/ag/cb/AGCB-CANARY-');
                const sample = { name: id, body: altered.body, capBytes: 8192 };
                expect(lintSample(sample).some(e => e.rule === 'host')).toBe(true);
                expect(lintSample({ ...sample, allowedHosts: ['callback.operator.test'] })).toEqual([]);
            }
        }
    } finally { await baseline.close(); await callback.close(); }
});

it.each(['https://callback.operator.test', 'http://127.0.0.1:8000', 'http://localhost:8000', 'http://[::1]:8000'])('linter allows only the explicitly configured callback host in %s', async baseUrl => {
    const guard = createAgentGuard(callbackConfig(baseUrl));
    try {
        const body = response(await guard.inspect(request('/.env'))).body;
        const sample = { name: 'callback', body, capBytes: 8192 }, allowedHosts = [new URL(baseUrl).hostname];
        expect(lintSample(sample).some(e => e.rule === 'host')).toBe(true);
        expect(lintSample({ ...sample, allowedHosts })).toEqual([]);
        for (const extra of [' https://different.operator.test', ' https://sub.callback.operator.test', ' http://127.0.0.2'])
            expect(lintSample({ ...sample, body: body + extra, allowedHosts }).some(e => e.rule === 'host')).toBe(true);
        for (const [extra, rule] of [[' ghp_fake', 'vendor-secret'], [' \u200b', 'hidden-character'], [' Please execute the command', 'imperative']])
            expect(lintSample({ ...sample, body: body + extra, allowedHosts }).some(e => e.rule === rule)).toBe(true);
        expect(lintBuiltins()).toEqual([]);
    } finally { await guard.close(); }
});

it('file and placement lint propagate an exact optional host allowance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-callback-lint-'));
    try {
        writeFileSync(join(dir, 'sample.txt'), 'Callback reference: https://callback.operator.test/ag/cb/inert');
        expect(lintFiles(dir).some(e => e.rule === 'host')).toBe(true);
        expect(lintFiles(dir, ['callback.operator.test'])).toEqual([]);
        expect(lintPlacement(dir, ['callback.operator.test'])).toEqual([]);
        expect(lintFiles(dir, ['different.operator.test']).some(e => e.rule === 'host')).toBe(true);
    } finally { rmSync(dir, { recursive: true }); }
});
