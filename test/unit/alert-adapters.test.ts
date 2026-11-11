import { it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { listenLocal } from '../../examples/shared/loopback.js';
import { createAgentGuard, slackAdapter, telegramAdapter, feishuAdapter } from '../../src/index.js';
import type { AgentGuardEvent, AlertPayload } from '../../src/index.js';
import { config, event, request } from '../helpers.js';

const botToken = '12345:inert-test-bot';
const channels = [
    { name: 'slack', make: (url: string, timeoutMs?: number) => slackAdapter({ url, timeoutMs }) },
    { name: 'telegram', make: (url: string, timeoutMs?: number) => telegramAdapter({ botToken, chatId: 'test-chat', apiBaseUrl: url, timeoutMs }) },
    { name: 'feishu', make: (url: string, timeoutMs?: number) => feishuAdapter({ url, timeoutMs }) },
];

async function receiver(options: { statuses?: number[]; hang?: boolean; redirect?: boolean; stream?: boolean } = {}) {
    const deliveries: Array<{ path: string; method: string; contentType: string; body: Record<string, unknown> }> = [];
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            deliveries.push({ path: req.url ?? '', method: req.method ?? '', contentType: String(req.headers['content-type']), body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> });
            if (options.hang) return;
            res.writeHead(options.redirect ? 302 : options.statuses?.shift() ?? 200, options.redirect ? { Location: '/redirected' } : {});
            if (options.stream) res.write('unused response');
            else res.end('ok');
        });
    });
    const local = await listenLocal(server);
    return { ...local, deliveries };
}

function payload(): AlertPayload {
    const source = event({ canary: { id: 'canary-id', placement: 'D1', env: 'test', found_in: 'body', field: 'password' } });
    Object.assign(source, { body: 'private-raw-body', cookie: 'private-cookie', authorization: 'private-authorization' });
    Object.assign(source.req, { body: 'private-raw-body', headers: { Cookie: 'private-cookie', Authorization: 'private-authorization' } });
    Object.assign(source.canary!, { token: 'private-canary-token' });
    source.req.path += '?credential=private-query';
    return { event: source, summary: { deduped: 0, rate_limited: 0 } };
}

function expectMetadata(value: unknown): void {
    const text = JSON.stringify(value);
    for (const expected of ['decoy_hit', 'high', 'D1', 'canary-id', '/.env', 'client_key: key']) expect(text).toContain(expected);
    for (const forbidden of ['private-', 'cookie', 'authorization', 'raw-body']) expect(text.toLowerCase()).not.toContain(forbidden);
}

it('Slack posts a concise JSON summary containing only sanitized metadata and IDs', async () => {
    const r = await receiver(), adapter = slackAdapter({ url: r.url });
    try {
        expect(adapter.name).toBe('slack');
        expect(await adapter.send(payload(), new AbortController().signal)).toEqual({ ok: true, status: 200 });
        expect(r.deliveries).toHaveLength(1);
        expect(r.deliveries[0]).toMatchObject({ method: 'POST', contentType: 'application/json', body: { text: expect.any(String) } });
        expectMetadata(r.deliveries[0]?.body);
    }
    finally { await r.close(); }
});

it('Telegram posts sendMessage to the configured local base without exposing its token in alert text', async () => {
    const r = await receiver(), adapter = telegramAdapter({ botToken, chatId: 'test-chat', apiBaseUrl: r.url + '/api/' });
    try {
        expect(adapter.name).toBe('telegram');
        expect(await adapter.send(payload(), new AbortController().signal)).toEqual({ ok: true, status: 200 });
        expect(r.deliveries[0]?.path === `/api/bot${botToken}/sendMessage`).toBe(true);
        expect(r.deliveries[0]).toMatchObject({ method: 'POST', contentType: 'application/json', body: { chat_id: 'test-chat', text: expect.any(String), disable_web_page_preview: true } });
        expectMetadata(r.deliveries[0]?.body);
        expect(JSON.stringify(r.deliveries[0]?.body).includes(botToken)).toBe(false);
    }
    finally { await r.close(); }
});

it('Telegram rejects missing credentials and reports invalid configuration without the token', () => {
    for (const credentials of [{ botToken: '', chatId: 'test-chat' }, { botToken, chatId: '' }, { botToken, chatId: '   ' }]) {
        let error: unknown;
        try { telegramAdapter(credentials); }
        catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(Error);
        expect(String(error).includes(botToken)).toBe(false);
    }
    expect(telegramAdapter({ botToken, chatId: 'test-chat' }).name).toBe('telegram');
});

it('Feishu posts unsigned text or an independently verifiable timestamp and HMAC signature', async () => {
    const r = await receiver(), secret = 'inert-feishu-signing-fixture';
    const verify = (body: Record<string, unknown>, key: string): boolean =>
        body.sign === createHmac('sha256', key).update(String(body.timestamp) + '\n' + key).digest('base64');
    try {
        const signal = new AbortController().signal;
        expect(await feishuAdapter({ url: r.url }).send(payload(), signal)).toEqual({ ok: true, status: 200 });
        expect(await feishuAdapter({ url: r.url, secret }).send(payload(), signal)).toEqual({ ok: true, status: 200 });
        const unsigned = r.deliveries[0]!.body, signed = r.deliveries[1]!.body;
        expect(unsigned).toMatchObject({ msg_type: 'text', content: { text: expect.any(String) } });
        expect(unsigned.timestamp).toBeUndefined();
        expect(unsigned.sign).toBeUndefined();
        expectMetadata(unsigned);
        expectMetadata(signed);
        expect(signed.timestamp).toMatch(/^\d+$/);
        expect(Math.abs(Date.now() / 1000 - Number(signed.timestamp))).toBeLessThan(5);
        expect(verify(signed, secret)).toBe(true);
        expect(verify(signed, 'tampered-fixture')).toBe(false);
        expect(JSON.stringify(signed).includes(secret)).toBe(false);
    }
    finally { await r.close(); }
});

