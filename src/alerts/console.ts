import { sanitizeEvent } from '../core/security.js';
import type { AlertAdapter } from '../types.js';
export function consoleAdapter(o: {
    stream?: NodeJS.WritableStream;
} = {}): AlertAdapter {
    return { name: 'console', async send(alert) { (o.stream ?? process.stderr).write(JSON.stringify({ ...alert, event: sanitizeEvent(alert.event) }) + '\n'); return { ok: true }; } };
}
