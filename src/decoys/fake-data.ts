import { nodeCrypto } from '../crypto/node.js';
import type { CryptoProvider } from '../crypto/types.js';
import { fakeData as coreFakeData } from './fake-data-core.js';
export function fakeData(seed: string, crypto: CryptoProvider = nodeCrypto): ReturnType<typeof coreFakeData> { return coreFakeData(seed, crypto); }
