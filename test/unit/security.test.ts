import { validateHeaderValue } from 'node:http';
import * as crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAgentGuard, generateCanary, verifyCanary, verifyWebhookSignature } from '../../src/index.js';
import { signWebhook } from '../../src/alerts/webhook.js';
import { formatAlert } from '../../src/alerts/format.js';
import { secretEqual, sanitizeHeader } from '../../src/core/security.js';
import { boundRequest, DEFAULT_LIMITS, inspectionLimits, takeBytes } from '../../src/core/limits.js';
import { boundedUAPattern } from '../../src/core/ua-pattern.js';
import { Clients } from '../../src/core/inspect.js';
import { Registry } from '../../src/canary/registry.js';
import { scanRequest } from '../../src/canary/scan.js';
import { decoyHeaders } from '../../src/decoys/headers.js';
import { toRequest, type ParsedRequest } from '../../src/adapters/node.js';
import { LRU } from '../../src/core/lru.js';
import { CrawlerVerifier } from '../../src/crawler/verify.js';
import { Dispatcher } from '../../src/alerts/dispatcher.js';
import { Metrics } from '../../src/metrics.js';
import { config, event, request } from '../helpers.js';
import { generator } from '../helpers/prng.js';
import type { AgentGuardEvent, AlertPayload } from '../../src/types.js';

