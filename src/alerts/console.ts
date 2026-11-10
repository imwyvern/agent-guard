import type { AlertAdapter } from '../types.js';
export function consoleAdapter(o: {
    stream?: NodeJS.WritableStream;
} = {}): AlertAdapter {
    return { name: 'console', async send(alert) { (o.stream ?? process.stderr).write(JSON.stringify(alert) + '\n'); return { ok: true }; } };
}
