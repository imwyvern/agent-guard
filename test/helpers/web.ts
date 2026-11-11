import { checksum } from '../../src/canary/format.js';
import { formatCanary } from '../../src/canary/format-core.js';
import { mazeMac, mazeRoot, encodeMazeNode } from '../../src/core/maze-nodes.js';
import { nodeCrypto } from '../../src/crypto/node.js';
import type { AgentGuardConfig, CanaryRegistry } from '../../src/types.js';
import type { WebGuardConfig } from '../../src/web/index.js';

export const secret = 'run4-fixed-secret', prefix = 'AG-CANARY-', env = 'run4';
export const fixedToken = (id = '0123456789AB', p = prefix, key = secret) => formatCanary(p, id, checksum(p, id, key));
export function fixedRegistry(p = prefix): CanaryRegistry {
    const placements = ['D1:/.env#DATABASE_URL', 'D1:/.env#ADMIN_API_TOKEN', 'D1:/.env#STRIPE_SECRET_KEY', 'D3:/internal/ops-notes#password', 'D3:/internal/ops-notes#api_key', 'D4:/api/internal/openapi.json#bearer'];
    return { version: 1, prefix: p, canaries: placements.map((placement, i) => {
        const id = '0123456789A' + i;
        return { id, token: fixedToken(id, p), placement, env, createdAt: '2023-11-14T22:13:20.000Z' };
    }) };
}
export const replayToken = fixedToken('0123456789A1');
export function webConfig(overrides: Partial<WebGuardConfig> = {}): WebGuardConfig & { mode: AgentGuardConfig['mode'] } {
    return { project: 'run4', env, projectSeed: 'run4-fixed-seed', mode: 'detect',
        canary: { secret, registry: fixedRegistry() }, crawler: { verify: 'ua-bypass' },
        alerts: { adapters: [] }, log: { sink: () => {}, level: 'debug' }, ...overrides,
    } as WebGuardConfig & { mode: AgentGuardConfig['mode'] };
}
export const quietCircuit = { inspectP99Ns: Number.MAX_SAFE_INTEGER, eventLoopDelayMs: Number.MAX_SAFE_INTEGER };
export const mazeEntry = '/api/internal/archive/' + encodeMazeNode(mazeRoot, 0, 0, mazeMac(mazeRoot, 0, 0, secret, nodeCrypto));
