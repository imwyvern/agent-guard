import { nodeCrypto } from '../crypto/node.js';
import type { CryptoProvider } from '../crypto/types.js';
import { Incidents as CoreIncidents } from './incidents-core.js';
export class Incidents extends CoreIncidents {
    constructor(windowMs = 15 * 60_000, now: () => number = Date.now, capacity = 50_000, crypto: CryptoProvider = nodeCrypto) { super(crypto, windowMs, now, capacity); }
}
