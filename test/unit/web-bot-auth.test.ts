import { describe, expect, it, vi } from 'vitest';
import { WebBotAuthVerifier, acceptSignatureHeader, parseSignatureAgent } from '../../src/crawler/web-bot-auth.js';
import { jwkThumbprint, signatureBase, verifyEd25519 } from '../../src/crawler/http-signatures.js';
import { parseDictionary } from '../../src/crawler/sfv.js';
import { agent, otherAgent, now, signedRequest, testKey, trustedOptions, jsonResponse, rfcPublicKey } from '../fixtures/web-bot-auth.js';
import type { SfInnerList } from '../../src/crawler/sfv.js';
import type { WebBotAuthReason } from '../../src/crawler/web-bot-auth-types.js';
import { createAgentGuard } from '../../src/index.js';
import { createWebGuard, memoryStore } from '../../src/web/index.js';
import { config, request as nodeRequest } from '../helpers.js';

function change(request: Request, header: string, value: string | null): Request {
    const headers = new Headers(request.headers);
    if (value === null) headers.delete(header); else headers.set(header, value);
    return new Request(request.url, { headers });
}
async function rejected(request: Request, reason: WebBotAuthReason): Promise<void> {
    const result = await new WebBotAuthVerifier(await trustedOptions()).verify(request, now);
    expect(result).toMatchObject({ verified: false, trusted: false, reason });
}

