import { nodeCrypto } from '../crypto/node.js';
export { sanitizeHeader, sanitizeEvent } from './security-core.js';
export const secretEqual = nodeCrypto.secretEqual;
