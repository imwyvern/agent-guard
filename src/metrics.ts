import type { AgentGuardMetrics, AgentGuardEvent } from './types.js';
export class Metrics {
    private data: AgentGuardMetrics = { requests_inspected: 0, decoy_hits: { D1: 0, D2: 0, D3: 0, D4: 0, D5: 0 }, canary_replays: 0, crawler_bypass: 0, alerts_sent: 0, alerts_failed: 0, inspect_ns_p50: 0, inspect_ns_p99: 0 };
    private samples: number[] = [];
    private cursor = 0;
    request(ns: number): void { this.data.requests_inspected++; this.samples[this.cursor++ % 2048] = ns; }
    event(e: AgentGuardEvent): void {
        if (e.event === 'decoy_hit')
            this.data.decoy_hits[e.decoy!.id]++;
        if (e.event === 'canary_replay')
            this.data.canary_replays++;
        if (e.event === 'crawler_bypass')
            this.data.crawler_bypass++;
        if (e.event === 'alert_sent')
            this.data.alerts_sent++;
        if (e.event === 'alert_failed')
            this.data.alerts_failed++;
    }
    snapshot(): AgentGuardMetrics { const sorted = [...this.samples].sort((a, b) => a - b); return { ...this.data, decoy_hits: { ...this.data.decoy_hits }, inspect_ns_p50: sorted[Math.floor(sorted.length * .5)] ?? 0, inspect_ns_p99: sorted[Math.floor(sorted.length * .99)] ?? 0 }; }
}
