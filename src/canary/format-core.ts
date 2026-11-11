import type { CryptoProvider } from '../crypto/types.js';
import { base32 } from '../core/ulid-core.js';
import { patterns } from '../core/signals.js';
export const DEFAULT_PREFIX = 'AG-CANARY-';
export function validatePrefix(prefix: string): void {
    if (!patterns.canaryPrefix.test(prefix))
        throw new Error('invalid canary prefix');
}
export function checksum(prefix: string, id: string, secret: string, crypto: CryptoProvider): string {
    return base32(crypto.hmacSha256(secret, prefix + id)).slice(0, 6);
}
export function formatCanary(prefix: string, id: string, checksum: string): string { return `${prefix}${id}-${checksum}`; }
export function parseCanary(token: string, prefix: string): { id: string; checksum: string } | undefined {
    if (typeof token !== 'string' || typeof prefix !== 'string') return;
    try { validatePrefix(prefix); } catch { return; }
    if (token.length !== prefix.length + 19 || !token.startsWith(prefix)) return;
    const rest = token.slice(prefix.length);
    if (!patterns.canaryToken.test(rest)) return;
    return { id: rest.slice(0, 12), checksum: rest.slice(13) };
}
export function generateCanary(o: { prefix?: string; secret: string }, crypto: CryptoProvider): { id: string; token: string } {
    const prefix = o.prefix ?? DEFAULT_PREFIX;
    validatePrefix(prefix);
    if (!o.secret)
        throw new Error('canary secret is required');
    const id = base32(crypto.randomBytes(8)).slice(0, 12);
    return { id, token: formatCanary(prefix, id, checksum(prefix, id, o.secret, crypto)) };
}
export function verifyCanary(token: string, o: { prefix?: string; secret: string }, crypto: CryptoProvider): { valid: boolean; id?: string } {
    const prefix = o.prefix ?? DEFAULT_PREFIX;
    if (typeof token !== 'string' || typeof prefix !== 'string' || typeof o.secret !== 'string') return { valid: false };
    const parsed = parseCanary(token, prefix);
    if (!parsed) return { valid: false };
    const valid = crypto.secretEqual(parsed.checksum, checksum(prefix, parsed.id, o.secret, crypto));
    return valid ? { valid, id: parsed.id } : { valid };
}
