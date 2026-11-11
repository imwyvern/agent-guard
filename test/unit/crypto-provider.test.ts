import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nodeCrypto } from '../../src/crypto/node.js';
import { utf8Encode, utf8Decode, utf8ByteLength, hex, base64, constantTimeEqual } from '../../src/crypto/bytes.js';
import { Maze } from '../../src/core/maze.js';
import { Decoys } from '../../src/decoys/index.js';
import { Registry } from '../../src/canary/registry.js';
import { config, request } from '../helpers.js';

const fixtures = [
    ['', ''], ['key', 'abc'], ['clé🔑', 'é中😀'], ['\ud800', '\udfff'],
    ['fixture-secret', 'AG-CANARY-0123456789AB'],
    ['fixture-secret', 'maze:v1|00000000000000000000|0|0'],
    ['fixture-secret', '1700000000.{"event":"canary_replay"}'],
    ['fixture-secret', '1700000000\nfixture-secret'],
    ['fixture-secret', 'callback:v1|test|0123456789AB'],
];

describe('synchronous Node crypto provider', () => {
    it.each(fixtures)('matches Node digest bytes and encodings for fixture %#', (secret, data) => {
        const expectedHmac = createHmac('sha256', secret!).update(data!).digest(), expectedHash = createHash('sha256').update(data!).digest();
        const hmac = nodeCrypto.hmacSha256(secret!, data!), hash = nodeCrypto.sha256(data!);
        expect([...hmac]).toEqual([...expectedHmac]);
        expect([...hash]).toEqual([...expectedHash]);
        expect(hex(hmac)).toBe(expectedHmac.toString('hex'));
        expect(base64(hmac)).toBe(expectedHmac.toString('base64'));
        expect(hex(hash)).toBe(expectedHash.toString('hex'));
        expect(base64(hash)).toBe(expectedHash.toString('base64'));
        expect([...nodeCrypto.hmacSha256(utf8Encode(secret!), utf8Encode(data!))]).toEqual([...expectedHmac]);
        expect([...nodeCrypto.sha256(utf8Encode(data!))]).toEqual([...expectedHash]);
    });
    it('accepts binary keys and data, including views with an offset', () => {
        const bytes = Uint8Array.from({ length: 256 }, (_, i) => i), data = bytes.subarray(2, 254), secret = bytes.subarray(1, 65);
        expect(hex(nodeCrypto.hmacSha256(secret, data))).toBe(createHmac('sha256', secret).update(data).digest('hex'));
        expect(hex(nodeCrypto.sha256(data))).toBe(createHash('sha256').update(data).digest('hex'));
    });
    it.each([0, 1, 8, 10, 32])('returns %i random bytes synchronously', n => {
        const bytes = nodeCrypto.randomBytes(n);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes).toHaveLength(n);
    });
    it.each([
        ['', '', true], ['same', 'same', true], ['same', 'samd', false], ['same', 'sam', false],
        ['é中😀', 'é中😀', true], ['é', 'ab', false], ['é', 'e', false], ['\ud800', '\ufffd', true],
    ] as const)('compares UTF-8 strings without throwing (fixture %#)', (a, b, expected) => {
        expect(nodeCrypto.secretEqual(a, b)).toBe(expected);
    });
});

describe('pure byte helpers', () => {
    it.each([0, 1, 2, 3, 4, 31, 32, 33, 255, 256])('matches Node hex and padded standard base64 for %i bytes', length => {
        const bytes = Uint8Array.from({ length: length + 4 }, (_, i) => (i * 137) & 255).subarray(2, length + 2);
        expect(hex(bytes)).toBe(Buffer.from(bytes).toString('hex'));
        expect(base64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    });
    it('compares byte lengths and every byte, including the last byte', () => {
        expect(constantTimeEqual(new Uint8Array(), new Uint8Array())).toBe(true);
        expect(constantTimeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true);
        expect(constantTimeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 2))).toBe(false);
        expect(constantTimeEqual(Uint8Array.of(1), Uint8Array.of(1, 0))).toBe(false);
        expect(constantTimeEqual(Uint8Array.of(1, 0), Uint8Array.of(1))).toBe(false);
    });
    it.each(['', 'ASCII', 'é中😀', '\ufefftext', '\ud800', '\udfff', 'x\ud800y\udfffz', '\ud800\ud800\udfff'])('matches Node UTF-8 bytes and decoding for fixture %#', text => {
        const expected = Buffer.from(text, 'utf8');
        expect([...utf8Encode(text)]).toEqual([...expected]);
        expect(utf8Decode(expected)).toBe(expected.toString('utf8'));
        expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'));
    });
    it('matches Node decoding of malformed UTF-8 and preserves a leading BOM', () => {
        for (const bytes of [Uint8Array.of(0xff, 0xc0, 0x80), Uint8Array.of(0xe2, 0x82), Uint8Array.of(0xef, 0xbb, 0xbf, 0x61)])
            expect(utf8Decode(bytes)).toBe(Buffer.from(bytes).toString('utf8'));
    });
    it('counts generated maze HTML and every decoy body exactly as Node', async () => {
        const c = config(), registry = new Registry(c.canary.registry, c.canary.secret, 'AG-CANARY-'), decoys = new Decoys(c, registry), maze = new Maze(c);
        const bodies = [maze.respond(maze.entry, 'bytes').response.body, 'é中😀'];
        for (const id of ['D1', 'D2', 'D3', 'D4', 'D5'] as const)
            bodies.push((await decoys.respond(id, request('/', { method: 'GET' }))).body);
        for (const body of bodies) expect(utf8ByteLength(body)).toBe(Buffer.byteLength(body, 'utf8'));
    });
    it('counts all UTF-16 code units and surrogate boundaries like Node', () => {
        const text = Array.from({ length: 65536 }, (_, i) => String.fromCharCode(i)).join('');
        expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'));
        for (const suffix of ['\ud800\udfff', '\udbff\udc00', '\ud800\udbff', '\udc00\udfff'])
            expect(utf8ByteLength(suffix)).toBe(Buffer.byteLength(suffix, 'utf8'));
    });
});
