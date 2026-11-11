import type { AgentGuardMetrics, AgentGuardEvent } from './types.js';
import { prometheusText, SecondsSummary } from './metrics/prometheus-core.js';
import type { TrapMetrics } from './core/trap.js';
export class Metrics {
    private data: AgentGuardMetrics = { requests_inspected: 0, decoy_hits: { D1: 0, D2: 0, D3: 0, D4: 0, D5: 0, MCP: 0, GQL: 0 }, canary_replays: 0, crawler_bypass: 0, alerts_sent: 0, alerts_failed: 0, inspect_ns_p50: 0, inspect_ns_p99: 0 };
    private samples: number[] = [];
    private cursor = 0;
    private events: Record<AgentGuardEvent['event'], number> = { decoy_hit: 0, canary_replay: 0, probe: 0, ai_discovery: 0, crawler_bypass: 0, alert_sent: 0, alert_failed: 0, trap_block: 0, trap_circuit_open: 0, exhaust_budget_spent: 0, canary_callback: 0, honeyfile_read: 0, incident_ack: 0, incident_escalated: 0, incident_reminder: 0 };
    private readonly summaries = { alert: new SecondsSummary(), dwell: new SecondsSummary() };
    timeToAlert(ms: number): void { this.summaries.alert.observe(ms); }
    request(ns: number): void { this.data.requests_inspected++; this.samples[this.cursor++ % 2048] = ns; }
    event(e: AgentGuardEvent): void {
        this.events[e.event]++;
        if (e.incident?.dwell_ms !== undefined) this.summaries.dwell.observe(e.incident.dwell_ms);
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
    prometheusText(clients: number, timing: number, trap?: TrapMetrics): string { return prometheusText(this.snapshot(), this.events, clients, timing, trap, this.summaries); }
}
