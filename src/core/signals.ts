// Keep shared literals in the existing regex audit inventory without changing docs.
export const patterns = {
    bearer: /^Bearer\s+/i,
    repeatedSlash: /\/+/g,
    canaryPrefix: /^[A-Z][A-Z0-9]{1,15}-CANARY-$/,
    canaryToken: /^[0-9A-HJKMNP-TV-Z]{12}-[0-9A-HJKMNP-TV-Z]{6}$/,
    registryToken: /^[0-9A-HJKMNP-TV-Z]{12}-[0-9A-HJKMNP-TV-Z]{6}$/,
    callbackPath: /^\/ag\/cb\/AGCB-CANARY-([0-9A-HJKMNP-TV-Z]{12})-([0-9A-HJKMNP-TV-Z]{20})$/,
    mazeNode: /^[0-9A-HJKMNP-TV-Z]{43}$/,
    webhookTimestamp: /^\d+$/,
    webhookSignature: /^sha256=[a-f0-9]{64}$/,
    controls: /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g,
    trailingSlash: /\/$/,
    ampersand: /&/g,
    lessThan: /</g,
    quote: /"/g,
};

export const weights: Record<string, number> = { decoy_path: 50, canary_replay: 100, ai_discovery_path: 10, probe_path: 15, ua_spoof_crawler: 30, ua_automation: 10, robots_then_disallowed: 20 };
const discoveryPath = /^\/(?:llms\.txt|\.well-known\/(?:mcp|ai-plugin)\.json|openapi\.json|swagger[^/]*)$/;
const probePath = /^\/(?:wp-admin(?:\/|$)|\.git\/|phpinfo\.php$|actuator(?:\/|$)|admin$|debug$)/;
export function pathSignal(path: string): 'probe' | 'ai_discovery' | undefined {
    if (discoveryPath.test(path))
        return 'ai_discovery';
    if (probePath.test(path))
        return 'probe';
    return;
}
