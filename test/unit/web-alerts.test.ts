import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentGuardEvent, AlertPayload } from '../../src/types.js';
import { createWebGuard, memoryStore, webhookAdapter, slackAdapter, telegramAdapter, feishuAdapter } from '../../src/web/index.js';
import type { WebGuard } from '../../src/web/index.js';
import { signWebhook, verifyWebhookSignature } from '../../src/alerts/webhook.js';
import { verifyWebhookSignatureAsync, signFeishu } from '../../src/alerts/signing.js';
import { webCrypto } from '../../src/crypto/web.js';
import { nodeCrypto } from '../../src/crypto/node.js';

const servers: Server[] = [], guards: WebGuard[] = [];
const secret = 'local fixture secret';
const event: AgentGuardEvent = { v: 1, ts: '2026-01-01T00:00:00.000Z', event_id: 'fixture', event: 'decoy_hit', severity: 'high', project: 'fixture', env: 'test', req: { method: 'GET', path: '/.env', client_key: 'fixture-key', has_session: true }, decoy: { id: 'D1', status: 200 } };
const payload: AlertPayload = { event, summary: { deduped: 0, rate_limited: 0 } };
async function server(handler: (body: string, headers: Record<string, string | string[] | undefined>, path: string, res: ServerResponse) => void | Promise<void>): Promise<string> {
    const instance = createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += String(chunk); });
        req.on('end', () => { void Promise.resolve(handler(body, req.headers, req.url!, res)).catch(() => { res.statusCode = 500; res.end(); }); });
    });
    servers.push(instance);
    await new Promise<void>(resolve => { instance.listen(0, '127.0.0.1', resolve); });
    return 'http://127.0.0.1:' + (instance.address() as AddressInfo).port;
}
function guard(adapter: ReturnType<typeof webhookAdapter>, options: { dedupeWindowSec?: number; ratePerMinute?: number } = {}): WebGuard {
    const g = createWebGuard({ project: 'alerts', env: 'test', projectSeed: 'fixture', canary: { secret: 'fixture', registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } }, store: memoryStore(), alerts: { adapters: [adapter], ...options } });
    guards.push(g); return g;
}
afterEach(async () => {
    for (const g of guards.splice(0)) await g.close();
    for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(resolve => { s.close(() => resolve()); }); }
});

