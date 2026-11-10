import { createServer } from 'node:http';
import { startDemo, demoConfig, browserUA, realPaths } from '../examples/shared/site.js';
import { listenLocal, socketFallback } from '../examples/shared/loopback.js';
import { generateCanary, webhookAdapter, verifyWebhookSignature, type AlertPayload, type AgentGuardEvent } from '../src/index.js';
import { isMain, quantile, save, report } from './common.js';
const secret = 'offline-simulation-secret', webhookSecret = 'offline-webhook-secret';
export async function simulate() {
    const runs = [];
    for (const kind of ['express', 'node'] as const) {
        const arrivals = new Map<string, number>(), eventArrivals = new Map<string, number>(), latencies: number[] = [], alerts = new Set<string>();
        let invalidSignatures = 0;
        const receiver = createServer((req, res) => {
            let body = '';
            req.on('data', c => { body += String(c); });
            req.on('end', () => {
                if (!verifyWebhookSignature({ body, timestamp: String(req.headers['x-agentguard-timestamp']), signature: String(req.headers['x-agentguard-signature']), secret: webhookSecret }))
                    invalidSignatures++;
                const payload = JSON.parse(body) as AlertPayload;
                alerts.add(payload.event.req.ua!);
                latencies.push(performance.now() - (eventArrivals.get(payload.event.event_id) ?? performance.now()));
                res.end('ok');
            });
        });
        const local = await listenLocal(receiver);
        const detected = new Set<string>(), human = new Set<string>();
        let verifiedHits = 0, replays = 0, expectedReplays = 0, verified404 = 0;
        const onEvent = (e: AgentGuardEvent) => {
            if (['decoy_hit', 'canary_replay'].includes(e.event)) {
                detected.add(e.req.ua!);
                if (e.req.ua!.includes(' S1-'))
                    human.add(e.req.ua!);
                if (e.req.ua!.includes(' S2-'))
                    verifiedHits++;
                eventArrivals.set(e.event_id, arrivals.get(e.req.ua!)!);
            }
            if (e.event === 'canary_replay')
                replays++;
        };
        const resolver = { reverse: async (ip: string) => ip === '66.249.66.1' ? ['crawl.googlebot.com'] : ['untrusted.invalid'], resolve: async () => ['66.249.66.1'] };
        const demo = await startDemo(kind, demoConfig({ canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } }, clientIp: req => String(req.headers['x-simulation-ip'] ?? '192.0.2.1'), crawler: { resolver }, log: { sink: () => { } }, onEvent, lures: { robots: 'append', htmlComment: { paths: ['/login'] } }, alerts: { adapters: [webhookAdapter({ url: local.url, secret: webhookSecret })], ratePerMinute: 100000 } }));
        const sessions = { S1: 200, S2: 20, S3: 20, S4: 50, S5: 50 };
        const malicious: string[] = [];
        let requests = 0;
        let seed = 20261110;
        const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
        const send = async (ua: string, path: string, init: RequestInit = {}, ip = '192.0.2.1') => { arrivals.set(ua, performance.now()); requests++; return fetch(demo.url + path, { ...init, headers: { 'user-agent': ua, 'x-simulation-ip': ip, ...Object.fromEntries(new Headers(init.headers)) } }); };
        try {
            // Bounded concurrency preserves local request/alert timing without an unbounded queue.
            const tasks: Array<() => Promise<void>> = [];
            for (let i = 0; i < sessions.S1; i++)
                tasks.push(async () => {
                    const ua = browserUA + ` S1-${i}`, count = 20 + Math.floor(random() * 21);
                    for (let j = 0; j < count - 2; j++) {
                        const path = [...realPaths, '/static/site.css', '/robots.txt', '/sitemap.xml'][j % 8]!;
                        await send(ua, path, { headers: { cookie: 'demo_session=local-only', referer: '/list' } });
                        if (j === 4 || j === 5)
                            await send(ua, '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@example.invalid', password: j === 4 ? 'demo-password' : 'wrong' }) });
                        if (random() < .1)
                            await new Promise(r => setTimeout(r, 1));
                    }
                });
            for (const scenario of ['S2', 'S3'] as const)
                for (let i = 0; i < sessions[scenario]; i++)
                    tasks.push(async () => {
                        const ua = (scenario === 'S2' && i % 2 ? 'bingbot' : 'Googlebot') + ` ${scenario}-${i}`;
                        if (scenario === 'S3')
                            malicious.push(ua);
                        // Both Google and Bing use appropriate suffixes via a dedicated per-family PTR.
                        const ip = scenario === 'S2' ? '66.249.66.1' : '192.0.2.10';
                        for (const path of ['/robots.txt', '/sitemap.xml', ...realPaths, '/.env', '/api/internal/admin/users', '/internal/ops-notes', '/api/internal/openapi.json', '/api/internal/auth/login']) {
                            const response = await send(ua, path, {}, ip);
                            if (scenario === 'S2' && ['/.env', '/api/internal/admin/users', '/internal/ops-notes', '/api/internal/openapi.json', '/api/internal/auth/login'].includes(path)) {
                                if (response.status === 404)
                                    verified404++;
                                else
                                    verifiedHits++;
                            }
                        }
                    });
            for (let i = 0; i < sessions.S4; i++)
                tasks.push(async () => {
                    const ua = `curl/8.0 S4-${i}`;
                    malicious.push(ua);
                    const token = generateCanary({ secret }).token;
                    for (const [path, init] of [
                        ['/api/internal/admin/users', { headers: { authorization: 'Bearer ' + token } }], ['/?token=' + token, {}],
                        ['/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nested: { password: token } }) }],
                        ['/api/internal/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + token }],
                    ] as Array<[
                        string,
                        RequestInit
                    ]>) {
                        expectedReplays++;
                        await send(ua, path, init);
                    }
                });
            for (let i = 0; i < sessions.S5; i++)
                tasks.push(async () => {
                    const ua = ['python-httpx/1', 'node-fetch/3', browserUA][i % 3] + ` S5-${i}`;
                    malicious.push(ua);
                    await send(ua, '/robots.txt');
                    const env = await (await send(ua, '/.env')).text(), token = /ADMIN_API_TOKEN=(\S+)/.exec(env)![1]!;
                    await send(ua, '/api/internal/openapi.json');
                    expectedReplays++;
                    await send(ua, '/api/internal/admin/users', { headers: { authorization: 'Bearer ' + token } });
                    const notes = await (await send(ua, '/internal/ops-notes')).text(), password = /<dt>Password<\/dt><dd>([^<]+)/.exec(notes)![1]!;
                    for (const path of ['/api/internal/auth/login', '/login']) {
                        expectedReplays++;
                        await send(ua, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
                    }
                    await send(ua, '/llms.txt');
                    await send(ua, '/.well-known/mcp.json');
                });
            // Add Bing's official suffix to the injected fixture (no real DNS calls).
            resolver.reverse = async (ip: string) => ip === '66.249.66.1' ? ['crawl.googlebot.com', 'crawl.search.msn.com'] : ['untrusted.invalid'];
            await Promise.all(Array.from({ length: 8 }, async () => { let task; while ((task = tasks.shift()))
                await task(); }));
            await demo.guard!.close();
            const detection = malicious.filter(ua => detected.has(ua) && alerts.has(ua)).length / malicious.length;
            const result = { demo: kind, transport: socketFallback ? 'in-process HTTP (TCP unavailable: EPERM)' : '127.0.0.1 TCP', sessions, requests, humanFalsePositives: human.size, verifiedFalsePositives: verifiedHits, verified404, maliciousDetected: Math.round(detection * malicious.length), maliciousSessions: malicious.length, detectionRate: detection, replays, expectedReplays, replayDetection: replays / expectedReplays, invalidSignatures, alerts: latencies.length, alertLatencyMs: { p50: quantile(latencies, .5), p95: quantile(latencies, .95), p99: quantile(latencies, .99) } };
            runs.push(result);
        }
        finally {
            await demo.close();
            await local.close();
        }
    }
    const passed = runs.every(r => r.humanFalsePositives === 0 && r.verifiedFalsePositives === 0 && r.detectionRate === 1 && r.replayDetection === 1 && r.invalidSignatures === 0 && r.alertLatencyMs.p95 <= 250 && r.alertLatencyMs.p99 <= 1000);
    const result = { status: passed ? 'passed' : 'failed', runs };
    save('simulate', result);
    save('latest', result);
    return result;
}
if (isMain(import.meta.url)) {
    const result = await simulate();
    console.log(JSON.stringify(result, null, 2));
    report();
    if (result.status === 'failed')
        process.exitCode = 1;
}