describe('WBA-2 label pairing and URL attribution', () => {
    it.each([false, true])('verifies %s legacy form against a static URL/key pair', async legacy => {
        const result = await new WebBotAuthVerifier(await trustedOptions()).verify(await signedRequest({ legacy }), now);
        expect(result).toMatchObject({ verified: true, trusted: true, agent_url: agent, label: 'sig1', keyid: (await testKey()).keyid });
    });
    it('pairs all three dictionaries by label regardless of order and unrelated tag', async () => {
        const req = await signedRequest({ label: 'second' }), unrelated = await signedRequest({ label: 'first', tag: 'other' });
        const headers = new Headers(req.headers);
        for (const name of ['signature-input', 'signature-agent']) headers.set(name, unrelated.headers.get(name) + ', ' + req.headers.get(name));
        headers.set('signature', req.headers.get('signature') + ', ' + unrelated.headers.get('signature'));
        expect(await new WebBotAuthVerifier(await trustedOptions()).verify(new Request(req.url, { headers }), now)).toMatchObject({ verified: true, label: 'second' });
    });
    it('does not use another label\'s agent member', async () => {
        const req = await signedRequest();
        await rejected(change(req, 'signature-agent', 'second="' + agent + '"'), 'invalid_agent');
        await rejected(change(req, 'signature-input', req.headers.get('signature-input')!.replace('key="sig1"', 'key="second"')), 'missing_coverage');
    });
    it('keeps a valid untrusted result observational, even for an allowed fetch host', async () => {
        const fetcher = vi.fn(async () => jsonResponse({ keys: [(await testKey()).key] }));
        const verifier = new WebBotAuthVerifier({ enabled: true, fetchKeys: { fetcher, allowHosts: ['agent.test'] } });
        expect(await verifier.verify(await signedRequest(), now)).toMatchObject({ verified: true, trusted: false, agent_url: agent });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('prefers a trusted valid signature after an untrusted valid signature', async () => {
        const a = await signedRequest({ agent: otherAgent, label: 'first' }), b = await signedRequest();
        const headers = new Headers();
        for (const name of ['signature-agent', 'signature-input', 'signature']) headers.set(name, a.headers.get(name) + ', ' + b.headers.get(name));
        const options = await trustedOptions();
        const fetcher = vi.fn(async () => jsonResponse({ keys: [(await testKey()).key] }));
        const verifier = new WebBotAuthVerifier({ ...options, fetchKeys: { fetcher, allowHosts: ['other.test'] } });
        expect(await verifier.verify(new Request(b.url, { headers }), now)).toMatchObject({ verified: true, trusted: true, label: 'sig1' });
    });
    it.each(['sig1=?1', 'sig1=("url")', 'sig1="url";x', '"url";x', 'sig1="a", sig1="b"'])('isolates malformed Signature-Agent %s', async value => {
        expect(() => parseSignatureAgent(value)).toThrow();
        await rejected(change(await signedRequest(), 'signature-agent', value), 'malformed');
    });
});

describe('WBA-3 policy checks and tamper resistance', () => {
    it.each([
        [{ expires: now - 61 }, 'expired'], [{ created: now + 61 }, 'created_in_future'],
        [{ expires: now + 86400 }, 'signature_too_old'], [{ tag: 'other' }, 'ignored'],
        [{ components: '"signature-agent";key="sig1"' }, 'missing_coverage'],
        [{ components: '"@authority"' }, 'missing_coverage'], [{ keyid: 'wrong-thumbprint' }, 'keyid_mismatch'],
        [{ expires: now - 100 }, 'invalid_parameters'], [{ alg: 'ecdsa-p256-sha256' }, 'unsupported'],
    ] as const)('rejects policy failure %#', async (options, reason) => { await rejected(await signedRequest(options), reason); });
    it.each(['created', 'expires', 'keyid'])('requires %s', async parameter => {
        const req = await signedRequest();
        await rejected(change(req, 'signature-input', req.headers.get('signature-input')!.replace(new RegExp(';' + parameter + '=(?:"[^"]*"|[0-9]+)'), '')), 'invalid_parameters');
    });
    it('checks integer timestamp types and the exact expiry/skew boundary', async () => {
        const req = await signedRequest({ expires: now - 60 });
        await rejected(req, 'expired');
        expect((await new WebBotAuthVerifier(await trustedOptions()).verify(await signedRequest({ expires: now - 59 }), now)).verified).toBe(true);
        expect((await new WebBotAuthVerifier({ ...await trustedOptions(), clockSkewSeconds: 0 }).verify(await signedRequest({ expires: now }), now)).verified).toBe(false);
        await rejected(await signedRequest({ created: now - 100.5 }), 'invalid_parameters');
    });
    it('honors configured maximum signature lifetime', async () => {
        expect(await new WebBotAuthVerifier({ ...await trustedOptions(), maxSignatureAgeSeconds: 200 }).verify(await signedRequest(), now)).toMatchObject({ reason: 'signature_too_old' });
    });
    it('rejects one byte changed in the authority, agent URL, or signature', async () => {
        const req = await signedRequest(), options = await trustedOptions();
        await rejected(new Request(req.url.replace('origin', 'origio'), { headers: req.headers }), 'invalid_signature');
        const signature = req.headers.get('signature')!;
        await rejected(change(req, 'signature', signature.replace(/=:(.)/, (_match, char: string) => '=:' + (char === 'A' ? 'B' : 'A'))), 'invalid_signature');
        const verifier = new WebBotAuthVerifier({ ...options, trustedAgents: [...options.trustedAgents, { url: otherAgent, keys: { keys: [(await testKey()).key] } }] });
        expect(await verifier.verify(change(req, 'signature-agent', 'sig1="' + otherAgent + '"'), now)).toMatchObject({ reason: 'invalid_signature' });
    });
    it('rejects repeated components, unsupported transformations, and missing fields', async () => {
        const req = await signedRequest();
        const input = req.headers.get('signature-input')!;
        await rejected(change(req, 'signature-input', input.replace('"@authority"', '"@authority" "@authority"')), 'invalid_components');
        await rejected(change(req, 'signature-input', input.replace('"@authority"', '"@authority" "@status"')), 'unsupported');
        await rejected(change(req, 'signature-input', input.replace('"@authority"', '"@authority" "content-type"')), 'invalid_components');
        await rejected(change(req, 'signature-agent', null), 'invalid_agent');
    });
    it.each(['signature', 'signature-input'])('rejects an absent %s', async header => { await rejected(change(await signedRequest(), header, null), 'malformed'); });
    it('catches all parser errors and exposes no signature bytes', async () => {
        const req = await signedRequest();
        for (const name of ['signature', 'signature-input', 'signature-agent']) await rejected(change(req, name, '('), 'malformed');
        const result = await new WebBotAuthVerifier(await trustedOptions()).verify(req, now);
        expect(JSON.stringify(result)).not.toContain(req.headers.get('signature')!.split(':')[1]);
    });
    it('thumbprints canonical key members only, including EC and RSA', async () => {
        const { key, keyid } = await testKey();
        expect(await jwkThumbprint({ x: key.x, kty: key.kty, crv: key.crv, alg: 'EdDSA', ext: false })).toBe(keyid);
        expect(await jwkThumbprint(rfcPublicKey)).toBe('poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U');
        for (const jwk of [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, { kty: 'RSA', n: 'n', e: 'AQAB' }]) {
            const canonical = Object.fromEntries(Object.entries(jwk).sort(([a], [b]) => a.localeCompare(b)));
            expect(await jwkThumbprint(jwk)).toBe(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical)))).toString('base64url'));
        }
    });
});

