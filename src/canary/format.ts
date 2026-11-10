import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { base32 } from '../core/ulid.js';
export const DEFAULT_PREFIX = 'AG-CANARY-';
export function validatePrefix(prefix: string): void {
    if (!/^[A-Z][A-Z0-9]{1,15}-CANARY-$/.test(prefix))
        throw new Error('invalid canary prefix');
}
export function checksum(prefix: string, id: string, secret: string): string {
    return base32(createHmac('sha256', secret).update(prefix + id).digest()).slice(0, 6);
}
export function generateCanary(o: {
    prefix?: string;
    secret: string;
}): {
    id: string;
    token: string;
} {
    const prefix = o.prefix ?? DEFAULT_PREFIX;
    validatePrefix(prefix);
    if (!o.secret)
        throw new Error('canary secret is required');
    const id = base32(randomBytes(8)).slice(0, 12);
    return { id, token: `${prefix}${id}-${checksum(prefix, id, o.secret)}` };
}
export function verifyCanary(token: string, o: {
    prefix?: string;
    secret: string;
}): {
    valid: boolean;
    id?: string;
} {
    const prefix = o.prefix ?? DEFAULT_PREFIX;
    validatePrefix(prefix);
    if (!token.startsWith(prefix))
        return { valid: false };
    const rest = token.slice(prefix.length);
    if (!/^[0-9A-HJKMNP-TV-Z]{12}-[0-9A-HJKMNP-TV-Z]{6}$/.test(rest))
        return { valid: false };
    const id = rest.slice(0, 12);
    const valid = timingSafeEqual(Buffer.from(rest.slice(13)), Buffer.from(checksum(prefix, id, o.secret)));
    return valid ? { valid, id } : { valid };
}
