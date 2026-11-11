import { nodeCrypto } from '../crypto/node.js';
import type { CryptoProvider } from '../crypto/types.js';
import { checksum as coreChecksum, generateCanary as coreGenerate, verifyCanary as coreVerify } from './format-core.js';
export { DEFAULT_PREFIX, validatePrefix } from './format-core.js';
export function checksum(prefix: string, id: string, secret: string, crypto: CryptoProvider = nodeCrypto): string { return coreChecksum(prefix, id, secret, crypto); }
export function generateCanary(o: { prefix?: string; secret: string }, crypto: CryptoProvider = nodeCrypto): { id: string; token: string } { return coreGenerate(o, crypto); }
export function verifyCanary(token: string, o: { prefix?: string; secret: string }, crypto: CryptoProvider = nodeCrypto): { valid: boolean; id?: string } { return coreVerify(token, o, crypto); }