describe('WBA-4 key material stays bound to its complete URL', () => {
    it('rejects an A key for declared B even when the signature itself is valid', async () => {
        await rejected(await signedRequest({ agent: otherAgent }), 'key_not_found');
    });
    it('does not mix static or cached keys across paths on the same host', async () => {
        const url = agent.replace('jwks', 'second'), fetcher = vi.fn(async () => jsonResponse({ keys: [(await testKey()).key] }));
        const verifier = new WebBotAuthVerifier({ enabled: true, fetchKeys: { fetcher, allowHosts: ['agent.test'] } });
        expect((await verifier.verify(await signedRequest(), now)).verified).toBe(true);
        fetcher.mockResolvedValueOnce(jsonResponse({ keys: [] }));
        expect(await verifier.verify(await signedRequest({ agent: url }), now)).toMatchObject({ verified: false, reason: 'key_fetch_failed' });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('never trusts a self-declared URL with a matching keyid but no associated keys', async () => {
        const options = await trustedOptions();
        const verifier = new WebBotAuthVerifier({ ...options, trustedAgents: [...options.trustedAgents, { url: otherAgent }] });
        expect(await verifier.verify(await signedRequest({ agent: otherAgent }), now)).toMatchObject({ verified: false, trusted: false });
    });
});

describe('WBA-9 unavailable algorithms fail closed without throwing', () => {
    it('returns unsupported when WebCrypto rejects Ed25519', async () => {
        const req = await signedRequest(), verifier = new WebBotAuthVerifier(await trustedOptions());
        vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(new DOMException('Not available', 'NotSupportedError'));
        await expect(verifier.verify(req, now)).resolves.toMatchObject({ verified: false, trusted: false, reason: 'unsupported' });
    });
    it('returns invalid for import or verification errors', async () => {
        const req = await signedRequest(), verifier = new WebBotAuthVerifier(await trustedOptions());
        vi.spyOn(crypto.subtle, 'verify').mockRejectedValue(new Error('bad signature'));
        await expect(verifier.verify(req, now)).resolves.toMatchObject({ reason: 'invalid_signature' });
    });
    it('returns unsupported when crypto is absent', async () => {
        const req = await signedRequest(), verifier = new WebBotAuthVerifier(await trustedOptions());
        vi.spyOn(globalThis, 'crypto', 'get').mockReturnValue(undefined as unknown as Crypto);
        expect(await verifier.verify(req, now)).toMatchObject({ reason: 'unsupported', verified: false });
    });
});

describe('WBA-10 Accept-Signature is an explicit helper', () => {
    it.each([{}, { label: 'bot' }, { label: 'legacy', legacy: true }])('round trips options %j', options => {
        const value = acceptSignatureHeader(options), member = parseDictionary(value).get(options.label ?? 'sig1') as SfInnerList;
        expect(member.type).toBe('inner-list');
        expect(member.items.map(item => item.bare.value)).toEqual(['@authority', 'signature-agent']);
        expect(member.parameters.get('tag')).toEqual({ type: 'string', value: 'web-bot-auth' });
        expect(member.items[1]?.parameters.get('key')?.value).toBe(options.legacy ? undefined : options.label ?? 'sig1');
    });
    it('rejects invalid labels including header injection', () => {
        expect(() => acceptSignatureHeader({ label: 'bad\r\nHeader' })).toThrow();
    });
    it('leaves ordinary and decoy guard responses without Accept-Signature', async () => {
        const node = createAgentGuard(config()), web = createWebGuard({ ...config(), crawler: { verify: 'ua-bypass' }, store: memoryStore() });
        try {
            for (const path of ['/', '/.env']) {
                const decision = await node.inspect(nodeRequest(path));
                if (decision.action === 'respond') expect(Object.keys(decision.response.headers).map(name => name.toLowerCase())).not.toContain('accept-signature');
                const response = await web.handle(new Request('https://origin.test' + path));
                expect(response?.headers.has('accept-signature') ?? false).toBe(false);
            }
        } finally { await node.close(); await web.close(); }
    });
});

it('constructs ordinary request components and trims and combines field lines per RFC 9421', async () => {
    const input = parseDictionary('a=("@method" "@authority" "@scheme" "@target-uri" "@path" "@query" "x-test");created=1').get('a') as SfInnerList;
    expect(signatureBase({ url: 'https://EXAMPLE.test:443/path?x=1', method: 'POST', headers: { 'X-Test': ['  first\t', '\tsecond  '] } }, input)).toBe(
        '"@method": POST\n"@authority": example.test\n"@scheme": https\n"@target-uri": https://example.test/path?x=1\n"@path": /path\n"@query": ?x=1\n"x-test": first, second\n"@signature-params": ("@method" "@authority" "@scheme" "@target-uri" "@path" "@query" "x-test");created=1');
    expect(await verifyEd25519('tampered', new Uint8Array(64), rfcPublicKey)).toBe('invalid');
});
