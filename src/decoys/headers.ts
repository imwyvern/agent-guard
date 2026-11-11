import { sanitizeHeader } from '../core/security-core.js';
export function decoyHeaders(type: string): Record<string, string> {
    return { 'Content-Type': sanitizeHeader(type + '; charset=utf-8'), 'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet', 'Cache-Control': 'no-store' };
}
