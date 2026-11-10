import type { AgentGuard, AgentGuardConfig } from './types.js';
export class AgentGuardConfigError extends Error {
    override name = 'AgentGuardConfigError';
}
export function validateConfig(c: AgentGuardConfig): void {
    if (c.mode !== 'detect')
        throw new AgentGuardConfigError('v0.1 supports mode="detect" only');
    for (const key of ['project', 'env', 'projectSeed'] as const)
        if (!c[key])
            throw new AgentGuardConfigError(`${key} is required`);
    if (!c.canary?.secret)
        throw new AgentGuardConfigError('canary.secret is required');
    if (!/^[A-Z][A-Z0-9]{1,15}-CANARY-$/.test(c.canary.prefix ?? 'AG-CANARY-'))
        throw new AgentGuardConfigError('invalid canary prefix');
    if (c.decoys?.siteName && !/^[a-z0-9.-]+\.invalid$/i.test(c.decoys.siteName))
        throw new AgentGuardConfigError('siteName must use .invalid');
    for (const path of Object.values(c.decoys?.paths ?? {}).flat())
        if (!path.startsWith('/') || /[\s<>?#]/.test(path))
            throw new AgentGuardConfigError('decoy paths must be absolute paths without query/fragment');
    if (c.decoys?.basePath && !/^\/[a-zA-Z0-9/_-]+$/.test(c.decoys.basePath))
        throw new AgentGuardConfigError('invalid decoy basePath');
    for (const n of [c.crawler?.timeoutMs, c.canaryScan?.maxBodyBytes, c.alerts?.dedupeWindowSec, c.alerts?.ratePerMinute])
        if (n !== undefined && (!Number.isFinite(n) || n < 0))
            throw new AgentGuardConfigError('limits must be finite and nonnegative');
}
const configSymbol = Symbol.for('@imwyvern/agent-guard/config');
// Symbol metadata survives independently bundled root/subpath entry points.
export const guardConfigs = {
    set(guard: AgentGuard, config: AgentGuardConfig): void { Object.defineProperty(guard, configSymbol, { value: config }); },
    get(guard: AgentGuard): AgentGuardConfig | undefined { return (guard as unknown as Record<symbol, AgentGuardConfig>)[configSymbol]; },
};
