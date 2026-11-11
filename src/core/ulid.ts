import { nodeCrypto } from '../crypto/node.js';
import type { CryptoProvider } from '../crypto/types.js';
import { ulid as generateUlid } from './ulid-core.js';
export { alphabet, base32 } from './ulid-core.js';
export function ulid(crypto: CryptoProvider = nodeCrypto): string { return generateUlid(crypto); }
