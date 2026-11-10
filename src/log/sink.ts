import type { AgentGuardConfig, AgentGuardEvent } from '../types.js';
import { severityRank } from '../alerts/dispatcher.js';
export function logEvent(event: AgentGuardEvent, config: AgentGuardConfig): void {
    const local = structuredClone(event);
    if (config.log?.keepIp === false)
        delete local.req.ip;
    try {
        config.onEvent?.(structuredClone(local));
    }
    catch { /* Observers cannot affect requests. */ }
    if (severityRank[event.severity] < severityRank[config.log?.level ?? 'info'])
        return;
    try {
        if (config.log?.sink)
            config.log.sink(local);
        else
            process.stdout.write(JSON.stringify(local) + '\n');
    }
    catch { /* Logging cannot affect requests. */ }
}
