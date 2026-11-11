import { nodeCrypto } from '../crypto/node.js';
import type { CryptoProvider } from '../crypto/types.js';
import type { AlertAdapter } from '../types.js';
import { alertUrl, postAlert } from './http.js';
import { alertText, alertTimeout } from './shared.js';
import { signFeishu } from './signing.js';

export function feishuAdapter(o: { url: string; secret?: string; timeoutMs?: number }, crypto: CryptoProvider = nodeCrypto): AlertAdapter {
    const url = alertUrl(o.url), timeoutMs = alertTimeout(o.timeoutMs), secret = o.secret;
    return { name: 'feishu', async send(alert, signal) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = secret === undefined ? {} : { timestamp, sign: signFeishu(timestamp, secret, crypto) };
        return postAlert(url, { msg_type: 'text', content: { text: alertText(alert).text }, ...signature }, signal, timeoutMs);
    } };
}
