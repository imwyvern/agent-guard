import { it, expect, vi } from 'vitest';
import { createAgentGuard, AgentGuardConfigError } from '../../src/index.js';
import { LRU } from '../../src/core/lru.js';
import { clientKey, inCidr, ipNumber, redactIp } from '../../src/core/client-key.js';
import { ulid, base32 } from '../../src/core/ulid.js';
import { fakeData } from '../../src/decoys/fake-data.js';
import { config, request, verifiedResolver, spoofResolver } from '../helpers.js';
import { htmlComment } from '../../src/lures/html-comment.js';
import { appendRobots } from '../../src/lures/robots.js';
it('LRU refreshes recency, bounds storage, expires TTL and rejects invalid capacity', () => {
    let now = 0;
    const lru = new LRU<string, number>(2, () => now);
    lru.set('a', 1, 10);
    lru.set('b', 2, 10);
    expect(lru.get('a')).toBe(1);
    lru.set('c', 3, 10);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.size).toBe(2);
    now = 10;
    expect(lru.get('a')).toBeUndefined();
    expect(() => new LRU(0)).toThrow();
});
it('client keys coarsen networks and support IPv4/IPv6 and CIDRs', () => {
    expect(clientKey('192.0.2.1', 'ua')).toBe(clientKey('192.0.2.200', 'ua'));
    expect(clientKey('192.0.2.1', 'ua')).not.toBe(clientKey('192.0.3.1', 'ua'));
    expect(clientKey('2001:db8:1::1', 'ua')).toBe(clientKey('2001:db8:1:9999::2', 'ua'));
    expect(clientKey('::ffff:192.0.2.1', 'ua')).toBe(clientKey('192.0.2.1', 'ua'));
    expect(ipNumber('2001:db8::192.0.2.1')?.bits).toBe(128);
    expect(ipNumber('bad')).toBeUndefined();
    expect(inCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(inCidr('192.0.2.1', '0.0.0.0/0')).toBe(true);
    for (const cidr of ['bad/24', '192.0.2.0/99', '192.0.2.0/-1', '192.0.2.0/1.5', '192.0.2.0', '::/0', '192.0.3.0/24'])
        expect(inCidr('192.0.2.1', cidr)).toBe(false);
    expect(redactIp('192.0.2.1')).toBe('192.0.2.x');
    expect(redactIp('2001:db8::1')).toContain('/48');
    expect(redactIp('bad')).toBe('unknown');
    expect(clientKey('bad', 'a')).toHaveLength(16);
});
it('preserves client history across quiet passes and changes in the memoized IP/UA', async () => {
    const guard = createAgentGuard(config());
    const browser = 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36';
    const headers = { 'User-Agent': browser };
    await guard.inspect(request('/robots.txt', { headers }));
    expect(await guard.inspect(request('/?x=1', { headers }))).toEqual({ action: 'pass', events: [] });
    await guard.inspect(request('/', { headers, ip: '198.51.100.2' }));
    const hit = await guard.inspect(request('/.env', { headers }));
    expect(hit.events[0]?.signals).toContain('robots_then_disallowed');
    expect(hit.events[0]?.req.client_key).toBe(clientKey('192.0.2.1', browser));
    expect(hit.events[0]?.req.ua_class).toBe('browser');
    const curl = await guard.inspect(request('/.env'));
    expect(curl.events[0]?.req.ua_class).toBe('automation');
    expect(curl.events[0]?.signals).not.toContain('robots_then_disallowed');
    expect(headers).toEqual({ 'User-Agent': browser });
    await guard.close();
});
it('ULID, deterministic fake data, bounded lures', () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(base32(new Uint8Array([255, 0]))).toBe('ZW00');
    expect(fakeData('seed')).toEqual(fakeData('seed'));
    expect(fakeData('seed')).not.toEqual(fakeData('different'));
    expect(fakeData('seed').loginDelay).toBeGreaterThanOrEqual(300);
    expect(fakeData('seed').loginDelay).toBeLessThanOrEqual(600);
    expect(Buffer.byteLength(htmlComment('/' + 'a'.repeat(200)))).toBeLessThanOrEqual(120);
    expect(appendRobots('original', [])).toBe('original\n\n');
    expect(appendRobots('original\n', ['Disallow: /.env'])).toContain('original\nDisallow');
});
it('validates detect-only configuration and unsafe fields', () => {
    for (const override of [{ mode: 'enforce' }, { project: '' }, { env: '' }, { projectSeed: '' }, { canary: { secret: '', registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } } }, { canary: { secret: 's', prefix: 'bad', registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } } }, { decoys: { siteName: 'real.example' } }, { decoys: { paths: { D1: 'relative' } } }, { decoys: { basePath: '<bad>' } }, { alerts: { adapters: [], ratePerMinute: -1 } }])
        expect(() => createAgentGuard(config(override as never))).toThrow(AgentGuardConfigError);
});
it('allowlists exact IP, CIDR, UA and header token; never trusts forwarded headers implicitly', async () => {
    for (const allowlist of [{ ips: ['192.0.2.1'] }, { cidrs: ['192.0.2.0/24'] }, { uaPatterns: [/curl/g] }, { headerToken: { name: 'X-Allow', value: 'allow' } }]) {
        const guard = createAgentGuard(config({ allowlist }));
        expect((await guard.inspect(request('/.env', { headers: { 'user-agent': 'curl/8', 'x-allow': 'allow' } }))).action).toBe('pass');
        await guard.close();
    }
    const g = createAgentGuard(config({ allowlist: { ips: ['10.0.0.1'] } }));
    expect((await g.inspect(request('/.env', { headers: { 'x-forwarded-for': '10.0.0.1' } }))).action).toBe('respond');
    await g.close();
    const trusted = createAgentGuard(config({ clientIp: () => '10.0.0.1', allowlist: { ips: ['10.0.0.1'] } }));
    expect((await trusted.inspect(request('/.env'))).action).toBe('pass');
    await trusted.close();
});
it('supports decoy overrides, disabled decoys, methods, body scan paths and lures', async () => {
    const g = createAgentGuard(config({ decoys: { enabled: ['D1', 'D3', 'D4', 'D5'], basePath: '/private', paths: { D1: ['/config/env'], D3: '/notes', D4: '/spec' }, siteName: 'demo.invalid' }, lures: { robots: 'manual', htmlComment: { paths: ['/login'] } } }));
    for (const path of ['/config/env', '/notes', '/spec']) {
        const d = await g.inspect(request(path));
        expect(d.action).toBe('respond');
        if (d.action === 'respond')
            expect(Buffer.byteLength(d.response.body)).toBeLessThanOrEqual(8192);
    }
    for (const path of ['/config/env', '/notes', '/spec'])
        expect((await g.inspect(request(path, { method: 'POST' }))).action).toBe('pass');
    expect((await g.inspect(request('/private/admin'))).action).toBe('pass');
    expect(g.robotsLines()).toContain('Disallow: /notes');
    expect(g.htmlCommentFor('/login')).toContain('/notes');
    expect(g.htmlCommentFor('/')).toBeNull();
    await g.close();
    const head = createAgentGuard(config());
    const d = await head.inspect(request('/.env', { method: 'HEAD' }));
    if (d.action === 'respond')
        expect(d.response.body).toBe('');
    await head.close();
});
it('logs probes, discovery and robot follow signals while preserving request behavior and privacy', async () => {
    const events: unknown[] = [];
    const g = createAgentGuard(config({ log: { sink: e => events.push(e), keepIp: false }, onEvent: () => { throw new Error('observer'); } }));
    expect((await g.inspect(request('/wp-admin'))).action).toBe('pass');
    expect((await g.inspect(request('/llms.txt'))).events[0]?.event).toBe('ai_discovery');
    await g.inspect(request('/robots.txt'));
    const hit = await g.inspect(request('/.env', { headers: { 'user-agent': 'curl/8.0', cookie: 'SECRET', authorization: 'SECRET' } }));
    expect(hit.events[0]?.signals).toContain('robots_then_disallowed');
    expect(JSON.stringify(events)).not.toContain('SECRET');
    expect(JSON.stringify(events)).not.toContain('192.0.2.1');
    expect(g.metrics().requests_inspected).toBe(4);
    expect(g.metrics().inspect_ns_p99).toBeGreaterThan(0);
    await g.close();
    await expect(g.inspect(request())).rejects.toThrow('closed');
});
it('expires client score/robot history and emits crawler/AI classifications', async () => {
    vi.useFakeTimers();
    const g = createAgentGuard(config());
    await g.inspect(request('/robots.txt'));
    vi.advanceTimersByTime(61000);
    expect((await g.inspect(request('/.env'))).events[0]?.signals).not.toContain('robots_then_disallowed');
    vi.advanceTimersByTime(1800000);
    expect((await g.inspect(request('/.env'))).events[0]?.score).toBe(60);
    await g.close();
    vi.useRealTimers();
    for (const [resolver, expected] of [[verifiedResolver, 'crawler_bypass'], [spoofResolver, 'decoy_hit']] as const) {
        const guard = createAgentGuard(config({ crawler: { resolver } }));
        expect((await guard.inspect(request('/.env', { headers: { 'user-agent': 'Googlebot' }, ip: '66.249.66.1' }))).events[0]?.event).toBe(expected);
        await guard.close();
    }
    const aiGuard = createAgentGuard(config());
    expect((await aiGuard.inspect(request('/.env', { headers: { 'user-agent': 'GPTBot' } }))).events[0]?.severity).toBe('info');
    await aiGuard.close();
});
it('isolates throwing log sinks', async () => { const g = createAgentGuard(config({ log: { sink: () => { throw Error('sink'); } } })); expect((await g.inspect(request('/.env'))).action).toBe('respond'); await g.close(); });
