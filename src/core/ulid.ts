import { randomBytes } from 'node:crypto';
export const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function base32(bytes: Uint8Array): string {
    let value = 0, bits = 0, out = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            out += alphabet[(value >>> bits) & 31];
        }
    }
    if (bits)
        out += alphabet[(value << (5 - bits)) & 31];
    return out;
}
export function ulid(): string {
    let time = Date.now(), out = '';
    for (let i = 0; i < 10; i++) {
        out = alphabet[time % 32] + out;
        time = Math.floor(time / 32);
    }
    return out + base32(randomBytes(10));
}
