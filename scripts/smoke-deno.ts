import { denoHandler } from '../dist/deno.js';
import { smokeGuard, smokeRequests } from './smoke-web.ts';

const runtime = (globalThis as unknown as { Deno: { serve(options: { hostname: string; port: number; onListen(): void }, handler: (request: Request) => Response | Promise<Response>): { addr: { port: number }; shutdown(): Promise<void> } } }).Deno;
if (!runtime) throw new Error('Run with deno run --allow-net=127.0.0.1 scripts/smoke-deno.ts');
const { guard, events } = smokeGuard();
const server = runtime.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, denoHandler(guard, () => new Response('ok')));
try { await smokeRequests(server.addr.port, events); console.log('deno serve smoke passed'); }
finally { await server.shutdown(); await guard.close(); }
