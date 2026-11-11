import type { CryptoProvider, AsyncCryptoProvider } from '../crypto/types.js';
import { hex } from '../crypto/bytes.js';
import { ipNumber } from './ip-parse.js';
export function clientKey(ip: string, ua: string, crypto: CryptoProvider): string {
    const parsed = ipNumber(ip);
    const network = parsed ? (parsed.value >> BigInt(parsed.bits === 32 ? 8 : 80)).toString(16) : 'unknown';
    return hex(crypto.sha256(network + '|' + ua)).slice(0, 16);
}

export async function clientKeyAsync(ip: string, ua: string, crypto: AsyncCryptoProvider): Promise<string> {
    const parsed = ipNumber(ip);
    const network = parsed ? (parsed.value >> BigInt(parsed.bits === 32 ? 8 : 80)).toString(16) : 'unknown';
    return hex(await crypto.sha256(network + '|' + ua)).slice(0, 16);
}
