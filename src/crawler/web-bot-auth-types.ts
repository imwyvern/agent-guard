import type { StateStore } from '../state/store.js';

export interface WebBotAuthJwk extends JsonWebKey { kid?: string }
export interface JsonWebKeySet { keys: WebBotAuthJwk[] }
export interface WebBotAuthFetchOptions {
    fetcher: (url: string, init: { signal: AbortSignal; headers: Record<string, string>; redirect: 'manual' }) => Promise<Response>;
    /** Exact hostnames, compared case insensitively; no wildcards or subdomain matching. */
    allowHosts: string[];
    timeoutMs?: number;
    maxBytes?: number;
    cache?: StateStore;
    maxTtlSeconds?: number;
}
export interface WebBotAuthOptions {
    enabled?: boolean;
    trustedAgents?: Array<{ url: string; keys?: JsonWebKeySet }>;
    fetchKeys?: WebBotAuthFetchOptions;
    clockSkewSeconds?: number;
    maxSignatureAgeSeconds?: number;
}
export type WebBotAuthReason = 'disabled' | 'unsigned' | 'ignored' | 'malformed' | 'invalid_parameters'
    | 'expired' | 'created_in_future' | 'signature_too_old' | 'missing_coverage' | 'invalid_components'
    | 'invalid_agent' | 'key_not_found' | 'keyid_mismatch' | 'key_fetch_failed' | 'unsupported' | 'invalid_signature';
/** No signature bytes are returned. Trust requires BOTH verified and trusted. */
export type WebBotAuthResult =
    | { verified: true; trusted: boolean; agent_url: string; keyid: string; label: string }
    | { verified: false; trusted: false; reason: WebBotAuthReason; agent_url?: string; keyid?: string; label?: string };
