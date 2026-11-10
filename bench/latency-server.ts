import { demoConfig, startDemo } from '../examples/shared/site.js';
import { socketFallback } from '../examples/shared/loopback.js';

const kind = process.argv[2], mode = process.argv[3];
if ((kind !== 'express' && kind !== 'node' && kind !== 'hono') || (mode !== 'on' && mode !== 'off'))
    throw new Error('usage: latency-server.ts express|node|hono on|off');
const demo = await startDemo(kind, mode === 'on' ? demoConfig({ log: { sink: () => { } }, alerts: { adapters: [] } }) : false);
// stdout is a file descriptor: no IPC socket or pipe is needed for readiness.
console.log(JSON.stringify({ url: demo.url, virtual: socketFallback }));
for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => { void demo.close().catch(() => { process.exitCode = 1; }); });
