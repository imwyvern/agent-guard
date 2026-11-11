import { expect, it, vi } from 'vitest';
import { checksum, generateCanary, verifyCanary } from '../../src/canary/format.js';
import { checksumAsync, formatCanary, generateCanaryAsync, verifyCanaryAsync } from '../../src/canary/format-core.js';
import { mazeMac, mazeMacAsync, mazeMacInput, encodeMazeNode, parseMazeNode, verifyMazeNode, verifyMazeNodeAsync } from '../../src/core/maze-nodes.js';
import { signWebhook, verifyWebhookSignature } from '../../src/alerts/webhook.js';
import { signWebhookAsync, verifyWebhookSignatureAsync } from '../../src/alerts/signing.js';
import { nodeCrypto } from '../../src/crypto/node.js';
import { webCrypto } from '../../src/crypto/web.js';
import { base32 } from '../../src/core/ulid-core.js';

const secret = 'run4-fixed-secret', prefix = 'AG-CANARY-', id = '0123456789AB';
const flip = (s: string, i = s.length - 1) => s.slice(0, i) + (s[i] === '0' ? '1' : '0') + s.slice(i + 1);

it('pins a fixed canary MAC and authenticates tokens across providers; every checksum character is protected', async () => {
    const token = formatCanary(prefix, id, checksum(prefix, id, secret));
    expect(token).toBe('AG-CANARY-0123456789AB-9GJNCP');
    expect(formatCanary(prefix, id, await checksumAsync(prefix, id, secret, webCrypto))).toBe(token);
    const options = { secret, prefix };
    const node = generateCanary(options), web = await generateCanaryAsync(options, webCrypto);
    expect(await verifyCanaryAsync(node.token, options, webCrypto)).toEqual({ valid: true, id: node.id });
    expect(verifyCanary(web.token, options)).toEqual({ valid: true, id: web.id });
    for (let i = token.length - 6; i < token.length; i++) {
        expect(verifyCanary(flip(token, i), options).valid).toBe(false);
        expect((await verifyCanaryAsync(flip(token, i), options, webCrypto)).valid).toBe(false);
    }
});

it.each([
    ['00000000000000000000', 0, 0, 'P3WVDGX6SNKTCZB7GFCD'],
    ['0123456789ABCDEFGHJK', 3, 2, 'PT6ZTGHKPYGSX8436XBY'],
    ['ZZZZZZZZZZZZZZZZZZZZ', 9, 65, 'BP6ACPM8ZKDMV4HJMZ02'],
    ['', 1, 1, 'BT2TB0H7H4DFCRC8MWM7'],
    ['é🔑', 2, 3, 'SQ8DM6H9FWGV0T0PKDP9'],
] as const)('pins maze MAC input and bytes (%s)', async (parent, index, depth, expected) => {
    const input = `maze:v1|${parent}|${index}|${depth}`;
    expect(mazeMacInput(parent, index, depth)).toBe(input);
    const nodeBytes = nodeCrypto.hmacSha256(secret, input), webBytes = await webCrypto.hmacSha256(secret, input);
    expect([...webBytes]).toEqual([...nodeBytes]);
    expect(base32(nodeBytes).slice(0, 20)).toBe(expected);
    expect(mazeMac(parent, index, depth, secret, nodeCrypto)).toBe(expected);
    expect(await mazeMacAsync(parent, index, depth, secret, webCrypto)).toBe(expected);
    const encoded = encodeMazeNode(parent, index, depth, expected);
    if (parent.length !== 20) { // Empty/UTF-8 parents exercise MAC bytes; wire parents must be 20 Crockford characters.
        expect(parseMazeNode(encoded)).toBeUndefined();
        return;
    }
    expect(parseMazeNode(encoded)).toEqual({ parent, index, depth, mac: expected });
    expect(verifyMazeNode(encoded, secret, nodeCrypto)).toEqual({ depth, mac: expected });
    expect(await verifyMazeNodeAsync(encoded, secret, webCrypto)).toEqual({ depth, mac: expected });
    for (let i = encoded.length - 20; i < encoded.length; i++) {
        expect(verifyMazeNode(flip(encoded, i), secret, nodeCrypto)).toBeUndefined();
        expect(await verifyMazeNodeAsync(flip(encoded, i), secret, webCrypto)).toBeUndefined();
    }
});

it.each([
    ['', '9240c76b758b2b548f45d80d8b5693e0f4df145a121d2890bde0aac6f2706ac0'],
    ['hello', 'b0abbc35bdd36498eb6a6c5c47763d5b525fb7169032966f0546664219fba809'],
    ['{"text":"こんにちは 🌍"}', 'cd31b32c70b772151d1924353a6f460df35012a4c6f1d557bfd4178b2693945d'],
])('pins webhook signatures and cross-verifies (%s)', async (body, digest) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1700000000000);
    const timestamp = '1700000000', signature = 'sha256=' + digest;
    const node = signWebhook(body!, timestamp, secret), web = await signWebhookAsync(body!, timestamp, secret, webCrypto);
    expect(node).toBe(signature); expect(web).toBe(signature);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature({ body: body!, timestamp, secret, signature: web })).toBe(true);
    expect(await verifyWebhookSignatureAsync({ body: body!, timestamp, secret, signature: node }, webCrypto)).toBe(true);
    for (const invalid of [{ signature: signature.slice(0, -1) + (Number.parseInt(signature.at(-1)!, 16) ^ 1).toString(16) }, { body: body + '\0' }, { timestamp: '1700000001' }]) {
        const input = { body: body!, timestamp, secret, signature, ...invalid };
        expect(verifyWebhookSignature(input)).toBe(false);
        expect(await verifyWebhookSignatureAsync(input, webCrypto)).toBe(false);
    }
});
