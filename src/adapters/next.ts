import type { WebGuard } from '../web/index.js';

export function agentGuardMiddleware(guard: WebGuard) {
    return async (request: Request, event?: { waitUntil(promise: Promise<unknown>): void }): Promise<Response | undefined> => {
        try { return (await guard.handle(request, event)) ?? undefined; }
        catch { return undefined; }
    };
}
