import type { AlertAdapter } from '../types.js';
import { alertUrl, postAlert } from './http.js';
import { alertText, alertTimeout } from './shared.js';

export function slackAdapter(o: { url: string; timeoutMs?: number }): AlertAdapter {
    const url = alertUrl(o.url), timeoutMs = alertTimeout(o.timeoutMs);
    return { name: 'slack', async send(alert, signal) {
        return postAlert(url, { text: alertText(alert).text }, signal, timeoutMs);
    } };
}
