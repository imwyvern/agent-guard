import { createHmac } from 'node:crypto';
import type { AlertAdapter } from '../types.js';
import { alertUrl, postAlert } from './http.js';
import { alertText, alertTimeout } from './shared.js';

export function feishuAdapter(o: { url: string; secret?: string; timeoutMs?: number }): AlertAdapter {
    const url = alertUrl(o.url), timeoutMs = alertTimeout(o.timeoutMs), secret = o.secret;
    return { name: 'feishu', async send(alert, signal) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = secret === undefined ? {} : { timestamp, sign: createHmac('sha256', secret).update(timestamp + '\n' + secret).digest('base64') };
        return postAlert(url, { msg_type: 'text', content: { text: alertText(alert).text }, ...signature }, signal, timeoutMs);
    } };
}