vi.mock('node:crypto', async importOriginal => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

function scanner(overrides: Parameters<typeof config>[0] = {}) {
    const c = config(overrides), registry = new Registry(c.canary.registry, c.canary.secret, c.canary.prefix ?? 'AG-CANARY-');
    return { c, registry, token: generateCanary({ secret: c.canary.secret }).token };
}

describe('timing-safe authentication', () => {
    it('compares equal-length buffers, including Unicode; mismatches never reach timingSafeEqual', () => {
        const compare = vi.mocked(crypto.timingSafeEqual);
        compare.mockClear();
        expect(secretEqual('é', 'ab')).toBe(false);
        expect(secretEqual('same', 'same')).toBe(true);
        expect(secretEqual('same', 'xame')).toBe(false);
        expect(secretEqual('same', 'samx')).toBe(false);
        expect(compare).toHaveBeenCalledTimes(4);
        for (const [a, b] of compare.mock.calls) {
            expect(Buffer.isBuffer(a)).toBe(true);
            expect(a.byteLength).toBe(b.byteLength);
        }
        expect(secretEqual('a', 'ab')).toBe(false);
        expect(compare).toHaveBeenCalledTimes(4);
    });
    it('authenticates checksums, registry matches and webhook signatures with the shared primitive', () => {
        const { registry, c } = scanner(), entry = registry.placement('test', 'test');
        const compare = vi.mocked(crypto.timingSafeEqual);
        compare.mockClear();
        expect(verifyCanary(entry.token, { secret: c.canary.secret }).valid).toBe(true);
        expect(registry.find(entry.token)).toBe(entry);
        const timestamp = String(Math.floor(Date.now() / 1000)), body = '{}', secret = 'secret';
        const signature = signWebhook(body, timestamp, secret);
        expect(verifyWebhookSignature({ body, timestamp, secret, signature })).toBe(true);
        expect(compare).toHaveBeenCalledTimes(3);
        for (const bad of [signature.slice(0, -1), signature + 'a', signature.replace(/.$/, signature.endsWith('0') ? '1' : '0')])
            expect(verifyWebhookSignature({ body, timestamp, secret, signature: bad })).toBe(false);
        expect(verifyWebhookSignature({ body, timestamp: '1'.repeat(100000), secret, signature })).toBe(false);
    });
    it('requires the entire allowlist credential and never authenticates a truncated prefix', async () => {
        const guard = createAgentGuard(config({ limits: { maxHeaderBytes: 15 }, allowlist: { headerToken: { name: 'x-key', value: 'allowed' } } }));
        expect((await guard.inspect(request('/.env', { headers: { 'x-key': 'allowed' } }))).action).toBe('pass');
        for (const value of ['allowex', 'xllowed', 'allowe', 'allowedx', 'allowed'.padEnd(100000, 'x')])
            expect((await guard.inspect(request('/.env', { headers: { 'x-key': value } }))).action).toBe('respond');
        await guard.close();
    });
});

describe('inspection limits', () => {
    it('has documented defaults and backwards-compatible body budget precedence', () => {
        expect(inspectionLimits()).toEqual(DEFAULT_LIMITS);
        expect(inspectionLimits({ limits: { maxUrlLength: undefined, maxHeaders: undefined } })).toEqual(DEFAULT_LIMITS);
        expect(inspectionLimits({ canaryScan: { maxBodyBytes: 7 } }).maxBodyBytes).toBe(7);
        expect(inspectionLimits({ canaryScan: { maxBodyBytes: 7 }, limits: { maxBodyBytes: 9 } }).maxBodyBytes).toBe(9);
        for (const value of [-1, Infinity, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1])
            expect(() => createAgentGuard(config({ limits: { maxUrlLength: value } }))).toThrow();
    });
    it('bounds header count, UTF-8 bytes, array values, names, and query entries', () => {
        const limits = { ...DEFAULT_LIMITS, maxHeaders: 2, maxHeaderBytes: 15, maxQueryParams: 2 };
        const req = boundRequest(request('/', { headers: { A: ['é', '中', 'beyond'], B: 'x', C: 'y' }, query: { a: ['1', '2', '3'], b: '4' } }), limits);
        expect(Object.keys(req.headers).length).toBeLessThanOrEqual(2);
        const bytes = Object.entries(req.headers).reduce((n, [k, v]) => n + Buffer.byteLength(k) + (Array.isArray(v) ? v : [v ?? '']).reduce((n, x) => n + Buffer.byteLength(x), 0), 0);
        expect(bytes).toBeLessThanOrEqual(15);
        expect(Object.values(req.query).flat()).toHaveLength(2);
        expect(takeBytes('é中😀', 4)).toBe('é');
        expect(takeBytes('é中😀', 5)).toBe('é中');
        expect(Object.keys(boundRequest(request('/', { headers: { ['x'.repeat(100000)]: 'value' } }), limits).headers)).toHaveLength(0);
    });
    it('never visits headers or query values beyond their count caps', () => {
        const headers = { first: 'ok' }, query = { first: 'ok' };
        Object.defineProperty(headers, 'second', { enumerable: true, get: () => { throw Error('over header limit'); } });
        Object.defineProperty(query, 'second', { enumerable: true, get: () => { throw Error('over query limit'); } });
        expect(() => boundRequest(request('/', { headers, query }), { ...DEFAULT_LIMITS, maxHeaders: 1, maxQueryParams: 1 })).not.toThrow();
    });
    it('caps URL parsing and repeated query parameters and handles malformed URLs/prototype keys', () => {
        const raw = (url: string): ParsedRequest => ({ url, headers: {}, socket: {} }) as ParsedRequest;
        expect(toRequest(raw('/?' + Array(1000).fill('a=1').join('&')), config({ limits: { maxQueryParams: 3 } })).query.a).toEqual(['1', '1', '1']);
        expect(toRequest(raw('/?__proto__=value&constructor=test')).query.__proto__).toBe('value');
        expect(toRequest(raw('http://[')).path).toBe('http://[');
        expect(toRequest(raw('/' + 'a'.repeat(100000))).query).toEqual({});
    });
    it('does not misroute truncated paths to a decoy, deny oversized inputs, or mutate host input', async () => {
        const guard = createAgentGuard(config({ limits: { maxUrlLength: 5 } }));
        const req = request('/.env' + 'a'.repeat(100000), { body: 'x'.repeat(100000), headers: { huge: 'x'.repeat(100000) } });
        expect((await guard.inspect(req)).action).toBe('pass');
        expect(req.path).toHaveLength(100005);
        await guard.close();
    });
    it('limits canary occurrences globally, counting invalid candidates and duplicates', () => {
        const { c, registry, token } = scanner({ limits: { maxCanaryCandidates: 2 } });
        const other = generateCanary({ secret: c.canary.secret }).token;
        expect(scanRequest(request('/', { headers: { a: token + ' ' + token, b: other } }), registry, c, false)).toHaveLength(1);
        expect(scanRequest(request('/AG-CANARY-bad/AG-CANARY-bad', { headers: { a: token } }), registry, c, false)).toEqual([]);
        expect(scanRequest(request('/' + token, { headers: { a: other } }), registry, { ...c, limits: { maxCanaryCandidates: 1 } }, false)).toHaveLength(1);
    });
    it('enforces every scan budget before processing late canaries', () => {
        const { c, registry, token } = scanner();
        for (const [req, limits] of [
            [request('/' + 'x'.repeat(40) + token), { maxUrlLength: 10 }],
            [request('/', { headers: { first: 'ok', late: token } }), { maxHeaders: 1 }],
            [request('/', { headers: { first: 'x'.repeat(50), late: token } }), { maxHeaderBytes: 20 }],
            [request('/', { query: { first: 'ok', late: token } }), { maxQueryParams: 1 }],
            [request('/', { query: { first: 'x'.repeat(50), late: token } }), { maxQueryBytes: 20 }],
            [request('/', { body: 'x'.repeat(50) + token }), { maxBodyBytes: 20 }],
            [request('/' + token), { maxCanaryCandidates: 0 }],
        ] as const) expect(scanRequest(req, registry, { ...c, limits }, true)).toEqual([]);
        expect(scanRequest(request('/', { body: Buffer.from(token) }), registry, c, true)).toHaveLength(1);
    });
    it('avoids JSON serialization, getters, cycles, excessive depth and traversal of huge bodies', () => {
        const { c, registry, token } = scanner();
        let accessed = false;
        const body = { token, toJSON: () => { throw Error('must not serialize'); }, get secret() { accessed = true; throw Error('must not read'); } };
        expect(scanRequest(request('/', { body }), registry, c, true)).toHaveLength(1);
        expect(accessed).toBe(false);
        const cycle: Record<string, unknown> = {}; cycle.self = cycle;
        let deep: unknown = token;
        for (let i = 0; i < 20000; i++) deep = { next: deep };
        for (const body of [cycle, deep, Array(100000).fill(null), 'x'.repeat(1000000)]) {
            const start = performance.now();
            expect(scanRequest(request('/', { body }), registry, c, true)).toEqual([]);
            expect(performance.now() - start).toBeLessThan(50);
        }
    });
    it('finds overlapping/suffix legacy tokens using bounded indexed matching', () => {
        const { c } = scanner();
        const canaries = ['abc', 'bc', 'c', 'abab', 'bab'].map((token, n) => ({ token, id: String(n), env: 'test', placement: 'test', createdAt: 'now' }));
        const registry = new Registry({ version: 1, prefix: 'AG-CANARY-', canaries }, c.canary.secret, 'AG-CANARY-');
        expect(scanRequest(request('/abc/abab'), registry, c, false).map(h => h.entry.token).sort()).toEqual(['abc', 'bc', 'c', 'abab', 'bab'].sort());
        expect([...registry.candidates('c'.repeat(100000), 2)]).toHaveLength(2);
    });
    it('skips unsafe configured UA regexes while preserving ordinary allowlist patterns', async () => {
        for (const pattern of [/(a+)+$/, /(a|aa)+$/, /a*a*$/, /(?=a)a+$/, /(a)\1+/]) expect(boundedUAPattern(pattern)).toBe(false);
        for (const pattern of [/curl/g, /^(curl|wget)/i, /^Mozilla\/.*/]) expect(boundedUAPattern(pattern)).toBe(true);
        const guard = createAgentGuard(config({ allowlist: { uaPatterns: [/(a+)+$/] } }));
        const start = performance.now();
        expect((await guard.inspect(request('/.env', { headers: { 'user-agent': 'a'.repeat(511) + '!' } }))).action).toBe('respond');
        expect(performance.now() - start).toBeLessThan(50);
        await guard.close();
    });
});

describe('header/event injection safety', () => {
    it('removes controls and caps values before response header reflection', () => {
        const headers = decoyHeaders('text/plain\r\nX-Evil:\x00yes' + 'a'.repeat(1000));
        for (const value of Object.values(headers)) {
            expect(value).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
            expect(value.length).toBeLessThanOrEqual(512);
        }
        for (const [name, value] of Object.entries(headers)) expect(() => validateHeaderValue(name, value)).not.toThrow();
        expect(sanitizeHeader('\r\n\0\t\x1b\x7f\x85\u2028\u2029')).toBe('');
    });
    it('sanitizes request metadata, imported canary IDs, logs, observers and alert payloads', async () => {
        const unsafe = 'bad\r\n\x1b' + 'x'.repeat(1000), logs: AgentGuardEvent[] = [], observed: AgentGuardEvent[] = [], sent: AlertPayload[] = [];
        const c = config({ project: unsafe, env: unsafe, log: { sink: e => logs.push(e) }, onEvent: e => observed.push(e), alerts: { adapters: [{ name: unsafe, send: async payload => { sent.push(payload); return { ok: true }; } }] } });
        const token = generateCanary({ secret: c.canary.secret }).token;
        c.canary.registry = { version: 1, prefix: 'AG-CANARY-', canaries: [{ id: unsafe, token, placement: unsafe, env: unsafe, createdAt: 'now' }] };
        const guard = createAgentGuard(c);
        const decision = await guard.inspect(request('/probe\r\n' + token, { method: 'G\r\nET', headers: { 'user-agent': unsafe }, query: { [unsafe]: 'value' }, ip: unsafe }));
        await guard.close();
        const check = (value: unknown): void => {
            if (typeof value === 'string') { expect(value).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/); expect(value.length).toBeLessThanOrEqual(512); }
            else if (Array.isArray(value)) value.forEach(check);
            else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => { check(k); check(v); });
        };
        expect(decision.events).toHaveLength(1);
        expect(sent).toHaveLength(1);
        for (const events of [decision.events, logs, observed, sent]) check(events);
        expect(formatAlert(event({ req: { method: unsafe, path: unsafe, client_key: unsafe } }), { deduped: 0, rate_limited: 0 }).event.req.path).toBe(sanitizeHeader(unsafe));
    });
});

