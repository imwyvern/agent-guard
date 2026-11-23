import { SignatureBaseError, jwkThumbprint, signatureBase, signatureHeader, verifyEd25519 } from './http-signatures.js';
import type { SignatureRequest } from './http-signatures.js';
import { parseDictionary, parseItem } from './sfv.js';
import type { SfInnerList, SfItem } from './sfv.js';
import { WebBotAuthKeys, agentUrl, boundedOption, isJwks } from './web-bot-auth-keys.js';
import type { JsonWebKeySet, WebBotAuthOptions, WebBotAuthReason, WebBotAuthResult } from './web-bot-auth-types.js';

export type * from './web-bot-auth-types.js';
export type { SignatureRequest, AcceptSignatureOptions } from './http-signatures.js';
export { acceptSignatureHeader, signatureBase, verifyEd25519, jwkThumbprint } from './http-signatures.js';
export type { Ed25519Verification } from './http-signatures.js';

/** Signature-Agent in draft-ietf-webbotauth-httpsig-protocol-01, plus legacy sf-string. */
export function parseSignatureAgent(value: string): { legacy: true; url: string } | { legacy: false; agents: Map<string, string> } {
    if (value.trimStart().startsWith('"')) {
        const item = parseItem(value);
        if (item.bare.type !== 'string' || item.parameters.size) throw new SyntaxError('Invalid Signature-Agent');
        return { legacy: true, url: item.bare.value };
    }
    const agents = new Map<string, string>();
    for (const [label, member] of parseDictionary(value)) {
        if (member.type !== 'item' || member.bare.type !== 'string' || member.parameters.size) throw new SyntaxError('Invalid Signature-Agent');
        agents.set(label, member.bare.value);
    }
    return { legacy: false, agents };
}

const failure = (reason: WebBotAuthReason): WebBotAuthResult => ({ verified: false, trusted: false, reason });
function stringParameter(input: SfInnerList, name: string): string | undefined {
    const value = input.parameters.get(name);
    return value?.type === 'string' ? value.value : undefined;
}
function integerParameter(input: SfInnerList, name: string): number | undefined {
    const value = input.parameters.get(name);
    return value?.type === 'integer' ? value.value : undefined;
}

/**
 * Standalone verifier for draft-ietf-webbotauth-httpsig-protocol-01.
 * No nonce/replay database: expires and covered components bound replay.
 * Only a verified AND trusted result may authorize a later guard bypass.
 */
