import type { AlertAdapter } from '../types.js';
import { alertUrl, postAlert } from './http.js';
import { alertText, alertTimeout, asciiAlphanumeric, onlyCharacters } from './shared.js';

export function telegramAdapter(o: { botToken: string; chatId: string; timeoutMs?: number; apiBaseUrl?: string }): AlertAdapter {
    if (!o.botToken || !onlyCharacters(o.botToken, asciiAlphanumeric + ':_-') || !o.chatId?.trim())
        throw new Error('telegram requires a valid bot token and chat ID');
    const url = alertUrl(o.apiBaseUrl ?? 'https://api.telegram.org'), timeoutMs = alertTimeout(o.timeoutMs);
    if (url.search || url.hash)
        throw new Error('telegram API base must not contain a query or fragment');
    const path = url.pathname;
    let end = path.length;
    while (end && path[end - 1] === '/') end--;
    url.pathname = `${path.slice(0, end)}/bot${o.botToken}/sendMessage`;
    const chatId = o.chatId;
    return { name: 'telegram', async send(alert, signal) {
        return postAlert(url, { chat_id: chatId, text: alertText(alert).text, disable_web_page_preview: true }, signal, timeoutMs);
    } };
}
