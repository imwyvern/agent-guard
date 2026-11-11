export type Severity = 'debug' | 'info' | 'medium' | 'high' | 'critical';
export type DecoyId = 'D1' | 'D2' | 'D3' | 'D4' | 'D5';
export type UAClass = 'browser' | 'automation' | 'verified_crawler' | 'spoofed_crawler' | 'declared_ai_crawler' | 'unknown';
export interface AGRequest {
    method: string;
    path: string;
    query: Record<string, string | string[]>;
    headers: Record<string, string | string[] | undefined>;
    ip: string;
    body?: unknown;
}
export interface AGResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}
export type AGDecision = {
    action: 'pass';
    events: AgentGuardEvent[];
} | {
    action: 'respond';
    response: AGResponse;
    events: AgentGuardEvent[];
};
export interface CanaryEntry {
    id: string;
    token: string;
    env: string;
    placement: string;
    createdAt: string;
}
export interface CanaryRegistry {
    version: 1;
    prefix: string;
    canaries: CanaryEntry[];
}
export interface AgentGuardEvent {
    v: 1;
    ts: string;
    event_id: string;
    event: 'decoy_hit' | 'canary_replay' | 'probe' | 'ai_discovery' | 'crawler_bypass' | 'alert_sent' | 'alert_failed';
    severity: Severity;
    project: string;
    env: string;
    req: {
        method: string;
        path: string;
        client_key: string;
        query_keys?: string[];
        ip?: string;
        ua?: string;
        ua_class?: UAClass;
        referer?: string;
        has_session?: boolean;
        country?: string;
    };
    decoy?: {
        id: DecoyId | 'MCP' | 'GQL';
        status: number;
    };
    canary?: {
        id: string;
        placement: string;
        env: string;
        found_in: 'header' | 'query' | 'body' | 'path';
        field: string;
        /** Registry placement where this inert token originated. */ leaked_at?: string;
        /** Replay pathname (without query). */ replayed_at?: string;
        /** Milliseconds since first decoy delivery; absent after eviction/restart. */ dwell_ms?: number;
        /** Distinct replaying client keys in bounded process-local state, saturated at 8. */ client_keys_seen?: number;
    };
    incident?: {
        id: string;
        /** Most recent 32 ordered observations; decoy hits use their IDs. */ sequence: string[];
        first_seen: string;
        last_seen: string;
        confidence: 'low' | 'medium' | 'high';
    };
    score?: number;
    signals?: string[];
    crawler?: {
        claimed: string;
        verified: boolean;
        rdns?: string;
        cache: boolean;
    };
    alert?: {
        channel: string;
        latency_ms?: number;
        status?: number;
        deduped?: boolean;
    };
}
export interface AlertPayload {
    event: AgentGuardEvent;
    summary: {
        deduped: number;
        rate_limited: number;
    };
}
export interface AlertAdapter {
    name: string;
    send(alert: AlertPayload, signal: AbortSignal): Promise<{
        ok: boolean;
        status?: number;
    }>;
}
export interface Resolver {
    reverse(ip: string): Promise<string[]>;
    resolve(host: string): Promise<string[]>;
}
/** Limits (all optional, finite nonnegative integers). Exhaustion skips/truncates inspection;
 * it never denies a request. Byte budgets count UTF-8 bytes. */
