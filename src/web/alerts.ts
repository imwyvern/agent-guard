import type { AlertAdapter } from '../types.js';
import { webCrypto } from '../crypto/web.js';
import { base64 } from '../crypto/bytes.js';
import { alertUrl, postAlert } from '../alerts/http.js';
import { alertText, alertTimeout } from '../alerts/shared.js';
import { sanitizeEvent } from '../core/security-core.js';
import { signWebhookAsync } from '../alerts/signing.js';
export { slackAdapter } from '../alerts/slack.js';
export { telegramAdapter } from '../alerts/telegram.js';

export function webhookAdapter(o: { url: string; secret: string; timeoutMs?: number }): AlertAdapter {
    const url = alertUrl(o.url), timeoutMs = alertTimeout(o.timeoutMs);
    return { name: 'webhook', async send(alert, signal) {
        const body = JSON.stringify({ ...alert, event: sanitizeEvent(alert.event) }), timestamp = String(Math.floor(Date.now() / 1000));
        const signature = await signWebhookAsync(body, timestamp, o.secret, webCrypto);
        const response = await fetch(url, { method: 'POST', redirect: 'error', body,
            headers: { 'Content-Type': 'application/json', 'X-AgentGuard-Signature': signature, 'X-AgentGuard-Timestamp': timestamp },
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
        await response.body?.cancel();
        return { ok: response.ok, status: response.status };
    } };
}
export function feishuAdapter(o: { url: string; secret?: string; timeoutMs?: number }): AlertAdapter {
    const url = alertUrl(o.url), timeoutMs = alertTimeout(o.timeoutMs);
    return { name: 'feishu', async send(alert, signal) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = o.secret === undefined ? {} : { timestamp, sign: base64(await webCrypto.hmacSha256(o.secret, timestamp + '\n' + o.secret)) };
        return postAlert(url, { msg_type: 'text', content: { text: alertText(alert).text }, ...signature }, signal, timeoutMs);
    } };
}
