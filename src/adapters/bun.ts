import type { WebGuard } from '../web/index.js';

export interface BunServer { requestIP?(request: Request): { address: string; family?: string; port?: number } | null | undefined }
export function bunHandler(guard: WebGuard, next: (request: Request, server?: BunServer) => Response | Promise<Response>) {
    return async (request: Request, server?: BunServer): Promise<Response> => {
        try {
            const intercepted = await guard.handle(request, { clientIp: server?.requestIP?.(request)?.address });
            if (intercepted !== null) return intercepted;
        } catch { /* Inspection failures pass through to the host. */ }
        return next(request, server);
    };
}