describe('bounded state', () => {
    it('caps client and LRU entries and rejects non-finite/fractional capacities', () => {
        const clients = new Clients();
        for (let i = 0; i < 50010; i++) clients.set(String(i), 1, false, false);
        expect((clients as unknown as { entries: Map<string, number> }).entries.size).toBe(50000);
        expect(clients.get('0').score).toBe(0);
        const lru = new LRU<number, number>(10000);
        for (let i = 0; i < 10010; i++) lru.set(i, i, 10000);
        expect(lru.size).toBe(10000);
        expect(lru.get(0)).toBeUndefined();
        for (const n of [NaN, Infinity, 1.5]) expect(() => new LRU(n)).toThrow();
        const metrics = new Metrics();
        for (let i = 0; i < 3000; i++) metrics.request(i);
        expect((metrics as unknown as { samples: number[] }).samples).toHaveLength(2048);
    });
    it('caps pending DNS and keeps actual stalled DNS work bounded after timeouts', async () => {
        vi.useFakeTimers();
        const reverse = vi.fn(() => new Promise<string[]>(() => {}));
        const verifier = new CrawlerVerifier({ resolver: { reverse, resolve: async () => [] }, timeoutMs: 1 });
        const pending = Array.from({ length: 200 }, (_, i) => verifier.verify(String(i), 'google'));
        expect((verifier as unknown as { pending: Map<string, unknown> }).pending.size).toBe(128);
        expect(reverse).toHaveBeenCalledTimes(128);
        await vi.advanceTimersByTimeAsync(2);
        await Promise.all(pending);
        await Promise.all(Array.from({ length: 200 }, (_, i) => verifier.verify('new' + i, 'google')));
        expect(reverse).toHaveBeenCalledTimes(128);
    });
    it('caps crawler cache, alert dedupe, alert queue and concurrent deliveries', async () => {
        const verifier = new CrawlerVerifier({ verify: false });
        for (let i = 0; i < 10010; i++) await verifier.verify(String(i), 'google');
        expect((verifier as unknown as { cache: LRU<string, unknown> }).cache.size).toBe(10000);
        const releases: Array<() => void> = [];
        const dispatcher = new Dispatcher({ adapters: [{ name: 'test', send: () => new Promise(resolve => releases.push(() => resolve({ ok: true }))) }], ratePerMinute: 100000 }, () => {});
        for (let i = 0; i < 50010; i++) dispatcher.enqueue(event({ req: { method: 'GET', path: '/', client_key: String(i) } }));
        const state = dispatcher as unknown as { seen: LRU<string, boolean>; queue: unknown[]; active: Set<unknown> };
        expect(state.seen.size).toBe(50000);
        expect(state.queue.length).toBe(1024);
        await Promise.resolve();
        expect(state.active.size).toBe(8);
        const close = dispatcher.close();
        while (state.active.size || state.queue.length) {
            releases.splice(0).forEach(release => release());
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        }
        await close;
    });
});

