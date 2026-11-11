import type { CryptoProvider } from '../crypto/types.js';
import { hex } from '../crypto/bytes.js';
import { ipNumber } from './ip-parse.js';
export function clientKey(ip: string, ua: string, crypto: CryptoProvider): string {
    const parsed = ipNumber(ip);
    const network = parsed ? (parsed.value >> BigInt(parsed.bits === 32 ? 8 : 80)).toString(16) : 'unknown';
    return hex(crypto.sha256(network + '|' + ua)).slice(0, 16);
}
