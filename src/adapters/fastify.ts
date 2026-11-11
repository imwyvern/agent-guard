import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AgentGuard, AgentGuardConfig } from '../types.js';
import { createAgentGuard } from '../index.js';
import { guardConfigs } from '../config.js';
import { toRequest } from './node.js';
import { lureResponse } from './lure-response.js';

export function agentGuard(configOrGuard: AgentGuardConfig | AgentGuard): FastifyPluginAsync {
    const guard = 'inspect' in configOrGuard ? configOrGuard : createAgentGuard(configOrGuard);
    const config = guardConfigs.get(guard);
    const plugin: FastifyPluginAsync = async app => {
        const passed = new WeakMap<FastifyRequest, string>();
        app.addHook('preHandler', async (req, reply) => {
            try {
                const request = { ...toRequest(req.raw, config), body: req.body };
                const decision = await guard.inspect(request);
                if (decision.action === 'pass') passed.set(req, request.path);
                else if (!decision.events.some(event => event.event === 'crawler_bypass')) {
                    return reply.headers(decision.response.headers).code(decision.response.status).send(decision.response.body);
                }
            } catch { /* Inspection failures pass through to the host. */ }
        });
        app.addHook('onSend', async (req, reply, payload) => {
            const path = passed.get(req);
            if (path === undefined) return payload;
            try {
                const body = lureResponse(guard, config, req.method, path, reply.statusCode, reply.getHeader('content-type'), reply.getHeader('content-encoding'), payload);
                if (body !== undefined) {
                    reply.header('content-length', Buffer.byteLength(body));
                    reply.removeHeader('etag');
                    reply.removeHeader('content-md5');
                    return body;
                }
            } catch { /* Failed transforms preserve the original response. */ }
            return payload;
        });
    };
    Object.defineProperty(plugin, Symbol.for('skip-override'), { value: true });
    return plugin;
}
