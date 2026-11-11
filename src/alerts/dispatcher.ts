import type { AgentGuardConfig, AgentGuardEvent } from '../types.js';
import { nodeCrypto } from '../crypto/node.js';
import { Dispatcher as CoreDispatcher } from './dispatcher-core.js';
export { severityRank } from './dispatcher-core.js';
export class Dispatcher extends CoreDispatcher {
    constructor(config: AgentGuardConfig['alerts'], emit: (event: AgentGuardEvent) => void) { super(config, emit, nodeCrypto); }
}
