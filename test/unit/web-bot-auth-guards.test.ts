import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createAgentGuard } from '../../src/core/inspect.js';
import { createWebGuard, memoryStore, type WebGuardConfig } from '../../src/web/index.js';
import { WebBotAuthVerifier } from '../../src/crawler/web-bot-auth.js';
import { Trap } from '../../src/core/trap.js';
import { WebTrap } from '../../src/web/trap.js';
import { checkNeutral, neutralBundles } from '../../scripts/check-neutral.js';
import type { AGDecision, AGRequest, AgentGuardEvent } from '../../src/types.js';
import type { WebBotAuthOptions } from '../../src/crawler/web-bot-auth-types.js';
import { agent, jsonResponse, now, signedRequest, testKey, trustedOptions, type FixtureOptions } from '../fixtures/web-bot-auth.js';
import { mazeEntry, quietCircuit, replayToken, webConfig } from '../helpers/web.js';

const engines = ['node', 'web'] as const;
type Engine = typeof engines[number];
const trap = { maze: { enabled: true, maxPages: 2 }, delay: { enabled: true, ms: 2000 },
    rateLimit: { enabled: true, capacity: 1, refillPerSec: 0 }, block: { enabled: true }, circuit: quietCircuit };
const paths = ['/.env', '/api/internal/admin', '/internal/ops-notes', '/api/internal/openapi.json', '/api/internal/auth/login', mazeEntry, '/ordinary'];
function agRequest(req: Request): AGRequest {
    const url = new URL(req.url);
    return { method: req.method, url: req.url, path: url.pathname, query: Object.fromEntries(url.searchParams),
        headers: { host: url.host, ...Object.fromEntries(req.headers) }, ip: '192.0.2.1' };
}
function unsigned(req: Request): Request {
    const headers = new Headers(req.headers);
    for (const name of ['signature', 'signature-input', 'signature-agent']) headers.delete(name);
    return new Request(req.url, { method: req.method, headers });
}
async function signed(path: string, options: FixtureOptions = {}, method = 'GET'): Promise<Request> {
    const req = await signedRequest({ url: 'https://origin.test' + path, ...options });
    const headers = new Headers(req.headers); headers.set('user-agent', 'curl/8.0');
    return new Request(req.url, { method, headers });
}
function harness(engine: Engine, webBotAuth?: WebBotAuthOptions, overrides: Partial<WebGuardConfig> = {}) {
    const c = webConfig({ crawler: { verify: false }, clientIp: () => '192.0.2.1', webBotAuth, ...overrides });
    const guard = engine === 'node' ? createAgentGuard(c) : createWebGuard({ ...c, store: memoryStore() });
    return { guard, inspect: (req: Request) => 'handle' in guard ? guard.inspect(req) : guard.inspect(agRequest(req)) };
}
function fields(event: AgentGuardEvent) {
    const { ts: _ts, event_id: _id, automation_score: _timing, incident, ...rest } = event;
    return { ...rest, ...(incident ? { incident: { sequence: incident.sequence, confidence: incident.confidence } } : {}) };
}
function comparable(decision: AGDecision, omitAuth = false, omitIncident = false) {
    return { ...decision, events: decision.events.map(e => {
        const event = fields(e);
        if (omitAuth) delete event.web_bot_auth;
        if (omitIncident) delete event.incident;
        return event;
    }) };
}
function freezeClock() { vi.spyOn(Date, 'now').mockReturnValue(now * 1000); }
function noDelay() {
    return [vi.spyOn(Trap.prototype, 'delay').mockResolvedValue(), vi.spyOn(WebTrap.prototype, 'delay').mockResolvedValue()];
}
async function prime(h: ReturnType<typeof harness>) {
    await h.inspect(new Request('https://origin.test/ordinary', { headers: { 'user-agent': 'curl/8.0', authorization: replayToken } }));
}
async function fetchedOptions(trusted = false) {
    const fetcher = vi.fn(async () => jsonResponse({ keys: [(await testKey()).key] }));
    const options: WebBotAuthOptions = { enabled: true, trustedAgents: trusted ? [{ url: agent }] : [], fetchKeys: { fetcher, allowHosts: ['agent.test'] } };
    return { options, fetcher };
}