export class WebBotAuthVerifier {
    private trusted = new Map<string, JsonWebKeySet | undefined>();
    private keys: WebBotAuthKeys;
    private options: WebBotAuthOptions;
    constructor(options: WebBotAuthOptions = {}) {
        this.options = { ...options };
        if (options.fetchKeys) this.options.fetchKeys = { ...options.fetchKeys, allowHosts: [...options.fetchKeys.allowHosts] };
        this.keys = new WebBotAuthKeys(this.options.fetchKeys);
        for (const agent of options.trustedAgents ?? []) {
            const url = agentUrl(agent.url);
            if (url) this.trusted.set(url, agent.keys && isJwks(agent.keys) ? structuredClone(agent.keys) : agent.keys ? { keys: [] } : undefined);
        }
    }
    async verify(request: SignatureRequest, nowSeconds = Date.now() / 1000): Promise<WebBotAuthResult> {
        // No parsing, cryptography or discovery at all unless explicitly enabled.
        if (this.options.enabled !== true) return failure('disabled');
        try {
            const inputHeader = signatureHeader(request, 'signature-input'), signaturesHeader = signatureHeader(request, 'signature');
            if (inputHeader === undefined && signaturesHeader === undefined) return failure('unsigned');
            if (inputHeader === undefined || signaturesHeader === undefined) return failure('malformed');
            const inputs = parseDictionary(inputHeader), signatures = parseDictionary(signaturesHeader);
            const header = signatureHeader(request, 'signature-agent'), agents = header === undefined ? undefined : parseSignatureAgent(header);
            let result: WebBotAuthResult = failure('ignored');
            let verified: WebBotAuthResult | undefined;
            const deadline = Date.now() + boundedOption(this.options.fetchKeys?.timeoutMs, 2000, 5000);
            let attempted = false;
            for (const [label, input] of inputs) {
                if (attempted && Date.now() >= deadline) return verified ?? failure('key_fetch_failed');
                if (input.type !== 'inner-list') return failure('malformed');
                if (stringParameter(input, 'tag') !== 'web-bot-auth') continue;
                const signature = signatures.get(label);
                if (!signature || signature.type !== 'item' || signature.bare.type !== 'bytes' || signature.parameters.size) {
                    result = failure('malformed'); continue;
                }
                const declared = agents?.legacy ? agents.url : agents?.agents.get(label);
                const url = declared === undefined ? undefined : agentUrl(declared);
                attempted = true;
                const candidate = await this.verifyLabel(request, input, signature, label, url, agents?.legacy ?? false, nowSeconds);
                if (candidate.verified) {
                    if (candidate.trusted) return candidate;
                    verified ??= candidate;
                } else result = candidate;
            }
            return verified ?? result;
        } catch { return failure('malformed'); }
    }
    private async verifyLabel(request: SignatureRequest, input: SfInnerList, signature: SfItem, label: string, url: string | undefined, legacy: boolean, now: number): Promise<WebBotAuthResult> {
        const keyid = stringParameter(input, 'keyid');
        const fail = (reason: WebBotAuthReason): WebBotAuthResult => ({ ...failure(reason), label, ...(url ? { agent_url: url } : {}), ...(keyid ? { keyid } : {}) });
        const created = integerParameter(input, 'created'), expires = integerParameter(input, 'expires');
        if (!Number.isFinite(now) || created === undefined || expires === undefined || created < 0 || expires <= created || !keyid || keyid.length > 256) return fail('invalid_parameters');
        const skew = boundedOption(this.options.clockSkewSeconds, 60, 86400), maxAge = boundedOption(this.options.maxSignatureAgeSeconds, 86400, Number.MAX_SAFE_INTEGER);
        if (created > now + skew) return fail('created_in_future');
        if (expires <= now - skew) return fail('expired');
        if (expires - created > maxAge || now - created > maxAge + skew) return fail('signature_too_old');
        if (!input.items.some(item => item.bare.type === 'string' && item.bare.value === '@authority' && item.parameters.size === 0)
            || !input.items.some(item => item.bare.type === 'string' && item.bare.value === 'signature-agent'
                && (legacy ? item.parameters.size === 0 : item.parameters.get('key')?.type === 'string' && item.parameters.get('key')?.value === label))) return fail('missing_coverage');
        if (!url) return fail('invalid_agent');
        const alg = input.parameters.get('alg');
        if (alg && (alg.type !== 'string' || alg.value !== 'ed25519')) return fail('unsupported');
        let base: string;
        try { base = signatureBase(request, input); }
        catch (error) { return fail(error instanceof SignatureBaseError ? error.reason : 'invalid_components'); }
        if (!globalThis.crypto?.subtle) return fail('unsupported');
        const staticKeys = this.trusted.get(url);
        const jwks = staticKeys ?? await this.keys.lookup(url);
        if (!jwks) return fail(this.options.fetchKeys ? 'key_fetch_failed' : 'key_not_found');
        let matched = false;
        for (const key of jwks.keys) {
            let thumbprint: string;
            try { thumbprint = await jwkThumbprint(key); }
            catch (error) { if (error instanceof Error && error.name === 'NotSupportedError') return fail('unsupported'); continue; }
            if (thumbprint !== keyid) continue;
            matched = true;
            if (key.kty !== 'OKP' || key.crv !== 'Ed25519') return fail('unsupported');
            if (key.kid !== undefined && key.kid !== keyid || key.use !== undefined && key.use !== 'sig'
                || key.key_ops !== undefined && !key.key_ops.includes('verify')) continue;
            // JWK alg uses JOSE names; Signature-Input alg uses the HTTP signature registry.
            if (key.alg !== undefined && key.alg !== 'EdDSA' && key.alg !== 'Ed25519') return fail('unsupported');
            if (signature.bare.type !== 'bytes') return fail('malformed');
            const status = await verifyEd25519(base, signature.bare.value, key);
            if (status === 'unsupported') return fail('unsupported');
            if (status === 'valid') return { verified: true, trusted: this.trusted.has(url), agent_url: url, keyid, label };
        }
        return fail(matched ? 'invalid_signature' : 'keyid_mismatch');
    }
}
