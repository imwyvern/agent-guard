import { createWebGuard } from '../web/index.js';
import type { WebContext, WebGuard } from '../web/index.js';

export function withAgentGuard<Env, Context extends WebContext, Extra extends object>(guard: WebGuard, handler: Extra & {
    fetch(request: Request, env: Env, ctx: Context): Response | Promise<Response>;
}): Omit<Extra, 'fetch'> & { fetch(request: Request, env: Env, ctx: Context): Promise<Response> } {
    return { ...handler, async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
        try {
            const intercepted = await guard.handle(request, ctx);
            if (intercepted !== null) return intercepted;
        } catch { /* Inspection failures pass through to the host. */ }
        return handler.fetch(request, env, ctx);
    } };
}

export function fromEnv(env: Record<string, unknown>): WebGuard {
    const binding = (name: string, fallback?: string): string => {
        const value = env[name] ?? fallback;
        if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
        return value;
    };
    const secret = binding('AG_CANARY_SECRET'), projectSeed = binding('AG_PROJECT_SEED');
    const mode = binding('AG_MODE', 'detect');
    if (mode !== 'detect' && mode !== 'trap') throw new Error('AG_MODE must be detect or trap');
    return createWebGuard({
        project: binding('AG_PROJECT', 'default'), env: binding('AG_ENV', 'production'), projectSeed, mode,
        ipHeader: binding('AG_IP_HEADER', 'CF-Connecting-IP'),
        canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
    });
}