export interface InspectionLimits {
    /** Default 8192 UTF-16 code units, before URL parsing. */ maxUrlLength?: number;
    /** Default 100 header fields and 100 total value visits. */ maxHeaders?: number;
    /** Default 16384 total header name/value bytes. */ maxHeaderBytes?: number;
    /** Default 16384 body bytes/work units; overrides canaryScan.maxBodyBytes. */ maxBodyBytes?: number;
    /** Default 64 candidate occurrences, including invalid and repeated tokens. */ maxCanaryCandidates?: number;
    /** Default 100 query entries, including repeated parameters in URL parsing. */ maxQueryParams?: number;
    /** Default 16384 total query name/value bytes. */ maxQueryBytes?: number;
}
export interface AgentGuardConfig {
    /** Limits: safe defaults are documented on InspectionLimits. */ limits?: InspectionLimits;
    /** Required project label; no default. */ project: string;
    /** Required environment label; no default. */ env: string;
    /** Required; v0.1 only accepts detect. */ mode: 'detect';
    /** Required seed for deterministic fake data; no default. */ projectSeed: string;
    incident?: {
        /** Fixed window from first_seen; default 900000 ms (15 minutes). 0 disables correlation. */ windowMs?: number;
    };
    canary: {
        /** Default AG-CANARY-. */ prefix?: string;
        /** Required HMAC secret from the operator; no default. */ secret: string;
        /** Required registry object or JSON filename. Empty registries receive decoy placements in memory. */ registry: CanaryRegistry | string;
    };
    decoys?: {
        /** Default D1–D5. */ enabled?: DecoyId[];
        /** Default /api/internal. */ basePath?: string;
        /** Overrides individual default paths; arrays allowed. */ paths?: Partial<Record<DecoyId, string | string[]>>;
        /** Default project-derived .invalid domain; non-.invalid names are rejected. */ siteName?: string;
    };
    lures?: {
        /** Default manual (authoritative §9). */ robots?: 'append' | 'manual' | 'off';
        /** Default false; adds at most 120 bytes on selected paths. */ htmlComment?: {
            paths: string[];
        } | false;
        /** Default false; append a D4 reference to an existing llms.txt. */ llmsTxt?: boolean;
    };
    canaryScan?: {
        /** Default true. */ headers?: boolean;
        /** Default true. */ query?: boolean;
        /** Default /login and /api/auth/*; D5 is always scanned. */ bodyPaths?: string[];
        /** Default 16384; bounds body traversal and UTF-8 bytes; limits.maxBodyBytes takes precedence. */ maxBodyBytes?: number;
    };
    crawler?: {
        /** Default true. */ verify?: boolean;
        /** Default 300 ms. */ timeoutMs?: number;
        /** Default true on DNS errors/timeouts. */ failOpen?: boolean;
        /** Default empty; suffixes keyed by crawler family. */ extraSuffixes?: Record<string, string[]>;
        /** Default absent; offline JSON { crawler: [CIDR, ...] }. */ ipRangesFile?: string;
        /** Default node:dns/promises; inject for offline tests. */ resolver?: Resolver;
    };
    allowlist?: {
        /** Default empty. */ ips?: string[];
        /** Default empty; IPv4 and IPv6 CIDRs. */ cidrs?: string[];
        /** Default empty. Patterns outside the bounded subset (literal alternatives/groups, at most one repeated atom) are skipped. */ uaPatterns?: RegExp[];
        /** Default absent; exact match, never logged. */ headerToken?: {
            name: string;
            value: string;
        };
    };
    alerts?: {
        /** Default no adapters. */ adapters: AlertAdapter[];
        /** Default info for decoy/replay; probe/discovery remain log only unless explicitly set. */ minSeverity?: Severity;
        /** Default 600 seconds. */ dedupeWindowSec?: number;
        /** Default 30 deliveries per minute per channel. */ ratePerMinute?: number;
        /** Default true. */ redactIp?: boolean;
    };
    log?: {
        /** Default JSONL to stdout. */ sink?: (event: AgentGuardEvent) => void;
        /** Default info. */ level?: Severity;
        /** Default true for local logs. */ keepIp?: boolean;
    };
    /** Default socket IP. Override only behind a trusted proxy; forwarded headers are never implicitly trusted. */ clientIp?: (req: AGRequest) => string;
    /** Default absent; synchronous observer, exceptions isolated from requests. */ onEvent?: (event: AgentGuardEvent) => void;
}
export interface AgentGuardMetrics {
    requests_inspected: number;
    decoy_hits: Record<DecoyId | 'MCP' | 'GQL', number>;
    canary_replays: number;
    crawler_bypass: number;
    alerts_sent: number;
    alerts_failed: number;
    inspect_ns_p50: number;
    inspect_ns_p99: number;
}
export interface AgentGuard {
    /** Trusted application metadata; never populate context directly from HTTP input.
     * Scenario contexts verify crawler identity even for discovery/real requests. */
    inspect(req: AGRequest, context?: { mcp?: { toolName?: string }; graphql?: { fieldName?: string } }): Promise<AGDecision>;
    robotsLines(): string[];
    htmlCommentFor(path: string): string | null;
    metrics(): AgentGuardMetrics;
    close(): Promise<void>;
}
