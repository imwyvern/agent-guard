import type { WebGuard } from '../web/index.js';

export interface DenoInfo { remoteAddr?: { hostname?: string; port?: number; transport?: string } }
export function denoHandler(guard: WebGuard, next: (request: Request, info?: DenoInfo) => Response | Promise<Response>) {
    return async (request: Request, info?: DenoInfo): Promise<Response> => {
        try {
            const intercepted = await guard.handle(request, { clientIp: info?.remoteAddr?.hostname });
            if (intercepted !== null) return intercepted;
        } catch { /* Inspection failures pass through to the host. */ }
        return next(request, info);
    };
}
