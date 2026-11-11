import { readFileSync } from 'node:fs';
import type { CanaryRegistry } from '../types.js';
import type { CryptoProvider } from '../crypto/types.js';
import { nodeCrypto } from '../crypto/node.js';
import { Registry as CoreRegistry, validateRegistry } from './registry-core.js';
export function loadRegistry(input: CanaryRegistry | string): CanaryRegistry {
    const r: CanaryRegistry = typeof input === 'string' ? JSON.parse(readFileSync(input, 'utf8')) as CanaryRegistry : structuredClone(input);
    return validateRegistry(r);
}
export class Registry extends CoreRegistry {
    constructor(input: CanaryRegistry | string, secret: string, prefix: string, crypto: CryptoProvider = nodeCrypto) {
        super(loadRegistry(input), secret, prefix, crypto);
    }
}
