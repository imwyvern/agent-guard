import type { Middleware } from 'koa';
import type { AgentGuard, AgentGuardConfig } from '../types.js';
import { createAgentGuard } from '../index.js';
import { guardConfigs } from '../config.js';
import { toRequest } from './node.js';
import { lureResponse } from './lure-response.js';

export function agentGuard(configOrGuard: AgentGuardConfig | AgentGuard): Middleware {
    const guard = 'inspect' in configOrGuard ? configOrGuard : createAgentGuard(configOrGuard);
    const config = guardConfigs.get(guard);
    return async (ctx, next) => {
        let passedPath: string | undefined;
        try {
            const request = toRequest(ctx.req, config);
            const body = (ctx.request as typeof ctx.request & { body?: unknown }).body;
            if (body !== undefined) request.body = body;
            const decision = await guard.inspect(request);
            if (decision.action === 'pass') passedPath = request.path;
            else if (!decision.events.some(event => event.event === 'crawler_bypass')) {
                ctx.body = decision.response.body;
                ctx.set(decision.response.headers);
                ctx.status = decision.response.status;
                return;
            }
        } catch { /* Inspection failures pass through to the host. */ }
        await next();
        if (passedPath === undefined) return;
        try {
            const body = lureResponse(guard, config, ctx.method, passedPath, ctx.status, ctx.response.get('content-type'), ctx.response.get('content-encoding'), ctx.body);
            if (body !== undefined) {
                ctx.body = body;
                ctx.length = Buffer.byteLength(body);
                ctx.remove('etag');
                ctx.remove('content-md5');
            }
        } catch { /* Failed transforms preserve the original response. */ }
    };
}
