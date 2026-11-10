import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startDemo, browserUA, realPaths, type Demo } from '../../examples/shared/site.js';
import { createAgentGuard, generateCanary, webhookAdapter, AgentGuardConfigError, type AgentGuardConfig, type AgentGuardEvent } from '../../src/index.js';
import { config, request, receiver, verifiedResolver, spoofResolver, decoyPaths } from '../helpers.js';
async function snapshot(demo: Demo, path: string, init?: RequestInit) { const r = await fetch(demo.url + path, { headers: { 'user-agent': browserUA }, ...init }); return { status: r.status, body: await r.text(), headers: Object.fromEntries([...r.headers].filter(([k]) => !['date', 'connection', 'keep-alive'].includes(k))) }; }
for (const kind of ['express', 'node'] as const)
    describe(`${kind} acceptance`, () => {
        async function using(overrides: Partial<AgentGuardConfig>, fn: (on: Demo, off: Demo, events: AgentGuardEvent[]) => Promise<void>) {
            const events: AgentGuardEvent[] = [], on = await startDemo(kind, config({ ...overrides, onEvent: e => events.push(e) })), off = await startDemo(kind, false);
            try {
                await fn(on, off, events);
            }
            finally {
                await on.close();
                await off.close();
            }
        }
        it('AC-1: 60 human requests, login success/failure/logout and resources equal off byte-for-byte; no alerts', async () => {
            await using({}, async (on, off, events) => {
                const paths = ['/', '/list', '/item/1', '/login', '/pricing', '/robots.txt', '/sitemap.xml', '/static/site.css'];
                for (let i = 0; i < 54; i++) {
                    const path = paths[i % paths.length]!;
                    expect(await snapshot(on, path)).toEqual(await snapshot(off, path));
                }
                for (const password of ['demo-password', 'wrong']) {
                    const init = { method: 'POST', headers: { 'user-agent': browserUA, 'content-type': 'application/json', cookie: 'demo_session=local-only' }, body: JSON.stringify({ email: 'demo@example.invalid', password }) };
                    expect(await snapshot(on, '/login', init)).toEqual(await snapshot(off, '/login', init));
                }
                for (let i = 0; i < 4; i++)
                    expect(await snapshot(on, '/logout', { method: 'POST' })).toEqual(await snapshot(off, '/logout', { method: 'POST' }));
                expect(events.filter(e => ['decoy_hit', 'canary_replay', 'alert_sent'].includes(e.event))).toHaveLength(0);
            });
        });
        it('AC-2: D1 token and D3 password replay alerts critical with provenance, signed delivery within 1s, real login unchanged', async () => {
            const r = await receiver();
            try {
                await using({ alerts: { adapters: [webhookAdapter({ url: r.url, secret: 'webhook-test-secret' })] } }, async (on, off, events) => {
                    const env = await (await fetch(on.url + '/.env')).text(), token = /ADMIN_API_TOKEN=(\S+)/.exec(env)![1]!;
                    const notes = await (await fetch(on.url + '/internal/ops-notes')).text(), password = /<dt>Password<\/dt><dd>([^<]+)/.exec(notes)![1]!;
                    const start = performance.now();
                    await fetch(on.url + '/api/internal/admin/users', { headers: { authorization: 'Bearer ' + token } });
                    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ops-admin@demo.invalid', password }) };
                    expect(await snapshot(on, '/login', init)).toEqual(await snapshot(off, '/login', init));
                    await fetch(on.url + '/api/internal/auth/login', init);
                    await on.guard!.close();
                    const replays = events.filter(e => e.event === 'canary_replay');
                    expect(replays).toHaveLength(3);
                expect(replays[0]?.canary).toMatchObject({ id: token.split('-')[2], placement: 'D1:/.env#ADMIN_API_TOKEN', found_in: 'header', field: 'authorization', env: 'demo' });
                for (const replay of replays.slice(1)) expect(replay.canary).toMatchObject({ id: password.split('-')[2], placement: 'D3:/internal/ops-notes#password', found_in: 'body', field: 'password', env: 'demo' });
                    for (const e of replays) {
                        expect(e.severity).toBe('critical');
                        expect(e.canary?.id).toHaveLength(12);
                        expect(e.canary?.placement).toMatch(/D[13]:/);
                        expect(['header', 'body']).toContain(e.canary?.found_in);
                    }
                    const alert = r.deliveries.find(d => d.payload.event.event === 'canary_replay');
                    expect(alert).toBeDefined();
                    expect(alert!.time - start).toBeLessThanOrEqual(1000);
                    expect(r.deliveries.every(d => d.valid)).toBe(true);
                });
            }
            finally {
                await r.close();
            }
        });
        it('AC-3: query, arbitrary header, nested JSON and form with custom prefix; tamper rejected', async () => {
            const prefix = 'ACME-CANARY-', secret = 'custom-secret';
            await using({ canary: { prefix, secret, registry: { version: 1, prefix, canaries: [] } } }, async (on, _off, events) => {
                const token = generateCanary({ prefix, secret }).token;
                for (const [path, init] of [['/?key=' + token, {}], ['/', { headers: { 'x-custom': token } }], ['/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deep: { value: token } }) }], ['/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + token }]] as Array<[
                    string,
                    RequestInit
                ]>)
                    await fetch(on.url + path, init);
                expect(events.filter(e => e.event === 'canary_replay').map(e => e.canary?.found_in)).toEqual(['query', 'header', 'body', 'body']);
                const invalid = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
                await fetch(on.url + '/?key=' + invalid);
                expect(events.filter(e => e.event === 'canary_replay')).toHaveLength(4);
            });
        });
        it('AC-4: verified Googlebot D1–D5 return native 404 with zero alerts', async () => {
            await using({ crawler: { resolver: verifiedResolver } }, async (on, off, events) => {
                for (const path of decoyPaths) {
                    const init = { headers: { 'user-agent': 'Googlebot' } };
                    expect(await snapshot(on, path, init)).toEqual(await snapshot(off, path, init));
                }
                expect(events.filter(e => e.event === 'crawler_bypass')).toHaveLength(5);
                expect(events.filter(e => e.event === 'decoy_hit' || e.event === 'alert_sent')).toHaveLength(0);
            });
        });
        it('AC-5: false crawler identity reaches decoys with ua_spoof_crawler and alert', async () => {
            const r = await receiver();
            try {
                await using({ crawler: { resolver: spoofResolver }, alerts: { adapters: [webhookAdapter({ url: r.url, secret: 'webhook-test-secret' })] } }, async (on, _off, events) => {
                    expect((await fetch(on.url + '/.env', { headers: { 'user-agent': 'Googlebot' } })).status).toBe(200);
                    await on.guard!.close();
                    expect(events.find(e => e.event === 'decoy_hit')?.signals).toContain('ua_spoof_crawler');
                    expect(r.deliveries).toHaveLength(1);
                });
            }
            finally {
                await r.close();
            }
        });
        it('AC-6: hung resolver fails open at 300ms in under 400ms', async () => {
            await using({ crawler: { resolver: { reverse: () => new Promise(() => { }), resolve: async () => [] } } }, async (on) => { const start = performance.now(), r = await fetch(on.url + '/.env', { headers: { 'user-agent': 'Googlebot' } }); expect(r.status).toBe(404); expect(performance.now() - start).toBeGreaterThanOrEqual(290); expect(performance.now() - start).toBeLessThan(400); });
        });
        it('AC-7: all decoys have noindex/no-store, HTML meta, no cookies and bounded bodies', async () => {
            await using({}, async (on) => { for (const path of decoyPaths) {
                const r = await fetch(on.url + path);
                expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive, nosnippet');
                expect(r.headers.get('cache-control')).toBe('no-store');
                expect(r.headers.has('set-cookie')).toBe(false);
                const text = await r.text();
                expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
                if (path === '/internal/ops-notes')
                    expect(text).toContain('<meta name="robots" content="noindex,nofollow,noarchive">');
            } });
        });
        it('AC-8: robots append preserves original; sitemap has only real routes', async () => {
            await using({ lures: { robots: 'append' } }, async (on, off) => { const original = await (await fetch(off.url + '/robots.txt')).text(), robots = await (await fetch(on.url + '/robots.txt')).text(); expect(robots.startsWith(original)).toBe(true); for (const p of decoyPaths)
                expect(robots.split('\n').some(line => line.startsWith('Disallow: ') && p.startsWith(line.slice(10)))).toBe(true); for (const p of realPaths)
                expect(robots).not.toContain('Disallow: ' + p + '\n'); const sitemap = await (await fetch(on.url + '/sitemap.xml')).text(); for (const p of decoyPaths)
                expect(sitemap).not.toContain(p); expect(sitemap).toBe(await (await fetch(off.url + '/sitemap.xml')).text()); });
        });
        it('AC-9: real pages are identical for browser, verified and spoofed crawler; lure remains invisible', async () => {
            for (const resolver of [verifiedResolver, spoofResolver])
                await using({ crawler: { resolver }, lures: { robots: 'append', htmlComment: { paths: ['/login'] } } }, async (on) => { for (const path of realPaths) {
                    const browser = await snapshot(on, path), crawler = await snapshot(on, path, { headers: { 'user-agent': 'Googlebot' } });
                    expect(crawler).toEqual(browser);
                    if (path === '/login') {
                        expect(browser.body).toContain('<!-- TODO(ops)');
                        expect(Buffer.byteLength(browser.body.split('<!--')[1]!) + 4).toBeLessThanOrEqual(120);
                    }
                } });
        });
        it('AC-10: ordinary inspect samples meet p50/p99 budgets; TCP and 50k-state gates run in bench', async () => {
            await using({}, async (on) => { for (let i = 0; i < 300; i++)
                await on.guard!.inspect(request('/')); const m = on.guard!.metrics(); expect(m.inspect_ns_p50 / 1e6).toBeLessThanOrEqual(.2); expect(m.inspect_ns_p99 / 1e6).toBeLessThanOrEqual(1); });
        });
        it('AC-11: outbound fetch is denied and every crawler DNS path uses injected resolver', async () => {
            await expect(async () => { await fetch('https://forbidden.invalid/'); }).rejects.toThrow('Outbound network forbidden');
            let lookups = 0;
            await using({ crawler: { resolver: { reverse: async () => { lookups++; return []; }, resolve: async () => { throw Error('must not forward invalid suffix'); } } } }, async (on) => { await fetch(on.url + '/'); expect(lookups).toBe(0); await fetch(on.url + '/.env', { headers: { 'user-agent': 'Googlebot' } }); expect(lookups).toBe(1); });
        });
        it('AC-12: invalid mode throws AgentGuardConfigError', () => { expect(() => createAgentGuard(config({ mode: 'trap' as 'detect' }))).toThrow(AgentGuardConfigError); });
        it('AC-13: hanging 30s-style receiver does not block decoy (<50ms), records failure', async () => {
            const r = await receiver([], true);
            try {
                await using({ alerts: { adapters: [webhookAdapter({ url: r.url, secret: 'webhook-test-secret', timeoutMs: 10 })] } }, async (on, _off, events) => { const start = performance.now(); await fetch(on.url + '/.env'); expect(performance.now() - start).toBeLessThan(50); await on.guard!.close(); expect(events.some(e => e.event === 'alert_failed')).toBe(true); });
            }
            finally {
                await r.close();
            }
        });
        it('AC-13: default webhook timeout keeps consecutive decoys and a normal page under 50ms while pending', async () => {
            const r = await receiver([], true);
            try {
                await using({ alerts: { adapters: [webhookAdapter({ url: r.url, secret: 'webhook-test-secret' })] } }, async (on, _off, events) => {
                    try {
                        for (const [index, path] of ['/.env', '/internal/ops-notes', '/'].entries()) {
                            const start = performance.now();
                            const response = await fetch(on.url + path);
                            await response.text();
                            expect(performance.now() - start).toBeLessThan(50);
                            expect(response.status).toBe(200);
                            await vi.waitFor(() => expect(r.deliveries).toHaveLength(Math.min(index + 1, 2)), { timeout: 1000, interval: 5 });
                            expect(events.filter(e => e.event === 'alert_sent' || e.event === 'alert_failed')).toHaveLength(0);
                        }
                    }
                    finally {
                        // Release the simulated >=30s hang; retries also fail immediately.
                        r.failPending();
                        await on.guard!.close();
                    }
                    expect(events.filter(e => e.event === 'alert_failed')).toHaveLength(2);
                });
            }
            finally {
                await r.close();
            }
        }, 5000);
        it('AC-14: 100 decoy hits produce one alert per client and the next delivery reports 99 deduplicated hits', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            const r = await receiver();
            try {
                await using({ alerts: { adapters: [webhookAdapter({ url: r.url, secret: 'webhook-test-secret' })] } }, async (on, _off, events) => {
                    for (let i = 0; i < 100; i++) await fetch(on.url + '/.env');
                    await vi.waitFor(() => expect(r.deliveries).toHaveLength(1));
                    expect(events.filter(e => e.event === 'decoy_hit')).toHaveLength(100);
                    expect(r.deliveries[0]?.payload.summary).toEqual({ deduped: 0, rate_limited: 0 });
                    // Expire the default 600s dedup window without faking HTTP/retry timers.
                    vi.setSystemTime(Date.now() + 600001);
                    await fetch(on.url + '/.env');
                    await on.guard!.close();
                    expect(r.deliveries).toHaveLength(2);
                    expect(r.deliveries[1]?.payload.summary).toEqual({ deduped: 99, rate_limited: 0 });
                    expect(r.deliveries.every(d => d.valid)).toBe(true);
                });
            }
            finally {
                await r.close();
                vi.useRealTimers();
            }
        });
        it('AC-15: built CLI scan exits nonzero with file:line; registry/templates whitelisted', () => {
            const dir = mkdtempSync(join(tmpdir(), 'ag-ac-'));
            const output = join(dir, 'cli-output.txt');
            const fd = openSync(output, 'w');
            const invoke = (args: string[]) => { const result = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd] }); return { ...result, stdout: readFileSync(output, 'utf8') }; };
            try {
                const token = generateCanary({ secret: 's' }).token;
                writeFileSync(join(dir, 'agent-guard.canaries.json'), token);
                mkdirSync(join(dir, 'src', 'decoys'), { recursive: true });
                writeFileSync(join(dir, 'src', 'decoys', 'template.ts'), token);
                let result = invoke(['dist/cli/main.js', 'canary', 'scan', dir, '--registry', join(dir, 'absent.json')]);
                expect(result.status).toBe(0);
                writeFileSync(join(dir, 'real.env'), 'hello\nSECRET=' + token);
                result = invoke(['dist/cli/main.js', 'canary', 'scan', dir, '--registry', join(dir, 'absent.json')]);
                expect(result.status).toBe(1);
                expect(result.stdout).toContain('real.env:2');
            }
            finally {
                closeSync(fd);
                rmSync(dir, { recursive: true });
            }
        });
    });
