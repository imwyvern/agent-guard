import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CryptoProvider } from './types.js';

export const nodeCrypto: CryptoProvider = {
    hmacSha256: (secret, data) => createHmac('sha256', secret).update(data).digest(),
    sha256: data => createHash('sha256').update(data).digest(),
    randomBytes: n => randomBytes(n),
    secretEqual(a, b) {
        const left = Buffer.from(a), right = Buffer.from(b);
        return left.length === right.length && timingSafeEqual(left, right);
    },
};
