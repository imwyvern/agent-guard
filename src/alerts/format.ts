import { sanitizeEvent } from '../core/security.js';
import type { AgentGuardEvent, AlertPayload } from '../types.js';
import { redactIp } from '../core/client-key.js';
export function formatAlert(event: AgentGuardEvent, summary: AlertPayload['summary'], redact = true): AlertPayload {
    const copy = sanitizeEvent(event);
    if (redact && copy.req.ip)
        copy.req.ip = redactIp(copy.req.ip);
    return { event: copy, summary: { ...summary } };
}