it('sends WebCrypto webhook signatures accepted by Node and accepts Node signatures over loopback HTTP', async () => {
    const verified: boolean[] = [];
    const url = await server(async (body, headers, path, res) => {
        const options = { body, timestamp: String(headers['x-agentguard-timestamp']), signature: String(headers['x-agentguard-signature']), secret };
        verified.push(path === '/web' ? verifyWebhookSignature(options) : await verifyWebhookSignatureAsync(options, webCrypto));
        res.end('ok');
    });
    expect((await webhookAdapter({ url: url + '/web', secret }).send(payload, new AbortController().signal)).ok).toBe(true);
    const body = JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(url + '/node', { method: 'POST', body, headers: { 'x-agentguard-timestamp': timestamp, 'x-agentguard-signature': signWebhook(body, timestamp, secret) } });
    await response.text(); expect(verified).toEqual([true, true]);
    expect(await verifyWebhookSignatureAsync({ body: body + 'tampered', timestamp, signature: signWebhook(body, timestamp, secret), secret }, webCrypto)).toBe(false);
});
it('posts compatible Slack, Telegram and signed Feishu JSON payloads', async () => {
    const received: Array<{ body: Record<string, unknown>; path: string }> = [];
    const url = await server((body, _headers, path, res) => { received.push({ body: JSON.parse(body) as Record<string, unknown>, path }); res.end(); });
    const adapters = [slackAdapter({ url: url + '/slack' }), telegramAdapter({ apiBaseUrl: url + '/api/', botToken: '123:fixture', chatId: '42' }), feishuAdapter({ url: url + '/feishu', secret })];
    for (const adapter of adapters) expect((await adapter.send(payload, new AbortController().signal)).ok).toBe(true);
    expect(received[0]).toMatchObject({ path: '/slack', body: { text: expect.stringContaining('decoy: D1') } });
    expect(received[1]).toMatchObject({ path: '/api/bot123:fixture/sendMessage', body: { chat_id: '42', disable_web_page_preview: true, text: expect.stringContaining('path: /.env') } });
    const feishu = received[2]!.body;
    expect(feishu).toMatchObject({ msg_type: 'text', content: { text: expect.stringContaining('client_key: fixture-key') } });
    expect(feishu.sign).toBe(signFeishu(String(feishu.timestamp), secret, nodeCrypto));
    expect(JSON.stringify(received)).not.toMatch(/cookie|authorization|raw.body/i);
});
it.each(['http://remote.invalid/hook', 'https://user:password@remote.invalid/hook', 'ftp://127.0.0.1/hook'])('rejects unsafe alert URL %s', url => {
    for (const create of [() => webhookAdapter({ url, secret }), () => slackAdapter({ url }), () => telegramAdapter({ apiBaseUrl: url, botToken: '123:fixture', chatId: '42' }), () => feishuAdapter({ url })]) expect(create).toThrow(/HTTPS|credentials/);
});
it('passes the delivery promise to waitUntil and returns while a webhook is still waiting', async () => {
    let release: () => void = () => {}, seen: () => void = () => {}, sent = false;
    const requestSeen = new Promise<void>(resolve => { seen = resolve; });
    const url = await server((_body, _headers, _path, res) => { release = () => { sent = true; res.end(); }; seen(); });
    const g = guard(webhookAdapter({ url, secret })), pending: Promise<unknown>[] = [];
    const response = await g.handle(new Request('https://host.invalid/.env'), { waitUntil: promise => { pending.push(promise); } });
    expect(response!.status).toBe(200); expect(pending).toHaveLength(1); expect(pending[0]).toBeInstanceOf(Promise);
    await requestSeen; expect(sent).toBe(false); release(); await Promise.all(pending);
    expect(g.prometheusText()).toContain('agent_guard_alerts_sent_total 1');
});
it('swallows failed delivery without ctx and excludes request credentials and raw bodies', async () => {
    const bodies: string[] = [];
    const url = await server((body, _headers, _path, res) => { bodies.push(body); res.statusCode = 400; res.end(); });
    const g = guard(webhookAdapter({ url, secret }));
    const response = await g.handle(new Request('https://host.invalid/api/internal/admin', { method: 'POST', headers: { authorization: 'Bearer private-credential', cookie: 'session=private-cookie' }, body: 'private-raw-body' }));
    expect(response!.status).toBe(403); await g.close();
    expect(bodies).toHaveLength(1); expect(bodies.join('')).not.toMatch(/private-|authorization|cookie|raw.body/i);
    expect(g.prometheusText()).toContain('agent_guard_alerts_failed_total 1');
});
it('shares alert deduplication and per-channel rate limits with the Node dispatcher', async () => {
    const received: string[] = [];
    const url = await server((body, _headers, _path, res) => { received.push(body); res.end(); });
    const g = guard(webhookAdapter({ url, secret }), { ratePerMinute: 1 });
    for (const path of ['/.env', '/.env', '/internal/ops-notes']) await g.handle(new Request('https://host.invalid' + path));
    await g.close(); expect(received).toHaveLength(1);
});
it('does not hold a response open for an adapter that ignores abort', async () => {
    vi.spyOn(webCrypto, 'hmacSha256').mockImplementation(async (s, data) => nodeCrypto.hmacSha256(s, data));
    vi.spyOn(webCrypto, 'sha256').mockImplementation(async data => nodeCrypto.sha256(data));
    vi.useFakeTimers();
    const g = guard({ name: 'hung', send: () => new Promise(() => {}) });
    expect((await g.handle(new Request('https://host.invalid/.env')))!.status).toBe(200);
    const close = g.close(); await vi.advanceTimersByTimeAsync(15_100); await close;
    expect(g.prometheusText()).toContain('agent_guard_alerts_failed_total 1');
});
