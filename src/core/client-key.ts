import { nodeCrypto } from '../crypto/node.js';
import type { CryptoProvider } from '../crypto/types.js';
import { clientKey as hashClientKey } from './client-key-core.js';
export { ipNumber, inCidr, redactIp } from './ip-parse.js';
export function clientKey(ip: string, ua: string, crypto: CryptoProvider = nodeCrypto): string { return hashClientKey(ip, ua, crypto); }
