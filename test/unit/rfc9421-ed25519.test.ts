import { describe, expect, it } from 'vitest';
import * as source from '../../src/crawler/http-signatures.js';
import { parseDictionary } from '../../src/crawler/sfv.js';
import { rfcPublicKey } from '../fixtures/web-bot-auth.js';

// Transcribed only from the maintainer's local rfc9421.txt: B.2 request and B.2.6.
// RFC 8792 continuation backslashes/indentation are removed; spaces are preserved.
// rfcPublicKey is the public JWK from B.1.4; no private key or signing is needed.
const signatureInput = 'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"';
const signatureHeader = 'sig-b26=:wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==:';
// Independent, literal expected base, including LF separators and no final LF.
const expectedBase = [
    '"date": Tue, 20 Apr 2021 02:07:55 GMT',
    '"@method": POST',
    '"@path": /foo',
    '"@authority": example.com',
    '"content-type": application/json',
    '"content-length": 18',
    '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
].join('\n');

describe('WBA-1 RFC 9421 Appendix B.2.6 with the B.1.4 public key', () => {
    it.each(['src', 'index.js', 'web.js'])('reproduces the exact base and rejects one-byte changes through %s', async entry => {
        const implementation = entry === 'src' ? source : await import(/* @vite-ignore */ new URL('../../dist/' + entry, import.meta.url).href) as Pick<typeof source, 'signatureBase' | 'verifyEd25519'>;
        const request = new Request('https://example.com/foo?param=Value&Pet=dog', {
            method: 'POST',
            headers: {
                Host: 'example.com',
                Date: 'Tue, 20 Apr 2021 02:07:55 GMT',
                'Content-Type': 'application/json',
                'Content-Digest': 'sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
                'Content-Length': '18',
                'Signature-Input': signatureInput,
                Signature: signatureHeader,
            },
            body: '{"hello": "world"}',
        });
        const input = parseDictionary(request.headers.get('signature-input')!).get('sig-b26')!;
        const signature = parseDictionary(request.headers.get('signature')!).get('sig-b26')!;
        if (input.type !== 'inner-list' || signature.type !== 'item' || signature.bare.type !== 'bytes') throw new Error('Invalid RFC fixture');

        const base = implementation.signatureBase(request, input);
        expect(base).toBe(expectedBase);
        expect(await implementation.verifyEd25519(base, signature.bare.value, rfcPublicKey)).toBe('valid');

        const headers = new Headers(request.headers);
        headers.set('content-length', '19');
        const alteredBase = implementation.signatureBase({ url: request.url, method: request.method, headers }, input);
        expect(alteredBase).toBe(expectedBase.replace('"content-length": 18', '"content-length": 19'));
        expect(await implementation.verifyEd25519(alteredBase, signature.bare.value, rfcPublicKey)).toBe('invalid');

        const alteredSignature = signature.bare.value.slice();
        alteredSignature[0] = alteredSignature[0]! ^ 1;
        expect(await implementation.verifyEd25519(base, alteredSignature, rfcPublicKey)).toBe('invalid');
    });
});
