import { nodeCrypto } from '../crypto/node.js';
import type { CryptoProvider } from '../crypto/types.js';
import { sanitizeEvent } from '../core/security-core.js';
import { signWebhook as coreSign, verifyWebhookSignature as coreVerify } from './signing.js';
import type { AlertAdapter } from '../types.js';
export function signWebhook(body: string, timestamp: string, secret: string, crypto: CryptoProvider = nodeCrypto): string { return coreSign(body, timestamp, secret, crypto); }
export function verifyWebhookSignature(o: {
    body: string;
    timestamp: string;
    signature: string;
    secret: string;
    toleranceSec?: number;
}, crypto: CryptoProvider = nodeCrypto): boolean {
    return coreVerify(o, crypto);
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
            const body = JSON.stringify({ ...alert, event: sanitizeEvent(alert.event) }), timestamp = String(Math.floor(Date.now() / 1000));
            const response = await fetch(url, { method: 'POST', redirect: 'error', body, headers: { 'Content-Type': 'application/json', 'X-AgentGuard-Signature': signWebhook(body, timestamp, o.secret), 'X-AgentGuard-Timestamp': timestamp }, signal: AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs ?? 5000)]) });
            await response.body?.cancel();
            return { ok: response.ok, status: response.status };
        } };
}
