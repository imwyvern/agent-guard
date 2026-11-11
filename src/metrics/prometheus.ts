import type { RequestListener } from 'node:http';
import type { AgentGuard } from '../types.js';
export { prometheusText } from './prometheus-core.js';

/** Mount explicitly on a host-owned route. Exporting metrics never inspects a request. */
export function prometheusHandler(guard: AgentGuard): RequestListener {
    return (req, res) => {
        try {
            if (req.method !== 'GET') {
                res.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Method Not Allowed\n');
                return;
            }
            const body = guard.prometheusText();
            res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
            res.end(body);
        }
        catch {
            try {
                if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Internal Server Error\n');
            }
            catch { /* Isolate response failures from the host. */ }
        }
    };
}
