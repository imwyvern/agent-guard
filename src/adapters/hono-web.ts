import type { WebGuard } from '../web/index.js';

export interface HonoWebContext {
    req: { raw: Request };
    res?: Response;
    executionCtx?: { waitUntil(promise: Promise<unknown>): void };
    env?: unknown;
}
export function honoWeb(guard: WebGuard) {
    return async (c: HonoWebContext, next: () => Promise<void>): Promise<void> => {
        let ctx: HonoWebContext['executionCtx'];
        try { ctx = c.executionCtx; } catch { /* Some hosts expose a getter that throws outside Workers. */ }
        try {
            const intercepted = await guard.handle(c.req.raw, ctx);
            if (intercepted !== null) { c.res = intercepted; return; }
        } catch { /* Inspection failures pass through to the host. */ }
        await next();
    };
}
