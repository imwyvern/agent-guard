import type { CryptoProvider } from '../crypto/types.js';
import { hex } from '../crypto/bytes.js';
export function formatFakeData(hash: string): { site: string; database: string; region: string; revision: string; loginDelay: number } {
    return { site: `project-${hash.slice(0, 8)}.invalid`, database: `app_${hash.slice(8, 14)}`, region: `zone-${hash.slice(14, 16)}`, revision: hash.slice(16, 24), loginDelay: 300 + parseInt(hash.slice(24, 28), 16) % 301 };
}
export function fakeData(seed: string, crypto: CryptoProvider): ReturnType<typeof formatFakeData> { return formatFakeData(hex(crypto.sha256(seed))); }
