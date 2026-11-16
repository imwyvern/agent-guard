import { createServer, request, type RequestOptions, type Server } from 'node:http';
import { createServer as createHttpsServer, globalAgent as httpsAgent } from 'node:https';
import { connect } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentGuard } from '../../src/index.js';
import { createProxy } from '../../src/proxy/server.js';
import { proxyOptions, trustedClientIp } from '../../src/cli/proxy.js';
import type { AgentGuard, AgentGuardEvent } from '../../src/types.js';
import { config, request as agRequest } from '../helpers.js';
import { certificate, privateKey } from '../unit/smtp-tls-fixture.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(closers.splice(0).map(close => close())); });
async function listen(server: Server, port = 0): Promise<string> {
    server.listen(port, '127.0.0.1'); await once(server, 'listening');
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function close(server: Server): Promise<void> { return new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); }
async function proxy(upstream: string, overrides: Partial<Parameters<typeof createProxy>[0]> = {}) {
    const cfg = config({ crawler: { verify: 'ua-bypass' } }), guard = createAgentGuard(cfg);
    const instance = createProxy({ upstream, guard, config: cfg, ...overrides });
    const url = await listen(instance.server);
    closers.push(async () => { await instance.close(); await guard.close(); });
    return { ...instance, url, guard };
}
async function get(url: string, options: RequestOptions = {}, body?: Buffer): Promise<{ status: number; body: Buffer; headers: import('node:http').IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const req = request(url, { agent: false, ...options }, res => {
            const parts: Buffer[] = [];
            res.on('data', part => parts.push(part)); res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(parts), headers: res.headers }));
        });
        req.on('error', reject); req.end(body);
    });
}
it('DI-1: forwards 1000 GET/POST requests with binary bodies and chunked responses byte for byte', async () => {
    const upstream = createServer((req, res) => {
        const parts: Buffer[] = [];
        req.on('data', part => parts.push(part)); req.on('end', () => {
            res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/octet-stream', 'set-cookie': ['a=1', 'b=2'], 'x-upstream': 'unchanged' });
            res.write(Buffer.from(req.method + ' ' + req.url + '\n'));
            for (const part of parts) res.write(part);
            res.end(Buffer.from([0, 255, 128, 13, 10]));
        });
    });
    const direct = await listen(upstream); closers.push(() => close(upstream));
    const via = await proxy(direct);
    for (let batch = 0; batch < 40; batch++) await Promise.all(Array.from({ length: 25 }, async (_, index) => {
        const n = batch * 25 + index, method = n % 2 ? 'POST' : 'GET', path = `/ordinary/${n}?literal=%2f&x=a&x=b`;
        const body = method === 'POST' ? Buffer.from([n % 256, 0, 255, 127, 128]) : undefined;
        const options = { method, headers: { 'x-custom': 'unaltered', ...(body ? { 'content-length': body.length } : {}) } };
        const [expected, actual] = await Promise.all([get(direct + path, options, body), get(via.url + path, options, body)]);
        expect(actual.status).toBe(expected.status); expect(actual.body).toEqual(expected.body);
        expect(actual.headers['set-cookie']).toEqual(expected.headers['set-cookie']);
        expect(actual.headers['x-upstream']).toBe('unchanged');
    }));
}, 30000);
it('DI-2: returns 502 on outage, recovers on the same port, and returns 504 on timeout', async () => {
    const server = createServer((req, res) => { if (req.url !== '/hang') res.end('recovered'); });
    const direct = await listen(server), port = (server.address() as { port: number }).port;
    closers.push(() => close(server));
    const via = await proxy(direct, { timeoutMs: 80 });
    await close(server);
    expect((await get(via.url + '/')).status).toBe(502);
    await listen(server, port);
    expect((await get(via.url + '/')).body.toString()).toBe('recovered');
    expect((await get(via.url + '/hang')).status).toBe(504);
    expect((await get(via.url + '/')).status).toBe(200);
});
it.each(['throw', 'timeout'] as const)('DI-3: inspection %s fails open and records a sanitized error event', async kind => {
    const upstream = createServer((_req, res) => res.end('host'));
    const direct = await listen(upstream); closers.push(() => close(upstream));
    const errors: AgentGuardEvent[] = [];
    const guard = { inspect: () => kind === 'throw' ? Promise.reject(new Error('private detail')) : new Promise(() => {}) } as unknown as AgentGuard;
    const via = await proxy(direct, { guard, inspectTimeoutMs: 10, onError: event => errors.push(event) });
    expect((await get(via.url + '/')).body.toString()).toBe('host');
    expect(errors).toHaveLength(1); expect(errors[0]).toMatchObject({ event: 'alert_failed', alert: { channel: 'proxy' }, signals: ['proxy_inspect_error'] });
    expect(JSON.stringify(errors)).not.toContain('private detail');
});
it('DI-4: loopback is the default, public binding needs opt-in and emits a warning', () => {
    const args = ['--upstream', 'http://127.0.0.1:3000'];
    expect(proxyOptions(args).host).toBe('127.0.0.1');
    for (const address of ['0.0.0.0:8080', '[::]:8080', '192.0.2.2:8080']) {
        expect(() => proxyOptions([...args, '--listen', address])).toThrow('allow-public-bind');
        const warnings: string[] = [];
        proxyOptions([...args, '--listen', address, '--allow-public-bind'], s => warnings.push(s));
        expect(warnings.join('')).toContain('WARNING');
    }
    expect(() => proxyOptions([...args, '--mode', 'block'])).toThrow();
});
it.each(['file:///tmp/upstream', 'ftp://local.invalid', 'http://user:pass@local.invalid', 'http://local.invalid/path', 'http://local.invalid/?target=x'])('rejects unsafe upstream %s', async upstream => {
    await expect(proxy(upstream)).rejects.toThrow();
});
it('pins the upstream for Host, absolute URI, // paths and target query parameters', async () => {
    const seen: string[] = [];
    const upstream = createServer((req, res) => { seen.push(req.url!); res.end(String(req.headers.host)); });
    const direct = await listen(upstream); closers.push(() => close(upstream));
    const via = await proxy(direct);
    for (const path of ['http://192.0.2.1:1/absolute?q=1', '//192.0.2.1:1/path', '/?upstream=http://192.0.2.1:1']) {
        const response = await get(via.url, { path, headers: { host: 'attacker.invalid:9' } });
        expect(response.status).toBe(200); expect(response.body.toString()).toBe('attacker.invalid:9');
    }
    expect(seen).toEqual(['/absolute?q=1', '//192.0.2.1:1/path', '/?upstream=http://192.0.2.1:1']);
});
it('pins HTTPS TLS identity while preserving the incoming Host header', async () => {
    const priorCa = httpsAgent.options.ca;
    httpsAgent.options.ca = certificate;
    const upstream = createHttpsServer({ cert: certificate, key: privateKey }, (req, res) => res.end(String(req.headers.host)));
    try {
        const direct = await listen(upstream);
        const via = await proxy(direct.replace('http:', 'https:'));
        const response = await get(via.url, { headers: { host: 'attacker.invalid:9' } });
        expect(response.status).toBe(200); expect(response.body.toString()).toBe('attacker.invalid:9');
    } finally { httpsAgent.options.ca = priorCa; await close(upstream); }
});
it('rejects CONNECT and Upgrade without tunneling', async () => {
    const via = await proxy('http://127.0.0.1:1');
    for (const requestLine of ['CONNECT attacker.invalid:443 HTTP/1.1\r\nHost: attacker.invalid', 'GET / HTTP/1.1\r\nHost: attacker.invalid\r\nConnection: upgrade\r\nUpgrade: websocket']) {
        const url = new URL(via.url), socket = connect(Number(url.port), url.hostname);
        const parts: Buffer[] = []; socket.on('data', part => parts.push(Buffer.from(part)));
        socket.end(requestLine + '\r\n\r\n'); await once(socket, 'close');
        expect(Buffer.concat(parts).toString()).toContain('405 Method Not Allowed');
    }
});
it('removes hop-by-hop and Connection-nominated headers in both directions', async () => {
    const upstream = createServer((req, res) => {
        expect(req.headers['x-remove']).toBeUndefined();
        expect(req.headers['x-keep']).toBe('value');
        res.writeHead(202, { connection: 'x-remove-response', 'x-remove-response': 'hidden', 'x-keep-response': 'visible' }); res.end('ok');
    });
    const direct = await listen(upstream); closers.push(() => close(upstream));
    const via = await proxy(direct);
    const response = await get(via.url, { headers: { connection: 'x-remove', 'x-remove': 'hidden', 'x-keep': 'value' } });
    expect(response.status).toBe(202); expect(response.headers['x-remove-response']).toBeUndefined(); expect(response.headers['x-keep-response']).toBe('visible');
});
it('preserves the absence of the upstream Date header', async () => {
    const upstream = createServer((_req, res) => { res.sendDate = false; res.end('undated'); });
    const direct = await listen(upstream); closers.push(() => close(upstream));
    const via = await proxy(direct);
    expect((await get(direct)).headers.date).toBeUndefined();
    const response = await get(via.url);
    expect(response.body.toString()).toBe('undated'); expect(response.headers.date).toBeUndefined();
});
it('preserves OPTIONS asterisk targets and absolute URI path/query bytes', async () => {
    const upstream = createServer((req, res) => res.end(req.method + ' ' + req.url));
    const direct = await listen(upstream); closers.push(() => close(upstream));
    const via = await proxy(direct);
    expect((await get(via.url, { method: 'OPTIONS', path: '*' })).body.toString()).toBe('OPTIONS *');
    expect((await get(via.url, { path: 'http://attacker.invalid/a/../b?raw=%2f' })).body.toString()).toBe('GET /a/../b?raw=%2f');
});
it('streams an 8 MiB upload before EOF, bounds inspected bytes, and preserves all binary bytes', async () => {
    let received = 0, first!: () => void;
    const firstChunk = new Promise<void>(resolve => { first = resolve; });
    const upstream = createServer((req, res) => {
        req.on('data', (chunk: Buffer) => { received += chunk.length; first(); }); req.on('end', () => res.end(String(received)));
    });
    const direct = await listen(upstream); closers.push(() => close(upstream));
    const inspected: number[] = [];
    const guard = { inspect: async (req: { body: string }) => { inspected.push(Buffer.byteLength(req.body)); return { action: 'pass', events: [] }; } } as unknown as AgentGuard;
    const via = await proxy(direct, { guard });
    const response = new Promise<string>((resolve, reject) => {
        const req = request(via.url + '/login', { method: 'POST' }, res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve(body)); });
        req.on('error', reject);
        void (async () => {
            const chunk = Buffer.alloc(65536, 42);
            req.write(chunk); await firstChunk; // Full buffering would deadlock here.
            for (let i = 1; i < 128; i++) if (!req.write(chunk)) await once(req, 'drain');
            req.end();
        })().catch(reject);
    });
    expect(await response).toBe(String(8 * 1024 * 1024)); expect(inspected).toEqual([16384]);
});
it('kill switch bypasses inspection and decoy responses; normal decoys retain noindex', async () => {
    const events: AgentGuardEvent[] = [];
    const cfg = config({ onEvent: event => events.push(event) });
    const upstream = createServer((_req, res) => res.end('host'));
    const direct = await listen(upstream); closers.push(() => close(upstream));
    const via = await proxy(direct, { config: cfg });
    const decoy = await get(via.url + '/.env');
    expect(decoy.headers['x-robots-tag']).toContain('noindex'); expect(decoy.body.toString()).toContain('AG-CANARY-');
    const inspect = vi.spyOn(via.guard, 'inspect');
    vi.stubEnv('AGENT_GUARD', 'off');
    expect((await get(via.url + '/.env')).body.toString()).toBe('host'); expect(inspect).not.toHaveBeenCalled();
});
it('reuses D5, MCP and GraphQL decoy responses with noindex', async () => {
    const via = await proxy('http://127.0.0.1:1');
    const requests = [
        { path: '/api/internal/auth/login', body: {} },
        { path: '/mcp', body: { method: 'tools/call', params: { name: 'export_customer_records' } } },
        { path: '/graphql', body: { query: '{ internalAdminUsers { id } }' } },
    ];
    for (const item of requests) {
        const response = await get(via.url + item.path, { method: 'POST', headers: { 'content-type': 'application/json' } }, Buffer.from(JSON.stringify(item.body)));
        expect(response.status).not.toBe(502); expect(response.headers['x-robots-tag']).toContain('noindex');
    }
});
it('trusts forwarded addresses only when every walked proxy hop is trusted', () => {
    const req = agRequest('/', { ip: '127.0.0.1', headers: { 'x-forwarded-for': '192.0.2.1, 10.0.0.1' } });
    expect(trustedClientIp([], req)).toBe('127.0.0.1');
    expect(trustedClientIp(['127.0.0.0/8'], req)).toBe('10.0.0.1');
    expect(trustedClientIp(['127.0.0.0/8', '10.0.0.0/8'], req)).toBe('192.0.2.1');
});
it('DI-5 and CLI smoke: generates private secrets without printing/overwriting them, serves traffic, and exits gracefully', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-proxy-cli-'));
    const upstream = createServer((_req, res) => res.end('ordinary'));
    const direct = await listen(upstream); closers.push(() => close(upstream));
    async function start() {
        const env = { ...process.env }; for (const key of ['AG_CANARY_SECRET', 'AG_PROJECT_SEED', 'AG_WEBHOOK_SECRET']) delete env[key];
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'proxy', '--upstream', direct, '--listen', '127.0.0.1:0', '--config', join(dir, 'agent-guard.config.json'), '--init-secrets'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
        const done = once(child, 'exit');
        closers.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await done; });
        const url = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('startup timed out: ' + output)), 10000);
            const read = () => { const match = /proxy listening at (http:\/\/[^;]+)/.exec(output); if (match) { clearTimeout(timer); child.stdout.off('data', read); resolve(match[1]!); } };
            child.stdout.on('data', read); child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); });
        });
        return { child, url, done, output: () => output };
    }
    try {
        const one = await start(), body = readFileSync(join(dir, '.env'), 'utf8');
        expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
        expect((await get(one.url + '/')).body.toString()).toBe('ordinary');
        expect((await get(one.url + '/.env')).headers['x-robots-tag']).toContain('noindex');
        await close(upstream); expect((await get(one.url + '/')).status).toBe(502);
        one.child.kill('SIGTERM'); await one.done;
        const two = await start(); two.child.kill('SIGINT'); await two.done;
        expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(body);
        for (const line of body.trim().split('\n')) {
            const secret = line.split('=')[1]!;
            expect(one.output() + two.output()).not.toContain(secret);
        }
        expect(one.output()).toContain('decoy_hit');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
