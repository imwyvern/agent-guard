import type { JsonWebKeySet, WebBotAuthJwk } from '../../src/crawler/web-bot-auth-types.js';

export const now = 1735689700;
export const agent = 'https://agent.test/jwks.json';
export const otherAgent = 'https://other.test/jwks.json';
// Public, intentionally non-secret RFC 9421 Appendix B.1.4 test key.
export const rfcPublicKey: JsonWebKey = { kty: 'OKP', crv: 'Ed25519', x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs' };
let material: Promise<{ privateKey: CryptoKey; key: WebBotAuthJwk; keyid: string }> | undefined;
export function testKey(): NonNullable<typeof material> {
    return material ??= (async () => {
        const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
        const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
        const canonical = JSON.stringify({ crv: publicKey.crv, kty: publicKey.kty, x: publicKey.x });
        const keyid = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))).toString('base64url');
        return { privateKey: pair.privateKey, key: { ...publicKey, kid: keyid }, keyid };
    })();
}
export interface FixtureOptions {
    url?: string; agent?: string; label?: string; legacy?: boolean;
    created?: number; expires?: number; tag?: string; keyid?: string; alg?: string;
    components?: string; extraParams?: string;
}
/** Signs independently constructed bytes; no production parser or base builder is used. */
export async function signedRequest(options: FixtureOptions = {}): Promise<Request> {
    const { privateKey, keyid } = await testKey(), label = options.label ?? 'sig1';
    const url = options.url ?? 'https://origin.test/resource?x=1', agentUrl = options.agent ?? agent;
    const coveredAgent = '"signature-agent"' + (options.legacy ? '' : ';key="' + label + '"');
    const components = options.components ?? '"@authority" ' + coveredAgent;
    const input = '(' + components + ');created=' + (options.created ?? now - 100)
        + ';expires=' + (options.expires ?? now + 300) + ';keyid="' + (options.keyid ?? keyid)
        + '";alg="' + (options.alg ?? 'ed25519') + '";tag="' + (options.tag ?? 'web-bot-auth') + '"' + (options.extraParams ?? '');
    const agentValue = JSON.stringify(agentUrl);
    const base = '"@authority": ' + new URL(url).host + '\n' + coveredAgent + ': ' + agentValue + '\n"@signature-params": ' + input;
    const signature = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(base));
    return new Request(url, { headers: {
        'Signature-Agent': options.legacy ? agentValue : label + '=' + agentValue,
        'Signature-Input': label + '=' + input,
        Signature: label + '=:' + Buffer.from(signature).toString('base64') + ':',
    } });
}
export async function trustedOptions(): Promise<{ enabled: true; trustedAgents: Array<{ url: string; keys: JsonWebKeySet }> }> {
    const { key } = await testKey();
    return { enabled: true, trustedAgents: [{ url: agent, keys: { keys: [key] } }] };
}
export function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/jwk-set+json', ...headers } });
}
