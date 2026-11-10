import { it, expect, vi } from 'vitest';
import * as dns from 'node:dns/promises';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimedCrawler, classifyUA } from '../../src/crawler/ua.js';
import { CrawlerVerifier, defaultResolver } from '../../src/crawler/verify.js';
const browser = ['Mozilla/5.0', 'Chrome/130', 'Safari/15', 'Firefox/120', 'Edg/120', 'Mozilla/5.0 (iPhone)', 'Mozilla/5.0 (Android)'];
const automation = ['', 'curl/8', 'python-requests/2', 'python-httpx/1', 'node-fetch', 'axios/1', 'Go-http-client/1', 'HeadlessChrome/1', 'Wget/1', 'undici'];
const ai = ['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-Web', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'CCBot', 'Bytespider', 'Amazonbot', 'cohere-ai'];
const claims = [['Googlebot', 'google'], ['Google-InspectionTool', 'google'], ['GoogleOther', 'google'], ['bingbot', 'bing'], ['Applebot', 'apple'], ['DuckDuckBot', 'duckduckgo'], ['YandexBot', 'yandex'], ['Baiduspider', 'baidu']];
it.each([...browser.map(u => [u, 'browser']), ...automation.map(u => [u, 'automation']), ...ai.map(u => [u, 'declared_ai_crawler']), ['custom bot', 'unknown']])('classifies %s', (ua, expected) => expect(classifyUA(ua!)).toBe(expected));
it.each(claims)('recognizes %s', (ua, expected) => { expect(claimedCrawler(ua!)).toBe(expected); });
it('does not claim an arbitrary browser', () => expect(claimedCrawler('Mozilla/5.0')).toBeUndefined());
it('verifies boundary suffix, normalized IPv6, forward match and caches concurrent work', async () => {
    const resolver = { reverse: vi.fn(async () => ['bad.invalid', 'crawl.GOOGLEBOT.com.']), resolve: vi.fn(async () => ['2001:db8::1']) };
    const v = new CrawlerVerifier({ resolver });
    const [a, b] = await Promise.all([v.verify('2001:0db8:0:0:0:0:0:1', 'google'), v.verify('2001:0db8:0:0:0:0:0:1', 'google')]);
    expect(a.verified).toBe(true);
    expect(b).toEqual(a);
    expect(resolver.reverse).toHaveBeenCalledTimes(1);
    expect((await v.verify('2001:0db8:0:0:0:0:0:1', 'google')).cache).toBe(true);
    expect((await new CrawlerVerifier({ resolver: { reverse: async () => ['googlebot.com'], resolve: async () => ['192.0.2.1'] } }).verify('192.0.2.1', 'google')).verified).toBe(true);
});
it('rejects suffix forgery, empty PTR, wrong forward IP and invalid addresses', async () => {
    for (const [hosts, addresses, ip] of [[['evilgooglebot.com'], ['192.0.2.1'], '192.0.2.1'], [['googlebot.com.evil.invalid'], [], '192.0.2.1'], [[], [], '192.0.2.1'], [['crawler.googlebot.com'], ['192.0.2.2'], '192.0.2.1'], [['crawler.googlebot.com'], ['bad'], 'bad'], [['crawler.googlebot.com'], ['bad'], '192.0.2.1'], [['unknown.invalid'], ['192.0.2.1'], '192.0.2.1']] as const) {
        expect((await new CrawlerVerifier({ resolver: { reverse: async () => [...hosts], resolve: async () => [...addresses] } }).verify(ip, 'google')).verified).toBe(false);
    }
    expect((await new CrawlerVerifier({ resolver: { reverse: async () => ['a.extra.invalid'], resolve: async () => ['192.0.2.1'] }, extraSuffixes: { custom: ['extra.invalid'] } }).verify('192.0.2.1', 'custom')).verified).toBe(true);
    expect((await new CrawlerVerifier({ resolver: { reverse: async () => ['unknown.invalid'], resolve: async () => [] } }).verify('192.0.2.1', 'unknown')).verified).toBe(false);
});
it('times out fail-open, optionally fails closed, and handles resolver errors', async () => {
    for (const failOpen of [undefined, false]) {
        const v = new CrawlerVerifier({ timeoutMs: 5, failOpen, resolver: { reverse: () => new Promise(() => { }), resolve: async () => [] } });
        expect((await v.verify('192.0.2.1', 'google')).verified).toBe(failOpen ?? true);
    }
    expect((await new CrawlerVerifier({ resolver: { reverse: async () => { throw new Error('DNS'); }, resolve: async () => [] } }).verify('192.0.2.1', 'google')).verified).toBe(true);
    expect((await new CrawlerVerifier({ verify: false }).verify('192.0.2.1', 'google')).verified).toBe(false);
});
it('uses optional offline CIDRs and the default resolver without external DNS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-ip-'));
    try {
        const file = join(dir, 'ranges.json');
        writeFileSync(file, JSON.stringify({ google: ['192.0.2.0/24'] }));
        expect((await new CrawlerVerifier({ ipRangesFile: file }).verify('192.0.2.1', 'google')).verified).toBe(true);
    }
    finally {
        rmSync(dir, { recursive: true });
    }
    vi.mocked(dns.reverse).mockResolvedValueOnce(['crawl.googlebot.com']);
    vi.mocked(dns.resolve4).mockResolvedValueOnce(['192.0.2.1'] as never);
    vi.mocked(dns.resolve6).mockResolvedValueOnce([] as never);
    expect((await new CrawlerVerifier().verify('192.0.2.1', 'google')).verified).toBe(true);
    vi.mocked(dns.resolve4).mockResolvedValueOnce(['192.0.2.2'] as never);
    vi.mocked(dns.resolve6).mockRejectedValueOnce(new Error('no AAAA'));
    expect(await defaultResolver.resolve('local.invalid')).toEqual(['192.0.2.2']);
    vi.mocked(dns.reverse).mockRejectedValueOnce(new Error('offline'));
    expect((await new CrawlerVerifier().verify('192.0.2.1', 'google')).verified).toBe(true);
});
it('fails open when both forward address families report DNS errors', async () => {
    vi.mocked(dns.reverse).mockResolvedValueOnce(['crawl.googlebot.com']);
    vi.mocked(dns.resolve4).mockRejectedValueOnce(new Error('A unavailable'));
    vi.mocked(dns.resolve6).mockRejectedValueOnce(new Error('AAAA unavailable'));
    expect((await new CrawlerVerifier().verify('192.0.2.10', 'google')).verified).toBe(true);
});
