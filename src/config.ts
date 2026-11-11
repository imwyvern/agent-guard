import type { AgentGuard, AgentGuardConfig } from './types.js';
export class AgentGuardConfigError extends Error {
    override name = 'AgentGuardConfigError';
}
export function validateConfig(c: AgentGuardConfig): void {
    if (c.mode !== 'detect' && c.mode !== 'trap')
        throw new AgentGuardConfigError('mode must be "detect" or "trap"');
    validateTrap(c.trap);
    validateHooks(c.hooks);
    if (c.log?.file !== undefined && (typeof c.log.file !== 'string' || !c.log.file.trim() || c.log.file.includes('\0')))
        throw new AgentGuardConfigError('log.file must be a nonempty path');
    for (const [name, value, minimum, maximum] of [
        ['log.maxBytes', c.log?.maxBytes, 1, Number.MAX_SAFE_INTEGER],
        ['escalation.remindAfterMs', c.escalation?.remindAfterMs, 1, 2147483647],
        ['escalation.maxReminders', c.escalation?.maxReminders, 0, 100],
    ] as const)
        if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum))
            throw new AgentGuardConfigError(`${name} must be a safe integer within its limits`);
    if (c.escalation?.enabled !== undefined && typeof c.escalation.enabled !== 'boolean')
        throw new AgentGuardConfigError('escalation.enabled must be boolean');
    if (c.crawler?.verify !== undefined && ![true, false, 'dns', 'ua-bypass', 'custom'].includes(c.crawler.verify))
        throw new AgentGuardConfigError('crawler.verify must be boolean, dns, ua-bypass or custom');
    if (c.crawler?.verify === 'custom' && typeof c.crawler.customVerify !== 'function')
        throw new AgentGuardConfigError('crawler.customVerify is required for custom verification');
    for (const key of ['project', 'env', 'projectSeed'] as const)
        if (!c[key])
            throw new AgentGuardConfigError(`${key} is required`);
    if (!c.canary?.secret)
        throw new AgentGuardConfigError('canary.secret is required');
    if (c.canary.callback !== undefined) {
        try {
            const value = c.canary.callback?.baseUrl;
            if (typeof value !== 'string' || value.length > 2048 || /[\s<>"'\\]/.test(value)) throw new Error();
            const url = new URL(value);
            const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
            const authority = value.slice(value.indexOf('://') + 3).split('/')[0]!;
            if (!/^https?:\/\//i.test(value) || authority.includes('@') || url.username || url.password || value.includes('?') || value.includes('#') ||
                (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error();
        } catch { throw new AgentGuardConfigError('canary.callback.baseUrl must be an HTTPS URL without credentials, query or fragment (HTTP loopback allowed)'); }
    }
    if (!/^[A-Z][A-Z0-9]{1,15}-CANARY-$/.test(c.canary.prefix ?? 'AG-CANARY-'))
        throw new AgentGuardConfigError('invalid canary prefix');
    if (c.decoys?.siteName && !/^[a-z0-9.-]+\.invalid$/i.test(c.decoys.siteName))
        throw new AgentGuardConfigError('siteName must use .invalid');
    for (const path of Object.values(c.decoys?.paths ?? {}).flat())
        if (!path.startsWith('/') || /[\s<>?#]/.test(path))
            throw new AgentGuardConfigError('decoy paths must be absolute paths without query/fragment');
    if (c.decoys?.basePath && !/^\/[a-zA-Z0-9/_-]+$/.test(c.decoys.basePath))
        throw new AgentGuardConfigError('invalid decoy basePath');
    for (const n of Object.values(c.limits ?? {}))
        if (n !== undefined && (!Number.isSafeInteger(n) || n < 0))
            throw new AgentGuardConfigError('inspection limits must be nonnegative safe integers');
    if (c.incident?.windowMs !== undefined && (!Number.isSafeInteger(c.incident.windowMs) || c.incident.windowMs < 0))
        throw new AgentGuardConfigError('incident.windowMs must be a nonnegative safe integer');
    for (const n of [c.crawler?.timeoutMs, c.canaryScan?.maxBodyBytes, c.alerts?.dedupeWindowSec, c.alerts?.ratePerMinute])
        if (n !== undefined && (!Number.isFinite(n) || n < 0))
            throw new AgentGuardConfigError('limits must be finite and nonnegative');
}
export const hookLimits = {
    entries: 32, globalConcurrent: 16, killGraceMs: 1000,
    timeoutMs: { default: 5000, min: 1, max: 60000 },
    maxPerHour: { default: 10, min: 1, max: 100 },
    maxConcurrent: { default: 2, min: 1, max: 8 },
} as const;

export function validateHooks(hooks: AgentGuardConfig['hooks']): void {
    if (hooks === undefined) return;
    if (!Array.isArray(hooks) || hooks.length > hookLimits.entries)
        throw new AgentGuardConfigError('hooks must be an array of at most 32 entries');
    for (const hook of hooks) {
        if (!hook || typeof hook !== 'object' || !['incident_high', 'canary_replay', 'honeyfile_read'].includes(hook.on))
            throw new AgentGuardConfigError('hooks.on must be incident_high, canary_replay or honeyfile_read');
        if (!Array.isArray(hook.run) || !hook.run.length || Array.from(hook.run).some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
            !hook.run[0]!.startsWith('/') || hook.run[0]!.slice(1).split('/').some(segment => !segment))
            throw new AgentGuardConfigError('hooks.run must be literal argv with an absolute executable path without empty segments or NUL');
        for (const key of ['timeoutMs', 'maxPerHour', 'maxConcurrent'] as const) {
            const value = hook[key], bounds = hookLimits[key];
            if (value !== undefined && (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max))
                throw new AgentGuardConfigError(`hooks.${key} must be a safe integer between ${bounds.min} and ${bounds.max}`);
        }
    }
}
function validateTrap(trap: AgentGuardConfig['trap']): void {
    if (trap === undefined) return;
    const object = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value);
    if (!object(trap)) throw new AgentGuardConfigError('trap must be an object');
    for (const [name, section] of Object.entries(trap)) {
        if (section === undefined) continue;
        if (!object(section)) throw new AgentGuardConfigError(`trap.${name} must be an object`);
        if ('enabled' in section && section.enabled !== undefined && typeof section.enabled !== 'boolean')
            throw new AgentGuardConfigError(`trap.${name}.enabled must be boolean`);
    }
    const integer = (name: string, value: number | undefined, min: number, max = Number.MAX_SAFE_INTEGER): void => {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max))
            throw new AgentGuardConfigError(`trap.${name} must be an integer between ${min} and ${max}`);
    };
    integer('delay.ms', trap.delay?.ms, 0, 3000);
    integer('delay.maxConcurrent', trap.delay?.maxConcurrent, 1, 50000);
    integer('rateLimit.capacity', trap.rateLimit?.capacity, 1);
    integer('rateLimit.refillPerSec', trap.rateLimit?.refillPerSec, 0);
    integer('block.ttlMs', trap.block?.ttlMs, 1, 86400000);
    integer('block.maxKeys', trap.block?.maxKeys, 1, 50000);
    integer('maze.maxDepth', trap.maze?.maxDepth, 0, 64);
    integer('maze.maxPages', trap.maze?.maxPages, 1);
    integer('maze.maxBytes', trap.maze?.maxBytes, 1);
    integer('maze.maxDurationMs', trap.maze?.maxDurationMs, 1, 86400000);
    integer('maze.maxConcurrent', trap.maze?.maxConcurrent, 1, 8192);
    integer('maze.bytesPerMinute', trap.maze?.bytesPerMinute, 1);
    integer('gate.minScore', trap.gate?.minScore, 0);
    integer('circuit.inspectP99Ns', trap.circuit?.inspectP99Ns, 0);
    integer('circuit.eventLoopDelayMs', trap.circuit?.eventLoopDelayMs, 0);
}
const configSymbol = Symbol.for('@imwyvern/agent-guard/config');
// Symbol metadata survives independently bundled root/subpath entry points.
export const guardConfigs = {
    set(guard: AgentGuard, config: AgentGuardConfig): void { Object.defineProperty(guard, configSymbol, { value: config }); },
    get(guard: AgentGuard): AgentGuardConfig | undefined { return (guard as unknown as Record<symbol, AgentGuardConfig>)[configSymbol]; },
};
