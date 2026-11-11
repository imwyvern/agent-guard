import type { AgentGuardConfig } from '../types.js';
import type { Registry } from '../canary/registry.js';
import type { CryptoProvider } from '../crypto/types.js';
import { nodeCrypto } from '../crypto/node.js';
import { Decoys as CoreDecoys } from './responses.js';
export class Decoys extends CoreDecoys {
    constructor(config: AgentGuardConfig, registry: Registry, crypto: CryptoProvider = nodeCrypto) { super(config, registry, crypto); }
}
