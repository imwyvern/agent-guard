import type { RequestHandler } from 'express';
import type { AgentGuard, AgentGuardConfig } from '../types.js';
import { agentGuardNode } from './node.js';
export function agentGuard(configOrGuard: AgentGuardConfig | AgentGuard): RequestHandler {
    const middleware = agentGuardNode(configOrGuard);
    return (req, res, next) => middleware(req, res, next);
}
