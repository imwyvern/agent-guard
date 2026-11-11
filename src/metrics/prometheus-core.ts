import type { AgentGuardEvent, AgentGuardMetrics } from '../types.js';
import type { TrapMetrics } from '../core/trap.js';

/** Bounded rolling quantiles, with lifetime sum/count. No per-client labels/state. */
export class SecondsSummary {
    private readonly samples = new Float64Array(2048);
    private count = 0;
    private sum = 0;
    observe(ms: number): void {
        if (!Number.isFinite(ms) || ms < 0) return;
        const seconds = ms / 1000;
        this.samples[this.count++ % this.samples.length] = seconds;
        this.sum += seconds;
    }
    text(name: string, help: string): string[] {
        if (!this.count) return [];
        const sorted = this.samples.slice(0, Math.min(this.count, this.samples.length)).sort();
        // Explicit suffix metadata also lets simple exposition readers treat sum
        // and count as ordinary counters. Quantiles cover the latest 2048 samples.
        return [`# HELP ${name} ${help} Quantiles over the latest 2048 samples.`, `# TYPE ${name} summary`,
            `${name}{quantile="0.5"} ${sorted[Math.floor(sorted.length * .5)]!}`,
            `${name}{quantile="0.99"} ${sorted[Math.floor(sorted.length * .99)]!}`,
            `# HELP ${name}_sum Total observed seconds.`, `# TYPE ${name}_sum counter`, `${name}_sum ${this.sum}`,
            `# HELP ${name}_count Total observations.`, `# TYPE ${name}_count counter`, `${name}_count ${this.count}`];
    }
}

export function prometheusText(data: AgentGuardMetrics, events: Readonly<Record<AgentGuardEvent['event'], number>>, clients: number, timing: number, trap?: TrapMetrics, summaries?: { alert: SecondsSummary; dwell: SecondsSummary }): string {
    const lines: string[] = [];
    const metric = (name: string, help: string, type: 'counter' | 'gauge', samples: string): void => {
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, samples);
    };
    metric('agent_guard_requests_inspected_total', 'Total requests inspected.', 'counter', `agent_guard_requests_inspected_total ${data.requests_inspected}`);
    // Preserve detect-mode series; new trap event series appear on their first event.
    metric('agent_guard_events_total', 'Total emitted events by type.', 'counter', Object.entries(events).filter(([type, count]) => !['trap_block', 'trap_circuit_open', 'exhaust_budget_spent', 'canary_callback', 'honeyfile_read', 'incident_ack', 'incident_escalated', 'incident_reminder', 'hook_result'].includes(type) || count > 0).map(([type, count]) => `agent_guard_events_total{type="${type}"} ${count}`).join('\n'));
    metric('agent_guard_alerts_sent_total', 'Total successful alert deliveries.', 'counter', `agent_guard_alerts_sent_total ${data.alerts_sent}`);
    metric('agent_guard_alerts_failed_total', 'Total failed alert deliveries.', 'counter', `agent_guard_alerts_failed_total ${data.alerts_failed}`);
    metric('agent_guard_inspect_latency_seconds', 'Inspect latency quantiles in seconds over the latest 2048 requests.', 'gauge', `agent_guard_inspect_latency_seconds{quantile="0.5"} ${data.inspect_ns_p50 / 1e9}\nagent_guard_inspect_latency_seconds{quantile="0.99"} ${data.inspect_ns_p99 / 1e9}`);
    metric('agent_guard_client_state_size', 'Client keys currently retained in detection state.', 'gauge', `agent_guard_client_state_size ${clients}`);
    metric('agent_guard_timing_state_size', 'Client keys currently retained in the timing LRU.', 'gauge', `agent_guard_timing_state_size ${timing}`);
    metric('agent_guard_trap_enabled', 'Whether trap mode is effectively enabled.', 'gauge', `agent_guard_trap_enabled ${trap?.enabled ? 1 : 0}`);
    metric('agent_guard_trap_blocked', 'Client keys currently retained in the block LRU.', 'gauge', `agent_guard_trap_blocked ${trap?.blocked ?? 0}`);
    metric('agent_guard_trap_delayed', 'Requests currently awaiting an extra trap delay.', 'gauge', `agent_guard_trap_delayed ${trap?.delayed ?? 0}`);
    metric('agent_guard_trap_maze_active', 'Current maze sessions; zero while disabled.', 'gauge', `agent_guard_trap_maze_active ${trap?.enabled ? trap.mazeActive ?? 0 : 0}`);
    if (summaries) lines.push(...summaries.alert.text('agent_guard_time_to_alert_seconds', 'Time from first touch to first successful incident alert in seconds.'),
        ...summaries.dwell.text('agent_guard_incident_dwell_seconds', 'Time from first touch to each emitted event carrying incident dwell in seconds.'));
    return lines.join('\n') + '\n';
}
