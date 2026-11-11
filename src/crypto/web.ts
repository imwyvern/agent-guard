import type { AsyncCryptoProvider } from './types.js';
import { constantTimeEqual, utf8Encode } from './bytes.js';

const bytes = (value: string | Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(typeof value === 'string' ? utf8Encode(value) : value);
export const webCrypto: AsyncCryptoProvider = {
    async hmacSha256(secret, data) {
        // WebCrypto rejects an empty HMAC key; a zero block has the same SHA-256 HMAC padding.
        const raw = bytes(secret);
        const key = await crypto.subtle.importKey('raw', raw.length ? raw : new Uint8Array(64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        return new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(data)));
    },
    async sha256(data) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(data))); },
    randomBytes(n) {
        if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('random byte count must be a nonnegative safe integer');
        const result = new Uint8Array(n);
        for (let offset = 0; offset < n; offset += 65536) crypto.getRandomValues(result.subarray(offset, offset + 65536));
        return result;
    },
    secretEqual: (a, b) => constantTimeEqual(utf8Encode(a), utf8Encode(b)),
};
