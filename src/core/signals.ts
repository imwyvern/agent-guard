export const weights: Record<string, number> = { decoy_path: 50, canary_replay: 100, ai_discovery_path: 10, probe_path: 15, ua_spoof_crawler: 30, ua_automation: 10, robots_then_disallowed: 20 };
export function pathSignal(path: string): 'probe' | 'ai_discovery' | undefined {
    if (/^\/(?:llms\.txt|\.well-known\/(?:mcp|ai-plugin)\.json|openapi\.json|swagger[^/]*)$/.test(path))
        return 'ai_discovery';
    if (/^\/(?:wp-admin(?:\/|$)|\.git\/|phpinfo\.php$|actuator(?:\/|$)|admin$|debug$)/.test(path))
        return 'probe';
    return;
}
