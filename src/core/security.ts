import { timingSafeEqual } from 'node:crypto';
import type { AgentGuardEvent } from '../types.js';

/** Length is public; compare equal-length UTF-8 buffers without content-dependent exits. */
export function secretEqual(a: string, b: string): boolean {
    const left = Buffer.from(a), right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

/** Sanitize before reflection into a header, event, observer or log sink. */
export function sanitizeHeader(value: string, maxLength = 512): string {
    if (!Number.isFinite(maxLength) || maxLength <= 0) return '';
    return value.slice(0, Math.floor(maxLength)).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '');
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
