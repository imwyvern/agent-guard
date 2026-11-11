import { createWebGuard, webhookAdapter, type WebGuard } from '../../src/web/index.js';
import { withAgentGuard, fromEnv } from '../../src/adapters/workers.js';
interface Env { AG_CANARY_SECRET: string; AG_PROJECT_SEED: string; WEBHOOK_URL: string }
interface Context { waitUntil(promise: Promise<unknown>): void }
let guard: WebGuard | undefined;
export default {
    async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
        if (!guard) {
            // Exercise secret binding validation in the real isolate too.
            const bound = fromEnv({ ...env }); await bound.close();
            guard = createWebGuard({ project: 'workers-smoke', env: 'test', projectSeed: env.AG_PROJECT_SEED,
                canary: { secret: env.AG_CANARY_SECRET, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
                alerts: { adapters: [webhookAdapter({ url: env.WEBHOOK_URL, secret: 'webhook-test-secret' })] },
            });
        }
        let waits = 0;
        const context: Context = { waitUntil(promise) { waits++; ctx.waitUntil(promise); } };
        const host = { fetch: () => new Response('ok') };
        const current = new URL(request.url).pathname === '/fail-open' ? { ...guard, handle: async () => { throw new Error('injected guard failure'); } } : guard;
        const response = await withAgentGuard(current, host).fetch(request, env, context);
        const headers = new Headers(response.headers); headers.set('x-smoke-wait-until', String(waits));
        return new Response(response.body, { status: response.status, headers });
    },
};
