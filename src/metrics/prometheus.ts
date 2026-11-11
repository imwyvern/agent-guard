import type { RequestListener } from 'node:http';
import type { AgentGuard, AgentGuardEvent, AgentGuardMetrics } from '../types.js';

export function prometheusText(data: AgentGuardMetrics, events: Readonly<Record<AgentGuardEvent['event'], number>>, clients: number, timing: number): string {
    const lines: string[] = [];
    const metric = (name: string, help: string, type: 'counter' | 'gauge', samples: string): void => {
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, samples);
    };
    metric('agent_guard_requests_inspected_total', 'Total requests inspected.', 'counter', `agent_guard_requests_inspected_total ${data.requests_inspected}`);
    metric('agent_guard_events_total', 'Total emitted events by type.', 'counter', Object.entries(events).map(([type, count]) => `agent_guard_events_total{type="${type}"} ${count}`).join('\n'));
    metric('agent_guard_alerts_sent_total', 'Total successful alert deliveries.', 'counter', `agent_guard_alerts_sent_total ${data.alerts_sent}`);
    metric('agent_guard_alerts_failed_total', 'Total failed alert deliveries.', 'counter', `agent_guard_alerts_failed_total ${data.alerts_failed}`);
    metric('agent_guard_inspect_latency_seconds', 'Inspect latency quantiles in seconds over the latest 2048 requests.', 'gauge', `agent_guard_inspect_latency_seconds{quantile="0.5"} ${data.inspect_ns_p50 / 1e9}\nagent_guard_inspect_latency_seconds{quantile="0.99"} ${data.inspect_ns_p99 / 1e9}`);
    metric('agent_guard_client_state_size', 'Client keys currently retained in detection state.', 'gauge', `agent_guard_client_state_size ${clients}`);
    metric('agent_guard_timing_state_size', 'Client keys currently retained in the timing LRU.', 'gauge', `agent_guard_timing_state_size ${timing}`);
    metric('agent_guard_trap_enabled', 'Whether trap behavior is enabled; currently disabled.', 'gauge', 'agent_guard_trap_enabled 0');
    metric('agent_guard_trap_blocked', 'Blocked client count; trap behavior is currently disabled.', 'gauge', 'agent_guard_trap_blocked 0');
    metric('agent_guard_trap_delayed', 'Delayed request count; trap behavior is currently disabled.', 'gauge', 'agent_guard_trap_delayed 0');
    metric('agent_guard_trap_maze_active', 'Active maze count; trap behavior is currently disabled.', 'gauge', 'agent_guard_trap_maze_active 0');
    return lines.join('\n') + '\n';
}

/** Mount explicitly on a host-owned route. Exporting metrics never inspects a request. */
export function prometheusHandler(guard: AgentGuard): RequestListener {
    return (req, res) => {
        try {
            if (req.method !== 'GET') {
                res.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Method Not Allowed\n');
                return;
            }
            const body = guard.prometheusText();
            res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
            res.end(body);
        }
        catch {
            try {
                if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Internal Server Error\n');
            }
            catch { /* Isolate response failures from the host. */ }
        }
    };
}
