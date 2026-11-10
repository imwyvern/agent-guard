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