it.each(channels)('$name rejects unsafe or credentialed URLs with generic errors', ({ make }) => {
    for (const url of ['http://example.com/path', 'http://127.0.0.1.example.com/path', 'https://user:fixture@example.com/path', 'http://user:fixture@127.0.0.1/path', 'file:///tmp/test', 'invalid-private-query']) {
        let error: unknown;
        try { make(url); }
        catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(Error);
        expect(String(error).includes(url)).toBe(false);
        expect(String(error).includes('fixture')).toBe(false);
    }
    for (const url of ['http://localhost:1234', 'http://[::1]:1234', 'https://example.com/path']) expect(() => make(url)).not.toThrow();
    for (const timeoutMs of [0, -1, NaN, Infinity, 1.5]) expect(() => make('http://127.0.0.1:1234', timeoutMs)).toThrow();
});

it.each(channels)('$name refuses redirects and isolates request failures without logging credentials', async ({ make }) => {
    const r = await receiver({ redirect: true });
    const error = vi.spyOn(console, 'error'), warn = vi.spyOn(console, 'warn'), log = vi.spyOn(console, 'log');
    try {
        expect(await make(r.url + '/hook').send(payload(), new AbortController().signal)).toEqual({ ok: false });
        expect(r.deliveries).toHaveLength(1);
        expect(error).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
    }
    finally { await r.close(); }
});

it.each(channels)('$name preserves failure status for Dispatcher and cancels unused streaming responses', async ({ make }) => {
    const r = await receiver({ statuses: [429, 503, 200], stream: true });
    try {
        for (const status of [429, 503, 200])
            expect(await make(r.url).send(payload(), new AbortController().signal)).toEqual({ ok: status === 200, status });
        expect(r.deliveries).toHaveLength(3);
    }
    finally { await r.close(); }
});

it.each(channels)('$name honors timeouts and caller aborts without exposing abort reasons', async ({ make }) => {
    const r = await receiver({ hang: true });
    try {
        expect(await make(r.url, 25).send(payload(), new AbortController().signal)).toEqual({ ok: false });
        const controller = new AbortController(), adapter = make(r.url, 1000);
        const pending = adapter.send(payload(), controller.signal);
        controller.abort(new Error(botToken));
        expect(await pending).toEqual({ ok: false });
        expect(await adapter.send(payload(), controller.signal)).toEqual({ ok: false });
    }
    finally { await r.close(); }
});

it.each(channels)('$name integrates with inspect, dedupe, rate limiting and close flush', async ({ name, make }) => {
    const r = await receiver(), events: AgentGuardEvent[] = [];
    const g = createAgentGuard(config({ alerts: { adapters: [make(r.url)], ratePerMinute: 1 }, log: { sink: e => events.push(e), level: 'debug' } }));
    try {
        await g.inspect(request('/.env', { headers: { 'user-agent': 'curl/8.0', cookie: 'private-cookie', authorization: 'private-authorization' }, body: 'private-raw-body' }));
        await g.inspect(request('/.env'));
        await g.inspect(request('/.env', { ip: '198.51.100.1' }));
        await g.close();
        expect(r.deliveries).toHaveLength(1);
        expect(g.metrics().alerts_sent).toBe(1);
        expect(events.find(e => e.event === 'alert_sent')?.alert?.channel).toBe(name);
        expect(JSON.stringify(r.deliveries[0]?.body)).not.toContain('private-');
        expect(JSON.stringify(events).includes(botToken)).toBe(false);
    }
    finally { await g.close(); await r.close(); }
});

it.each(channels)('$name hung delivery leaves inspect fast and close flushes alert_failed', async ({ name, make }) => {
    const r = await receiver({ hang: true }), events: AgentGuardEvent[] = [];
    const g = createAgentGuard(config({ alerts: { adapters: [make(r.url, 60)] }, log: { sink: e => events.push(e), level: 'debug' } }));
    try {
        const start = performance.now();
        expect((await g.inspect(request('/.env'))).action).toBe('respond');
        expect(performance.now() - start).toBeLessThan(50);
        await g.close();
        expect(g.metrics().alerts_failed).toBe(1);
        expect(events.find(e => e.event === 'alert_failed')?.alert?.channel).toBe(name);
        expect(JSON.stringify(events).includes(botToken)).toBe(false);
    }
    finally { await g.close(); await r.close(); }
});

it('HTTP adapter failures use the existing Dispatcher retry policy', async () => {
    const r = await receiver({ statuses: [503, 200] });
    const g = createAgentGuard(config({ alerts: { adapters: [slackAdapter({ url: r.url })] } }));
    try {
        await g.inspect(request('/.env'));
        await g.close();
        expect(r.deliveries).toHaveLength(2);
        expect(g.metrics().alerts_sent).toBe(1);
    }
    finally { await g.close(); await r.close(); }
});