describe('seeded property tests', () => {
    it('canary parser never throws, round-trips valid tokens and rejects checksum/ID mutations', () => {
        const random = generator(0xcafe0123);
        for (let i = 0; i < 1000; i++) {
            const secret = random.string(32) || 's', prefix = i % 2 ? 'ACME-CANARY-' : 'AG-CANARY-';
            expect(() => verifyCanary(random.string(1000), { secret, prefix })).not.toThrow();
            const { token, id } = generateCanary({ secret, prefix });
            expect(verifyCanary(token, { secret, prefix })).toEqual({ valid: true, id });
            const at = prefix.length + random.int(19), tampered = token.slice(0, at) + (token[at] === '0' ? '1' : '0') + token.slice(at + 1);
            expect(verifyCanary(tampered, { secret, prefix }).valid).toBe(false);
        }
        expect(verifyCanary('anything', { secret: 's', prefix: 'invalid' }).valid).toBe(false);
    });
    it('arbitrary methods/paths/headers/bodies produce valid decisions within 50ms', async () => {
        const random = generator(0x51ced), guard = createAgentGuard(config({ crawler: { verify: false } }));
        for (let i = 0; i < 500; i++) {
            const fields = (): Record<string, string | string[]> => Object.fromEntries(Array.from({ length: random.int(140) }, () => [random.string(30), random.int(2) ? random.string(700) : Array.from({ length: random.int(10) }, () => random.string(50))]));
            const req = request(i % 5 === 0 ? '/login' : '/' + random.string(10000), { method: random.string(100), headers: fields(), query: fields(), body: random.value() });
            const start = performance.now(), decision = await guard.inspect(req);
            expect(performance.now() - start).toBeLessThan(50);
            expect(['pass', 'respond']).toContain(decision.action);
            expect(Array.isArray(decision.events)).toBe(true);
            if (decision.action === 'respond') {
                expect(decision.response.status).toBeGreaterThanOrEqual(200);
                expect(typeof decision.response.body).toBe('string');
            }
        }
        await expect(guard.inspect(request('/', { headers: null as never }))).resolves.toEqual({ action: 'pass', events: [] });
        await guard.close();
    });
    it('sanitization is bounded, idempotent and removes every control character', () => {
        const random = generator(0x12345678);
        for (let i = 0; i < 2000; i++) {
            const source = random.string(2000), limit = random.int(700), cleaned = sanitizeHeader(source, limit);
            expect(cleaned.length).toBeLessThanOrEqual(limit);
            expect(cleaned).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/);
            expect(sanitizeHeader(cleaned, limit)).toBe(cleaned);
        }
    });
});
