const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const hexDigits = '0123456789abcdef', base64Digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function utf8Encode(text: string): Uint8Array { return encoder.encode(text); }
export function utf8Decode(bytes: Uint8Array): string { return decoder.decode(bytes); }
export function utf8ByteLength(text: string): number {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) bytes++;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
        else bytes += 3;
    }
    return bytes;
}
export function hex(bytes: Uint8Array): string {
    let out = '';
    for (const byte of bytes) out += hexDigits[byte >> 4]! + hexDigits[byte & 15]!;
    return out;
}
export function base64(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i]!, b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
        out += base64Digits[a >> 2]! + base64Digits[((a & 3) << 4) | (b >> 4)]!
            + (i + 1 < bytes.length ? base64Digits[((b & 15) << 2) | (c >> 6)]! : '=')
            + (i + 2 < bytes.length ? base64Digits[c & 63]! : '=');
    }
    return out;
}
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
    return difference === 0;
}
