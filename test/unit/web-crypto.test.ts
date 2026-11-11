import { expect, it } from 'vitest';
import { webCrypto } from '../../src/crypto/web.js';
import { nodeCrypto } from '../../src/crypto/node.js';
import { base64, hex, utf8Encode } from '../../src/crypto/bytes.js';
import { generateCanaryAsync, verifyCanary, verifyCanaryAsync } from '../../src/canary/format-core.js';

it.each([
    ['', ''], ['secret', 'abc'], ['密钥🔑', 'こんにちは 🌍\0'],
    [new Uint8Array([0, 255, 128]), new Uint8Array([255, 0, 1])],
    ['a'.repeat(200), 'long key'],
])('matches Node HMAC and SHA-256 bytes and encodings (%#)', async (secret, data) => {
    const hmac = await webCrypto.hmacSha256(secret!, data!), hash = await webCrypto.sha256(data!);
    expect([...hmac]).toEqual([...nodeCrypto.hmacSha256(secret!, data!)]);
    expect([...hash]).toEqual([...nodeCrypto.sha256(data!)]);
    for (const bytes of [hmac, hash, utf8Encode('é'), new Uint8Array(), new Uint8Array([255])]) {
        expect(hex(bytes)).toBe(Buffer.from(bytes).toString('hex'));
        expect(base64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
});
it.each([['', ''], ['密钥🔑', '密钥🔑'], ['same', 'sand'], ['a', 'ab'], ['é', 'e\u0301'], ['\ud800', '\ufffd']])('compares UTF-8 secrets like Node (%#)', (a, b) => {
    expect(webCrypto.secretEqual(a!, b!)).toBe(nodeCrypto.secretEqual(a!, b!));
});
it('generates random bytes including chunks larger than the WebCrypto quota', () => {
    expect(webCrypto.randomBytes(0)).toHaveLength(0);
    const bytes = webCrypto.randomBytes(70_000);
    expect(bytes).toHaveLength(70_000);
    expect(bytes.some(b => b !== 0)).toBe(true);
    expect(() => webCrypto.randomBytes(-1)).toThrow();
});
it('authenticates async canaries with both providers and rejects tampering', async () => {
    const options = { secret: 'fixture secret' }, generated = await generateCanaryAsync(options, webCrypto);
    expect(verifyCanary(generated.token, options, nodeCrypto)).toEqual({ valid: true, id: generated.id });
    expect(await verifyCanaryAsync(generated.token, options, webCrypto)).toEqual({ valid: true, id: generated.id });
    expect((await verifyCanaryAsync(generated.token, { secret: 'wrong' }, webCrypto)).valid).toBe(false);
    expect((await verifyCanaryAsync('invalid', options, webCrypto)).valid).toBe(false);
});
