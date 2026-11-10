import { createHash } from 'node:crypto';
export function fakeData(seed: string): {
    site: string;
    database: string;
    region: string;
    revision: string;
    loginDelay: number;
} {
    const hash = createHash('sha256').update(seed).digest('hex');
    return { site: `project-${hash.slice(0, 8)}.invalid`, database: `app_${hash.slice(8, 14)}`, region: `zone-${hash.slice(14, 16)}`, revision: hash.slice(16, 24), loginDelay: 300 + parseInt(hash.slice(24, 28), 16) % 301 };
}