describe.each(engines)('WBA-6 %s trust decisions', engine => {
    it.each(paths)('trusted signature bypasses all traps, including an existing block: %s', async path => {
        freezeClock(); const delays = noDelay(), h = harness(engine, await trustedOptions(), { mode: 'trap', trap });
        try {
            await prime(h); delays.forEach(delay => delay.mockClear());
            const req = await signed(path), decision = await h.inspect(req);
            expect(decision.action).toBe(path === '/ordinary' ? 'pass' : 'respond');
            if (decision.action === 'respond') expect(decision.response).toEqual({ status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not Found\n' });
            expect(decision.events).toHaveLength(1);
            expect(decision.events[0]).toMatchObject({ event: 'crawler_bypass', severity: 'debug', score: 0, signals: [], req: { ua_class: 'verified_crawler' },
                web_bot_auth: { agent_url: agent, keyid: (await testKey()).keyid, verified: true, trusted: true } });
            expect(Object.keys(decision.events[0]!.web_bot_auth!).sort()).toEqual(['agent_url', 'keyid', 'trusted', 'verified']);
            expect(JSON.stringify(decision.events)).not.toContain(req.headers.get('signature'));
            delays.forEach(delay => expect(delay).not.toHaveBeenCalled());
            const control = await h.inspect(unsigned(req));
            expect(control.action).toBe('respond');
            if (control.action === 'respond') expect(control.response.status).toBe(403);
            expect(control.events.some(event => event.event === 'trap_block')).toBe(true);
        } finally { await h.guard.close(); }
    });

    it.each(['GET', 'HEAD', 'POST'])('trusted signatures bypass D5 without login or trap delays (%s)', async method => {
        freezeClock(); const delays = noDelay(), h = harness(engine, await trustedOptions(), { mode: 'trap', trap });
        try {
            const decision = await h.inspect(await signed('/api/internal/auth/login', {}, method));
            expect(decision.action).toBe('respond');
            if (decision.action === 'respond') { expect(decision.response.status).toBe(404); expect(decision.response.body).toBe(method === 'HEAD' ? '' : 'Not Found\n'); }
            expect(decision.events.map(e => e.event)).toEqual(['crawler_bypass']);
            delays.forEach(delay => expect(delay).not.toHaveBeenCalled());
        } finally { await h.guard.close(); }
    });

    it.each([false, true])('untrusted verified signatures match unsigned decoy, maze, rate-limit and block behavior (block=%s)', async block => {
        freezeClock(); const delays = noDelay(), { options, fetcher } = await fetchedOptions();
        const overrides = { mode: 'trap' as const, trap: { ...trap, block: { enabled: block } } };
        const a = harness(engine, options, overrides), b = harness(engine, options, overrides);
        try {
            await prime(a); await prime(b);
            for (const path of ['/.env', '/.env', mazeEntry, mazeEntry, mazeEntry, '/ordinary']) {
                const req = await signed(path), actual = await a.inspect(req), expected = await b.inspect(unsigned(req));
                expect(comparable(actual, true)).toEqual(comparable(expected));
                for (const event of actual.events) expect(event.web_bot_auth).toEqual({ agent_url: agent, keyid: (await testKey()).keyid, verified: true, trusted: false });
                if (actual.action === 'respond' && actual.response.status === 200) expect(new Headers(actual.response.headers).get('x-robots-tag')).toContain('noindex');
                expect(actual.events.some(e => e.event === 'crawler_bypass')).toBe(false);
            }
            expect(fetcher).toHaveBeenCalledTimes(1);
            if (!block) expect(delays[engine === 'node' ? 0 : 1]).toHaveBeenCalledTimes(2);
        } finally { await a.guard.close(); await b.guard.close(); }
    });

    it.each([
        ['expired', { expires: now - 61 }], ['unsupported', { alg: 'ecdsa-p256-sha256' }],
        ['ignored', { tag: 'other' }], ['keyid_mismatch', { keyid: 'not-a-thumbprint' }],
        ['missing_coverage', { components: '"@authority"' }],
        ['created_in_future', { created: now + 61 }],
    ] as const)('%s is only observational on ordinary, probe and decoy paths', async (reason, options) => {
        freezeClock(); const a = harness(engine, await trustedOptions()), b = harness(engine);
        try {
            for (const path of ['/ordinary', '/wp-admin', '/.env']) {
                const req = await signed(path, options), actual = await a.inspect(req), expected = await b.inspect(unsigned(req));
                expect(comparable(actual, true)).toEqual(comparable(expected));
                actual.events.forEach(e => expect(e.web_bot_auth).toMatchObject({ verified: false, trusted: false, reason }));
                if (path === '/ordinary') expect(actual.events).toEqual([]);
            }
        } finally { await a.guard.close(); await b.guard.close(); }
    });

    it.each(['tampered', 'malformed', 'throw', 'unsupported-runtime'])('isolates %s verification failures without changing an existing trap decision', async failure => {
        freezeClock(); noDelay();
        const options = await trustedOptions(), req = await signed('/.env');
        if (failure === 'tampered') req.headers.set('signature', req.headers.get('signature')!.replace(/=:(.)/, (_all, c: string) => '=:' + (c === 'A' ? 'B' : 'A')));
        if (failure === 'malformed') req.headers.set('signature-input', '(');
        const a = harness(engine, options, { mode: 'trap', trap }), b = harness(engine, undefined, { mode: 'trap', trap });
        try {
            await prime(a); await prime(b);
            if (failure === 'throw') vi.spyOn(WebBotAuthVerifier.prototype, 'verify').mockRejectedValue(new Error('isolated failure'));
            if (failure === 'unsupported-runtime') vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(new DOMException('unavailable', 'NotSupportedError'));
            const actual = await a.inspect(req), expected = await b.inspect(unsigned(req));
            expect(comparable(actual, true)).toEqual(comparable(expected));
            const reason = failure === 'tampered' ? 'invalid_signature' : failure === 'unsupported-runtime' ? 'unsupported' : 'malformed';
            actual.events.forEach(e => expect(e.web_bot_auth).toMatchObject({ verified: false, trusted: false, reason }));
            expect(actual.events.map(e => e.event)).toContain('trap_block');
        } finally { await a.guard.close(); await b.guard.close(); }
    });

    it('reuses positive and negative discovery caches across requests in one guard', async () => {
        freezeClock(); const { options, fetcher } = await fetchedOptions(true), h = harness(engine, options);
        try {
            for (let i = 0; i < 3; i++) expect((await h.inspect(await signed('/.env'))).events[0]?.event).toBe('crawler_bypass');
            expect(fetcher).toHaveBeenCalledTimes(1);
        } finally { await h.guard.close(); }
        fetcher.mockClear(); fetcher.mockImplementation(async () => { throw new Error('discovery failed'); });
        const failed = harness(engine, options);
        try {
            for (let i = 0; i < 3; i++) expect((await failed.inspect(await signed('/.env'))).events[0]?.web_bot_auth?.reason).toBe('key_fetch_failed');
            expect(fetcher).toHaveBeenCalledTimes(1);
        } finally { await failed.guard.close(); }
    });

    it('does not interpret signature headers or fetch when config is absent or disabled', async () => {
        const verify = vi.spyOn(WebBotAuthVerifier.prototype, 'verify'), get = vi.spyOn(Headers.prototype, 'get');
        const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fetch'));
        const fetcher = vi.fn(async () => { throw new Error('unexpected discovery'); });
        for (const webBotAuth of [undefined, {}, { fetchKeys: { fetcher, allowHosts: ['agent.test'] } }, { enabled: false, fetchKeys: { fetcher, allowHosts: ['agent.test'] } }]) {
            const h = harness(engine, webBotAuth);
            try {
                const req = new Request('https://origin.test/.env', { headers: { 'Signature-Agent': 'malformed', 'Signature-Input': 'malformed', Signature: 'malformed' } });
                const decision = await h.inspect(req);
                expect(decision.events[0]?.event).toBe('decoy_hit');
                expect(decision.events.every(event => event.web_bot_auth === undefined)).toBe(true);
            } finally { await h.guard.close(); }
        }
        expect(verify).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(globalFetch).not.toHaveBeenCalled();
        expect(get.mock.calls.filter(([name]) => name.toLowerCase().startsWith('signature'))).toEqual([]);
    });
});

describe('WBA-7 Node/Web signed request differential', () => {
    it.each(['trusted', 'untrusted', 'expired', 'legacy', 'tampered'] as const)('makes identical %s decisions across decoy, maze and trap paths', async kind => {
        freezeClock(); noDelay();
        const options = kind === 'untrusted' ? (await fetchedOptions()).options : await trustedOptions();
        const overrides = { mode: 'trap' as const, trap }, a = harness('node', options, overrides), b = harness('web', options, overrides);
        try {
            await prime(a); await prime(b);
            for (const path of paths) {
                const req = await signed(path, { legacy: kind === 'legacy', ...(kind === 'expired' ? { expires: now - 61 } : {}) });
                if (kind === 'tampered') req.headers.set('signature-agent', 'sig1="https://agent.test/other.json"');
                const node = await a.inspect(req), web = await b.inspect(req);
                // Correlation metadata has existing runtime-specific details; compare request decisions and signature observations.
                expect(comparable(web, false, true)).toEqual(comparable(node, false, true));
            }
        } finally { await a.guard.close(); await b.guard.close(); }
    });
});

it('WBA-8 keeps the six built Web closures neutral and runtime dependencies empty', () => {
    expect(() => checkNeutral()).not.toThrow();
    for (const file of neutralBundles) {
        const source = readFileSync(new URL('../../dist/' + file, import.meta.url), 'utf8');
        if (file === 'web.js' || file === 'workers.js') expect(source).toContain('web_bot_auth');
        expect(source).not.toContain('node:');
    }
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
});
