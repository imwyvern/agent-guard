import { sanitizeEvent } from '../core/security.js';
import type { AlertPayload } from '../types.js';

export const asciiAlphanumeric = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function onlyCharacters(value: string, allowed: string): boolean {
    for (const character of value) if (!allowed.includes(character)) return false;
    return true;
}

export function isLoopback(host: string): boolean {
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.toLowerCase());
}

export function alertTimeout(timeoutMs = 5000): number {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
        throw new Error('alert timeout must be a positive integer');
    return timeoutMs;
}

export function alertText(alert: AlertPayload): { subject: string; text: string } {
    const source = alert.event;
    const event = sanitizeEvent({
        v: source.v, ts: source.ts, event_id: source.event_id, event: source.event,
        severity: source.severity, project: source.project, env: source.env,
        req: { method: source.req.method, path: source.req.path.split('?', 1)[0]?.split('#', 1)[0] ?? '', client_key: source.req.client_key },
        ...(source.decoy ? { decoy: { id: source.decoy.id, status: source.decoy.status } } : {}),
        ...(source.canary ? { canary: {
            id: source.canary.id, placement: source.canary.placement, env: source.canary.env,
            found_in: source.canary.found_in, field: source.canary.field,
        } } : {}),
    });
    const subject = `[agent-guard] ${event.severity} ${event.event}`;
    const lines = [subject];
    if (event.decoy) lines.push(`decoy: ${event.decoy.id}`);
    if (event.canary) lines.push(`canary: ${event.canary.id}`);
    lines.push(`path: ${event.req.path}`, `method: ${event.req.method}`, `client_key: ${event.req.client_key}`);
    return { subject, text: lines.join('\n') };
}
