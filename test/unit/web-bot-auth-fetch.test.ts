import { describe, expect, it, vi } from 'vitest';
import { WebBotAuthVerifier } from '../../src/crawler/web-bot-auth.js';
import { WebBotAuthKeys, agentUrl } from '../../src/crawler/web-bot-auth-keys.js';
import { memoryStore } from '../../src/state/store.js';
import { agent, now, signedRequest, testKey, trustedOptions, jsonResponse } from '../fixtures/web-bot-auth.js';
import type { WebBotAuthFetchOptions } from '../../src/crawler/web-bot-auth-types.js';

function globalFetchSpy() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('No global fetch allowed'); });
}
async function keySet() { return { keys: [(await testKey()).key] }; }

describe('WBA-5 default configuration never fetches', () => {
    it('does not even inspect headers when disabled, and never starts discovery on construction', async () => {
        const fetcher = vi.fn(async () => jsonResponse(await keySet())), globalFetch = globalFetchSpy();
        for (const enabled of [undefined, false]) {
            const verifier = new WebBotAuthVerifier({ enabled, fetchKeys: { fetcher, allowHosts: ['agent.test'] } });
            expect(await verifier.verify({ url: agent, method: 'GET', get headers(): Headers { throw new Error('Must not parse'); } })).toEqual({ verified: false, trusted: false, reason: 'disabled' });
        }
        new WebBotAuthVerifier({ enabled: true, fetchKeys: { fetcher, allowHosts: ['agent.test'] } });
        expect(fetcher).not.toHaveBeenCalled(); expect(globalFetch).not.toHaveBeenCalled();
    });
    it('uses only static keys unless a fetcher is provided', async () => {
        const globalFetch = globalFetchSpy(), req = await signedRequest();
        expect(await new WebBotAuthVerifier(await trustedOptions()).verify(req, now)).toMatchObject({ verified: true, trusted: true });
        expect(await new WebBotAuthVerifier({ enabled: true }).verify(req, now)).toMatchObject({ verified: false, reason: 'key_not_found' });
        expect(globalFetch).not.toHaveBeenCalled();
    });
    it('keeps static key material authoritative for its URL, without a fetch fallback', async () => {
        const { key } = await testKey(), fetcher = vi.fn(async () => jsonResponse(await keySet()));
        const verifier = new WebBotAuthVerifier({ enabled: true, trustedAgents: [{ url: agent, keys: { keys: [{ ...key, x: rfcX }] } }], fetchKeys: { fetcher, allowHosts: ['agent.test'] } });
        expect(await verifier.verify(await signedRequest(), now)).toMatchObject({ verified: false });
        expect(fetcher).not.toHaveBeenCalled();
    });
});
const rfcX = 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs';

describe('WBA-5 exact HTTPS URL restrictions', () => {
    it.each([
        ['https://agent.test/jwks', []], ['https://agent.test/jwks', ['other.test']],
        ['https://sub.agent.test/jwks', ['agent.test']], ['https://agent.test.evil.test/jwks', ['agent.test']],
        ['http://agent.test/jwks', ['agent.test']], ['https://user:pass@agent.test/jwks', ['agent.test']],
        ['https://@agent.test/jwks', ['agent.test']],
        ['https://agent.test:444/jwks', ['agent.test']], ['https://agent.test/jwks#fragment', ['agent.test']],
        ['https://agent.test/jwks#', ['agent.test']],
        ['https://agent.test/jwks', ['*.test']],
    ] as const)('rejects %s under host list %j without fetching', async (url, hosts) => {
        const fetcher = vi.fn(async () => jsonResponse(await keySet())), globalFetch = globalFetchSpy();
        const verifier = new WebBotAuthVerifier({ enabled: true, trustedAgents: [{ url: agent }], fetchKeys: { fetcher, allowHosts: [...hosts] } });
        expect(await verifier.verify(await signedRequest({ agent: url }), now)).toMatchObject({ verified: false, trusted: false });
        expect(fetcher).not.toHaveBeenCalled(); expect(globalFetch).not.toHaveBeenCalled();
    });
    it('accepts a default HTTPS port and exact hostname case folding', async () => {
        const fetcher = vi.fn(async (_url: string) => jsonResponse(await keySet())), globalFetch = globalFetchSpy();
        const verifier = new WebBotAuthVerifier({ ...await trustedOptions(), trustedAgents: [{ url: agent }], fetchKeys: { fetcher, allowHosts: ['AGENT.TEST'] } });
        expect(await verifier.verify(await signedRequest({ agent: 'https://agent.test:443/jwks.json' }), now)).toMatchObject({ verified: true, trusted: true });
        expect(fetcher.mock.calls[0]?.[0]).toBe(agent);
        expect(globalFetch).not.toHaveBeenCalled();
    });
    it.each(['not-a-url', 'https://agent.test\\@other.test', ' https://agent.test/', 'https://agent.test/\n', 'https://agent.test/' + 'x'.repeat(2048)])('rejects ambiguous or oversized URL %s', url => {
        expect(agentUrl(url)).toBeUndefined();
    });
});

