import type { AGDecision, AgentGuard, AgentGuardConfig, AGRequest } from '../../src/index.js';
import { config, request } from '../helpers.js';

export const allTrap = {
    delay: { enabled: true, ms: 60, maxConcurrent: 20 },
    rateLimit: { enabled: true, capacity: 1, refillPerSec: 0 },
    block: { enabled: true, ttlMs: 1000, maxKeys: 32 },
    maze: { enabled: false },
};
export function trapConfig(trap: AgentGuardConfig['trap'] = {}): AgentGuardConfig {
    return config({ mode: 'trap', trap: { ...allTrap, ...trap } });
}
export function response(decision: AGDecision) {
    if (decision.action !== 'respond') throw new Error('expected a response');
    return decision.response;
}
export function tokenFrom(body: string): string {
    const match = /^ADMIN_API_TOKEN=(.+)$/m.exec(body);
    if (!match) throw new Error('expected an inert D1 canary');
    return match[1]!;
}
export async function confirm(guard: AgentGuard, overrides: Partial<AGRequest> = {}): Promise<string> {
    const token = tokenFrom(response(await guard.inspect(request('/.env', overrides))).body);
    await guard.inspect(request('/', { ...overrides, headers: { 'user-agent': 'curl/8.0', ...overrides.headers, authorization: token } }));
    return token;
}
