import { sanitizeEvent } from '../core/security.js';
import type { AgentGuardConfig, AgentGuardEvent } from '../types.js';
import { severityRank } from '../alerts/dispatcher.js';
import { appendJsonl, defaultLogMaxBytes } from './file.js';
export function logEvent(event: AgentGuardEvent, config: AgentGuardConfig): void {
    const local = sanitizeEvent(event);
    if (config.log?.keepIp === false)
        delete local.req.ip;
    try {
        config.onEvent?.(structuredClone(local));
    }
    catch { /* Observers cannot affect requests. */ }
    if (severityRank[event.severity] < severityRank[config.log?.level ?? 'info'])
        return;
    if (config.log?.file) {
        try {
            // Persist only metadata. A replay can put a token in a pathname or UA;
            // control-character sanitization alone would retain that token.
            const sensitive = [config.canary.secret, config.projectSeed, config.allowlist?.headerToken?.value].filter((value): value is string => !!value);
            const persistent: unknown = JSON.parse(JSON.stringify(local, (_key, value: unknown) => {
                if (typeof value !== 'string') return value;
                if (value.includes('-CANARY-') || sensitive.some(secret => value.includes(secret))) return '[redacted]';
                if (typeof config.canary.registry !== 'string' && config.canary.registry.canaries.some(entry => entry.token && value.includes(entry.token))) return '[redacted]';
                return value;
            }));
            appendJsonl(config.log.file, persistent, config.log.maxBytes ?? defaultLogMaxBytes);
        } catch { /* Disk errors cannot affect requests or observers. */ }
    }
    try {
        if (config.log?.sink)
            config.log.sink(local);
        else if (!config.log?.file)
            process.stdout.write(JSON.stringify(local) + '\n');
    }
    catch { /* Logging cannot affect requests. */ }
}