describe('WBA-5 failure isolation and short negative caching', () => {
    it.each([
        ['redirect', () => new Response(null, { status: 302, headers: { Location: 'https://other.test/jwks' } })],
        ['not found', () => new Response(null, { status: 404 })],
        ['HTML', () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } })],
        ['no media type', () => new Response('{}')],
        ['malformed JSON', () => new Response('{', { headers: { 'Content-Type': 'application/json' } })],
        ['non-JWKS', () => jsonResponse({ arbitrary: [] })],
        ['empty JWKS', () => jsonResponse({ keys: [] })],
        ['symmetric JWKS', () => jsonResponse({ keys: [{ kty: 'oct', k: 'inert' }] })],
        ['incomplete JWKS', () => jsonResponse({ keys: [{ kty: 'OKP', crv: 'Ed25519' }] })],
        ['excess keys', () => jsonResponse({ keys: Array(65).fill({ kty: 'OKP', crv: 'Ed25519', x: rfcX }) })],
        ['declared oversize', () => jsonResponse({}, { 'Content-Length': '9999999' })],
        ['streamed oversize', () => new Response('x'.repeat(1100), { headers: { 'Content-Type': 'application/json' } })],
        ['fetch error', () => { throw new Error('fetch failed'); }],
        ['body error', () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('read error')); } }), { headers: { 'Content-Type': 'application/json' } })],
    ] as const)('rejects %s and caches the failure', async (_name, response) => {
        const req = await signedRequest(), fetcher = vi.fn(async () => response()), globalFetch = globalFetchSpy();
        const verifier = new WebBotAuthVerifier({ enabled: true, trustedAgents: [{ url: agent }], fetchKeys: { fetcher, allowHosts: ['agent.test'], maxBytes: 1024 } });
        for (let i = 0; i < 2; i++) expect(await verifier.verify(req, now)).toMatchObject({ verified: false, trusted: false, reason: 'key_fetch_failed' });
        expect(fetcher).toHaveBeenCalledTimes(1); expect(globalFetch).not.toHaveBeenCalled();
    });
    it.each(['redirected', 'different-url'])('rejects a fetcher that followed redirects (%s)', async kind => {
        const response = jsonResponse(await keySet());
        Object.defineProperty(response, kind === 'redirected' ? 'redirected' : 'url', { value: kind === 'redirected' ? true : 'https://other.test/jwks' });
        const fetcher = vi.fn(async () => response), resolver = new WebBotAuthKeys({ fetcher, allowHosts: ['agent.test'] });
        expect(await resolver.lookup(agent)).toBeNull(); expect(await resolver.lookup(agent)).toBeNull();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it.each(['fetch', 'body'])('aborts a stalled %s within the deadline, even if the fetcher ignores abort', async stalled => {
        const req = await signedRequest();
        vi.useFakeTimers();
        const cancelled = vi.fn();
        const fetcher = vi.fn((_url: string, _init: Parameters<WebBotAuthFetchOptions['fetcher']>[1]) => stalled === 'fetch' ? new Promise<Response>(() => {})
            : Promise.resolve(new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'Content-Type': 'application/json' } })));
        const verifier = new WebBotAuthVerifier({ enabled: true, fetchKeys: { fetcher, allowHosts: ['agent.test'], timeoutMs: 20 } });
        const work = verifier.verify(req, now);
        await vi.advanceTimersByTimeAsync(21);
        expect(await work).toMatchObject({ verified: false, reason: 'key_fetch_failed' });
        expect(fetcher.mock.calls[0]?.[1].signal.aborted).toBe(true);
        if (stalled === 'body') expect(cancelled).toHaveBeenCalledTimes(1);
        expect(await verifier.verify(req, now)).toMatchObject({ verified: false });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('caps the timeout at five seconds and negative TTL at thirty seconds', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn(() => new Promise<Response>(() => {}));
        const resolver = new WebBotAuthKeys({ fetcher, allowHosts: ['agent.test'], timeoutMs: 999999, maxTtlSeconds: 999999 });
        const pending = resolver.lookup(agent);
        await vi.advanceTimersByTimeAsync(5000);
        expect(await pending).toBeNull();
        expect(await resolver.lookup(agent)).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(30001);
        const retry = resolver.lookup(agent);
        await vi.advanceTimersByTimeAsync(5000);
        expect(await retry).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('caps stream bytes at 256 KiB, cancels the body, and does not trust Content-Length', async () => {
        const cancelled = vi.fn(), bytes = new TextEncoder().encode('x'.repeat(262145));
        const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(bytes); }, cancel: cancelled }), {
            headers: { 'Content-Type': 'application/json', 'Content-Length': '1' },
        }));
        const resolver = new WebBotAuthKeys({ fetcher, allowHosts: ['agent.test'], maxBytes: Number.MAX_SAFE_INTEGER });
        expect(await resolver.lookup(agent)).toBeNull(); expect(cancelled).toHaveBeenCalledTimes(1);
    });
});

