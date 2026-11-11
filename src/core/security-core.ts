import type { AgentGuardEvent } from '../types.js';
import { patterns } from './signals.js';

/** Sanitize before reflection into a header, event, observer or log sink. */
export function sanitizeHeader(value: string, maxLength = 512): string {
    if (!Number.isFinite(maxLength) || maxLength <= 0) return '';
    return value.slice(0, Math.floor(maxLength)).replace(patterns.controls, '');
}

export function sanitizeEvent(event: AgentGuardEvent): AgentGuardEvent {
    const clean = (value: unknown): unknown => {
        if (typeof value === 'string') return sanitizeHeader(value);
        if (Array.isArray(value)) return value.map(clean);
        if (value && typeof value === 'object')
            return Object.fromEntries(Object.entries(value).map(([key, v]) => [sanitizeHeader(key), clean(v)]));
        return value;
    };
    return clean(event) as AgentGuardEvent;
}
