import { base64, utf8Encode } from '../crypto/bytes.js';
import { parseDictionary, serializeBareItem, serializeMember } from './sfv.js';
import type { SfInnerList, SfItem } from './sfv.js';

export interface SignatureRequest {
    /** Absolute URL as observed by the origin; do not trust forwarded headers implicitly. */
    url: string;
    method: string;
    headers: Headers | Record<string, string | string[] | undefined>;
}
export class SignatureBaseError extends Error {
    constructor(readonly reason: 'invalid_components' | 'unsupported') { super(reason); }
}

export function signatureHeader(request: SignatureRequest, name: string): string | undefined {
    const headers = request.headers;
    const values = headers instanceof Headers ? [headers.get(name) ?? undefined]
        : Object.entries(headers).filter(([key]) => key.toLowerCase() === name).flatMap(([, value]) => value);
    const present = values.filter((value): value is string => value !== undefined);
    if (!present.length) return;
    if (present.some(value => /[^\x09\x20-\x7e]/.test(value))) throw new SignatureBaseError('invalid_components');
    return present.map(value => {
        let start = 0, end = value.length;
        while (value[start] === ' ' || value[start] === '\t') start++;
        while (end > start && (value[end - 1] === ' ' || value[end - 1] === '\t')) end--;
        return value.slice(start, end);
    }).join(', ');
}

function componentValue(request: SignatureRequest, component: SfItem): string {
    if (component.bare.type !== 'string') throw new SignatureBaseError('invalid_components');
    const name = component.bare.value, parameters = component.parameters;
    if (name.startsWith('@')) {
        if (parameters.size) throw new SignatureBaseError('unsupported');
        const url = new URL(request.url);
        switch (name) {
            case '@method': return request.method;
            case '@authority': return url.host;
            case '@scheme': return url.protocol.slice(0, -1);
            case '@target-uri': return url.href.replace(/#.*$/, '');
            case '@path': return url.pathname || '/';
            case '@query': return url.search || '?';
            default: throw new SignatureBaseError('unsupported');
        }
    }
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || name === 'signature') throw new SignatureBaseError('invalid_components');
    if ([...parameters.keys()].some(key => key !== 'key' && key !== 'sf' && key !== 'bs')) throw new SignatureBaseError('unsupported');
    const value = signatureHeader(request, name);
    if (value === undefined) throw new SignatureBaseError('invalid_components');
    const key = parameters.get('key'), sf = parameters.get('sf'), bs = parameters.get('bs');
    if (key) {
        if (key.type !== 'string' || bs || sf && (sf.type !== 'boolean' || !sf.value)) throw new SignatureBaseError('invalid_components');
        const member = parseDictionary(value).get(key.value);
        if (!member) throw new SignatureBaseError('invalid_components');
        return serializeMember(member);
    }
    // Other RFC 9421 transformations need a field schema (sf) or original field lines (bs).
    if (sf || bs) throw new SignatureBaseError('unsupported');
    return value;
}

/** RFC 9421 section 2.5; unsupported component transformations fail closed. */
export function signatureBase(request: SignatureRequest, input: SfInnerList): string {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(request.method)) throw new SignatureBaseError('invalid_components');
    const seen = new Set<string>();
    const lines = input.items.map(component => {
        const identifier = serializeMember(component);
        if (seen.has(identifier)) throw new SignatureBaseError('invalid_components');
        seen.add(identifier);
        return identifier + ': ' + componentValue(request, component);
    });
    lines.push('"@signature-params": ' + serializeMember(input));
    return lines.join('\n');
}

export type Ed25519Verification = 'valid' | 'invalid' | 'unsupported';
/** Cryptographic primitive only: Web Bot Auth policy is enforced by WebBotAuthVerifier. */
export async function verifyEd25519(base: string, signature: Uint8Array, jwk: JsonWebKey): Promise<Ed25519Verification> {
    if (!globalThis.crypto?.subtle) return 'unsupported';
    try {
        const key = await globalThis.crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify']);
        return await globalThis.crypto.subtle.verify('Ed25519', key, new Uint8Array(signature), new Uint8Array(utf8Encode(base))) ? 'valid' : 'invalid';
    } catch (error) {
        return error instanceof Error && error.name === 'NotSupportedError' ? 'unsupported' : 'invalid';
    }
}

/** RFC 8037 / RFC 7638 SHA-256 thumbprint, independent of kid and metadata. */
export async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
    let members: Record<string, string | undefined>;
    switch (jwk.kty) {
        case 'OKP': members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x }; break;
        case 'EC': members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }; break;
        case 'RSA': members = { e: jwk.e, kty: jwk.kty, n: jwk.n }; break;
        default: throw new TypeError('Unsupported JWK type');
    }
    if (Object.values(members).some(value => typeof value !== 'string' || !value)) throw new TypeError('Incomplete JWK');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(utf8Encode(JSON.stringify(members))));
    return base64(new Uint8Array(digest)).replace(/\+/g, '-').replace(/\//g, '_').split('=', 1)[0]!;
}

export interface AcceptSignatureOptions { label?: string; legacy?: boolean }
/** Opt-in response helper; never attached to a response automatically. */
export function acceptSignatureHeader(options: AcceptSignatureOptions = {}): string {
    const label = options.label ?? 'sig1';
    if (!/^[a-z*][a-z0-9_.*-]*$/.test(label)) throw new TypeError('Invalid signature label');
    return label + '=("@authority" "signature-agent"' + (options.legacy ? '' : ';key=' + serializeBareItem({ type: 'string', value: label })) + ');tag="web-bot-auth"';
}