describe('WBA-5 bounded positive/negative caches and concurrent discovery', () => {
    it('uses only the injected fetcher, manual redirects and an abort signal', async () => {
        const fetcher = vi.fn(async (_url: string, _init: Parameters<WebBotAuthFetchOptions['fetcher']>[1]) => jsonResponse(await keySet(), { 'Cache-Control': 'max-age=3600' }));
        const globalFetch = globalFetchSpy(), verifier = new WebBotAuthVerifier({ enabled: true, trustedAgents: [{ url: agent }], fetchKeys: { fetcher, allowHosts: ['agent.test'] } });
        const req = await signedRequest();
        for (let i = 0; i < 2; i++) expect(await verifier.verify(req, now)).toMatchObject({ verified: true, trusted: true });
        expect(fetcher).toHaveBeenCalledTimes(1); expect(globalFetch).not.toHaveBeenCalled();
        expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual', headers: { Accept: 'application/jwk-set+json, application/json, application/http-message-signatures-directory+json' } });
        expect(fetcher.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    });
    it.each([
        ['max-age=10', '3', undefined, 7000], ['max-age=3600', '0', 5, 5000],
        ['max-age=999999', '0', 999999, 86400000], ['no-cache', '0', undefined, 0],
        ['no-store', '0', undefined, 0], ['max-age=0', '0', undefined, 0],
    ] as const)('honors Cache-Control %s with Age %s and TTL cap %s', async (cacheControl, age, maxTtlSeconds, ttl) => {
        const jwks = await keySet();
        vi.useFakeTimers();
        const fetcher = vi.fn(async () => jsonResponse(jwks, { 'Cache-Control': cacheControl, Age: age }));
        const resolver = new WebBotAuthKeys({ fetcher, allowHosts: ['agent.test'], maxTtlSeconds });
        expect(await resolver.lookup(agent)).toEqual(jwks);
        if (ttl > 0) {
            await vi.advanceTimersByTimeAsync(ttl - 1);
            expect(await resolver.lookup(agent)).toEqual(jwks); expect(fetcher).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
        }
        expect(await resolver.lookup(agent)).toEqual(jwks); expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it.each([true, false])('evicts beyond 256 entries for positive=%s without renewing TTL', async positive => {
        const jwks = await keySet(), fetcher = vi.fn(async () => positive ? jsonResponse(jwks) : jsonResponse({ nope: true }));
        const resolver = new WebBotAuthKeys({ fetcher, allowHosts: ['agent.test'] });
        for (let i = 0; i < 257; i++) await resolver.lookup(agent + '?i=' + i);
        await resolver.lookup(agent + '?i=256'); expect(fetcher).toHaveBeenCalledTimes(257);
        await resolver.lookup(agent + '?i=0'); expect(fetcher).toHaveBeenCalledTimes(258);
    });
    it('shares pending requests, bounds concurrent lookups, and releases slots after timeout', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn(() => new Promise<Response>(() => {})), resolver = new WebBotAuthKeys({ fetcher, allowHosts: ['agent.test'], timeoutMs: 10 });
        const first = resolver.lookup(agent), same = resolver.lookup(agent);
        const others = Array.from({ length: 31 }, (_, i) => resolver.lookup(agent + '?i=' + i));
        expect(await resolver.lookup(agent + '?overflow')).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(32);
        await vi.advanceTimersByTimeAsync(10);
        expect(await Promise.all([first, same, ...others])).toEqual(Array(33).fill(null));
        const retry = resolver.lookup(agent + '?overflow');
        await vi.advanceTimersByTimeAsync(10);
        expect(await retry).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(33);
    });
    it('shares bounded TTL entries through an injected StateStore', async () => {
        const jwks = await keySet(), cache = memoryStore({ maxEntries: 4 });
        vi.useFakeTimers();
        const fetcher = vi.fn(async () => jsonResponse(jwks, { 'Cache-Control': 'max-age=2' })), set = vi.spyOn(cache, 'set');
        const options = { fetcher, allowHosts: ['agent.test'], cache };
        expect(await new WebBotAuthKeys(options).lookup(agent)).toEqual(jwks);
        expect(await new WebBotAuthKeys(options).lookup(agent)).toEqual(jwks); expect(fetcher).toHaveBeenCalledTimes(1);
        expect(set.mock.calls[0]?.[2]).toBeLessThanOrEqual(2000);
        await vi.advanceTimersByTimeAsync(2001);
        expect(await new WebBotAuthKeys(options).lookup(agent)).toEqual(jwks); expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('isolates store read/write failures and deadlines', async () => {
        const jwks = await keySet(), fetcher = vi.fn(async () => jsonResponse(jwks));
        const cache = { get() { throw new Error('get failed'); }, set() { throw new Error('set failed'); }, delete() {} };
        expect(await new WebBotAuthKeys({ fetcher, allowHosts: ['agent.test'], cache }).lookup(agent)).toEqual(jwks);
        vi.useFakeTimers();
        const hangingCache = { ...cache, get: () => new Promise<undefined>(() => {}) };
        const pending = new WebBotAuthKeys({ fetcher, allowHosts: ['agent.test'], cache: hangingCache, timeoutMs: 10 }).lookup(agent);
        await vi.advanceTimersByTimeAsync(10);
        expect(await pending).toBeNull();
    });
});
