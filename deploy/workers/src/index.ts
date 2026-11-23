import { fromEnv, withAgentGuard } from '@imwyvern/agent-guard/workers';

// One guard per isolate, initialized only when the first request supplies bindings.
let guard: ReturnType<typeof fromEnv> | undefined;

const handler = {
    fetch: () => new Response('Hello from the Workers template.\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }),
};

export default {
    fetch(request: Request, env: Record<string, unknown>, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
        // Keep this template detect-only even if the environment supplies a mode.
        guard ??= fromEnv({ ...env, AG_MODE: 'detect' });
        return withAgentGuard(guard, handler).fetch(request, env, ctx);
    },
};
