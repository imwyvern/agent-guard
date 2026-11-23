import { describe, expect, it } from 'vitest';
import { WebBotAuthVerifier, signatureBase, verifyEd25519 } from '../../src/crawler/web-bot-auth.js';
import { decodeBase64, parseDictionary } from '../../src/crawler/sfv.js';
import type { SfInnerList } from '../../src/crawler/sfv.js';
import { rfcPublicKey } from '../fixtures/web-bot-auth.js';

const keyid = 'poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U';
// draft-ietf-webbotauth-httpsig-protocol-01 Appendix E.2; public RFC 9421 B.1.4 key.
const vectors = [
    {
        name: 'E.2.1 dictionary',
        agent: 'sig2="https://signature-agent.test"',
        input: '("@authority" "signature-agent";key="sig2");created=1735689600;keyid="' + keyid + '";alg="ed25519";expires=4889289600;nonce="n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==";tag="web-bot-auth"',
        signature: 'CGokAoY/FrPpyuzTe1Fb2kLTAH9Idw6qSFd1+D77r1firsMRCxeuLu5e6O+ek3zQgDMAzjiXtLVfqE00xnABCQ==',
        agentLine: '"signature-agent";key="sig2": "https://signature-agent.test"',
    },
    {
        name: 'E.2.2 legacy',
        agent: '"https://signature-agent.test"',
        input: '("@authority" "signature-agent");created=1735689600;keyid="' + keyid + '";alg="ed25519";expires=1735693200;nonce="e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg==";tag="web-bot-auth"',
        signature: 'jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==',
        agentLine: '"signature-agent": "https://signature-agent.test"',
    },
];

describe('published Ed25519 vectors using RFC 9421 Appendix B.1.4 public key', () => {
    it.each(vectors)('verifies independent published bytes for $name and rejects a one-byte change', async vector => {
        const request = new Request('https://example.com/foo', { headers: {
            'Signature-Agent': vector.agent, 'Signature-Input': 'sig2=' + vector.input,
            Signature: 'sig2=:' + vector.signature + ':',
        } });
        const input = parseDictionary('sig2=' + vector.input).get('sig2') as SfInnerList;
        const base = signatureBase(request, input);
        expect(base).toBe('"@authority": example.com\n' + vector.agentLine + '\n"@signature-params": ' + vector.input);
        expect(await verifyEd25519(base, decodeBase64(vector.signature), rfcPublicKey)).toBe('valid');
        expect(await verifyEd25519(base.replace('example.com', 'example.con'), decodeBase64(vector.signature), rfcPublicKey)).toBe('invalid');
        const options = { enabled: true, trustedAgents: [{ url: 'https://signature-agent.test', keys: { keys: [rfcPublicKey] } }], maxSignatureAgeSeconds: 3153600000 };
        expect(await new WebBotAuthVerifier(options).verify(request, 1735689700)).toMatchObject({ verified: true, trusted: true, keyid });
        if (vector.name.includes('E.2.1')) expect(await new WebBotAuthVerifier({ ...options, maxSignatureAgeSeconds: undefined }).verify(request, 1735689700)).toMatchObject({ verified: false, reason: 'signature_too_old' });
    });
    it.each(['index.js', 'web.js'])('verifies the published vectors through the actual %s build', async entry => {
        const url = new URL('../../dist/' + entry, import.meta.url).href;
        const build = await import(/* @vite-ignore */ url) as typeof import('../../src/index.js');
        for (const vector of vectors) {
            const request = new Request('https://example.com/foo', { headers: {
                'Signature-Agent': vector.agent, 'Signature-Input': 'sig2=' + vector.input, Signature: 'sig2=:' + vector.signature + ':',
            } });
            const verifier = new build.WebBotAuthVerifier({ enabled: true, maxSignatureAgeSeconds: 3153600000, trustedAgents: [{ url: 'https://signature-agent.test', keys: { keys: [rfcPublicKey] } }] });
            expect(await verifier.verify(request, 1735689700)).toMatchObject({ verified: true, trusted: true });
            expect(await verifier.verify(new Request(request.url.replace('example.com', 'example.con'), { headers: request.headers }), 1735689700)).toMatchObject({ verified: false, reason: 'invalid_signature' });
        }
    });
});
