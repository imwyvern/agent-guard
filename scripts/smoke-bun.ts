import { bunHandler } from '../dist/bun.js';
import { smokeGuard, smokeRequests } from './smoke-web.ts';

const runtime = (globalThis as unknown as { Bun: { serve(options: { hostname: string; port: number; fetch(request: Request): Response | Promise<Response> }): { port: number; stop(): void } } }).Bun;
if (!runtime) throw new Error('Run with bun scripts/smoke-bun.ts');
const { guard, events } = smokeGuard();
const server = runtime.serve({ hostname: '127.0.0.1', port: 0, fetch: bunHandler(guard, () => new Response('ok')) });
try { await smokeRequests(server.port, events); console.log('bun serve smoke passed'); }
finally { server.stop(); await guard.close(); }
