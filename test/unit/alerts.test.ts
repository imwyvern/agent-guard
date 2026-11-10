import { it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import { createAgentGuard, consoleAdapter, webhookAdapter, verifyWebhookSignature } from '../../src/index.js';
import { signWebhook } from '../../src/alerts/webhook.js';
import { Dispatcher } from '../../src/alerts/dispatcher.js';
import { config, request, receiver, event } from '../helpers.js';
import type { AgentGuardEvent, AlertPayload } from '../../src/index.js';
it('HMAC signing rejects modified body, signature, timestamp and expiry', () => {
    const body = '{"test":1}', timestamp = String(Math.floor(Date.now() / 1000)), secret = 's', signature = signWebhook(body, timestamp, secret);
    expect(verifyWebhookSignature({ body, timestamp, secret, signature })).toBe(true);
    for (const override of [{ body: 'tampered' }, { signature: 'invalid' }, { timestamp: '0' }, { timestamp: 'NaN' }, { secret: 'wrong' }, { signature: signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0') }])
        expect(verifyWebhookSignature({ body, timestamp, secret, signature, ...override })).toBe(false);
    expect(() => webhookAdapter({ url: 'file:///tmp/test', secret })).toThrow();
    expect(() => webhookAdapter({ url: 'http://a:b@local.invalid', secret })).toThrow();
});
it('console writes a single JSON line to injected stream', async () => {
    let text = '';
    const stream = new Writable({ write(chunk, _e, cb) { text += String(chunk); cb(); } }), adapter = consoleAdapter({ stream });
    const payload = { event: event(), summary: { deduped: 0, rate_limited: 0 } };
    expect(await adapter.send(payload, new AbortController().signal)).toEqual({ ok: true });
    expect(text.split('\n')).toHaveLength(2);
    expect(JSON.parse(text)).toEqual(payload);
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await consoleAdapter().send(payload, new AbortController().signal);
    expect(spy).toHaveBeenCalledOnce();
});
it('webhook retries 5xx, signs raw bytes, redacts alert IP and records status', async () => {
    const r = await receiver([503, 500, 200]), events: AgentGuardEvent[] = [];
    const g = createAgentGuard(config({ log: { sink: e => events.push(e), level: 'debug' }, alerts: { adapters: [webhookAdapter({ url: r.url, secret: 'webhook-test-secret' })] } }));
    try {
        await g.inspect(request('/.env'));
        await g.close();
        expect(r.deliveries).toHaveLength(3);
        expect(r.deliveries.every(d => d.valid)).toBe(true);
        expect(r.deliveries[0]?.payload.event.req.ip).toBe('192.0.2.x');
        expect(events.find(e => e.event === 'alert_sent')?.alert?.status).toBe(200);
        expect(g.metrics().alerts_sent).toBe(1);
    }
    finally {
        await r.close();
    }
});
it('hung webhook does not hold response, times out and logs alert_failed', async () => {
    const r = await receiver([], true), g = createAgentGuard(config({ alerts: { adapters: [webhookAdapter({ url: r.url, secret: 'webhook-test-secret', timeoutMs: 10 })] } }));
    try {
        const start = performance.now();
        await g.inspect(request('/.env'));
        expect(performance.now() - start).toBeLessThan(50);
        await g.close();
        expect(g.metrics().alerts_failed).toBe(1);
    }
    finally {
        await r.close();
    }
});
it('dedupes per event/client/placement and merges suppressed counts into next delivery', async () => {
    vi.useFakeTimers();
    const sent: AlertPayload[] = [], d = new Dispatcher({ adapters: [{ name: 'test', send: async (p) => { sent.push(p); return { ok: true }; } }], dedupeWindowSec: 60, ratePerMinute: 2, redactIp: false }, () => { });
    for (let i = 0; i < 100; i++)
        d.enqueue(event());
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(60000);
    d.enqueue(event());
    await d.close();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.summary.deduped).toBe(99);
    expect(sent[1]?.event.req.ip).toBe('192.0.2.1');
    d.enqueue(event());
    expect(sent).toHaveLength(2);
});
it('rate limit is per channel; carries a summary and suppresses low-severity/probe alerts by default', async () => {
    vi.useFakeTimers();
    const sent: AlertPayload[] = [], adapter = { name: 'test', send: async (p: AlertPayload) => { sent.push(p); return { ok: true }; } };
    const d = new Dispatcher({ adapters: [adapter], ratePerMinute: 1, dedupeWindowSec: 0 }, () => { });
    d.enqueue(event({ severity: 'debug' }));
    d.enqueue(event({ event: 'probe', severity: 'info' }));
    d.enqueue(event());
    d.enqueue(event());
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(60000);
    d.enqueue(event());
    await d.close();
    expect(sent[1]?.summary.rate_limited).toBe(1);
    const upgraded = new Dispatcher({ adapters: [adapter], minSeverity: 'info' }, () => { });
    upgraded.enqueue(event({ event: 'probe', severity: 'info' }));
    await upgraded.close();
    expect(sent.at(-1)?.event.event).toBe('probe');
});
it('limits retries for 4xx, handles thrown adapters and force-times-out ignored AbortSignals', async () => {
    vi.useFakeTimers();
    const events: AgentGuardEvent[] = [];
    const bad = vi.fn(async () => ({ ok: false, status: 400 })), d = new Dispatcher({ adapters: [{ name: 'bad', send: bad }] }, e => events.push(e));
    d.enqueue(event());
    await vi.advanceTimersByTimeAsync(1);
    await d.close();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(events[0]?.event).toBe('alert_failed');
    for (const send of [async () => { throw Error('failed'); }, () => new Promise<{
            ok: boolean;
        }>(() => { })]) {
        const dispatcher = new Dispatcher({ adapters: [{ name: 'broken', send }] }, e => events.push(e));
        dispatcher.enqueue(event());
        await vi.advanceTimersByTimeAsync(16000);
        await dispatcher.close();
    }
    expect(events).toHaveLength(3);
});
