import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AlertAdapter } from '../types.js';
export function signWebhook(body: string, timestamp: string, secret: string): string { return 'sha256=' + createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex'); }
export function verifyWebhookSignature(o: {
    body: string;
    timestamp: string;
    signature: string;
    secret: string;
    toleranceSec?: number;
}): boolean {
    if (!/^\d+$/.test(o.timestamp) || Math.abs(Date.now() / 1000 - Number(o.timestamp)) > (o.toleranceSec ?? 300) || !/^sha256=[a-f0-9]{64}$/.test(o.signature))
        return false;
    return timingSafeEqual(Buffer.from(o.signature), Buffer.from(signWebhook(o.body, o.timestamp, o.secret)));
}
export function webhookAdapter(o: {
    url: string;
    secret: string;
    timeoutMs?: number;
}): AlertAdapter {
    const url = new URL(o.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('webhook URL must be HTTP(S) without credentials');
    return { name: 'webhook', async send(alert, signal) {
            const body = JSON.stringify(alert), timestamp = String(Math.floor(Date.now() / 1000));
            const response = await fetch(url, { method: 'POST', redirect: 'error', body, headers: { 'Content-Type': 'application/json', 'X-AgentGuard-Signature': signWebhook(body, timestamp, o.secret), 'X-AgentGuard-Timestamp': timestamp }, signal: AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs ?? 5000)]) });
            await response.body?.cancel();
            return { ok: response.ok, status: response.status };
        } };
}
