import type { AgentGuardConfig, AgentGuardEvent, AlertAdapter, AlertPayload } from '../types.js';
import { LRU } from '../core/lru.js';
import { formatAlert } from './format.js';
import { ulid } from '../core/ulid.js';
export const severityRank = { debug: 0, info: 1, medium: 2, high: 3, critical: 4 };
interface Channel {
    adapter: AlertAdapter;
    count: number;
    start: number;
    deduped: number;
    limited: number;
}
export class Dispatcher {
    private seen = new LRU<string, boolean>(50000);
    private channels: Channel[];
    private active = new Set<Promise<void>>();
    private queue: Array<() => Promise<void>> = [];
    private closed = false;
    private scheduled = false;
    constructor(private config: AgentGuardConfig['alerts'], private emit: (event: AgentGuardEvent) => void) {
        this.channels = (config?.adapters ?? []).map(adapter => ({ adapter, count: 0, start: Date.now(), deduped: 0, limited: 0 }));
    }
    enqueue(event: AgentGuardEvent): void {
        if (this.closed || severityRank[event.severity] < severityRank[this.config?.minSeverity ?? 'info'])
            return;
        if (!['decoy_hit', 'canary_replay', 'trap_block', 'trap_circuit_open', 'exhaust_budget_spent', 'canary_callback'].includes(event.event) && this.config?.minSeverity === undefined)
            return;
        const key = [event.event, event.decoy?.id ?? event.canary?.id, event.req.client_key].join('|');
        if (this.seen.get(key)) {
            for (const channel of this.channels)
                channel.deduped++;
            return;
        }
        this.seen.set(key, true, (this.config?.dedupeWindowSec ?? 600) * 1000);
        for (const channel of this.channels) {
            if (Date.now() - channel.start >= 60000) {
                channel.start = Date.now();
                channel.count = 0;
            }
            if (channel.count >= (this.config?.ratePerMinute ?? 30) || this.queue.length >= 1024) {
                channel.limited++;
                continue;
            }
            channel.count++;
            const payload = formatAlert(event, { deduped: channel.deduped, rate_limited: channel.limited }, this.config?.redactIp ?? true);
            channel.deduped = 0;
            channel.limited = 0;
            this.queue.push(() => this.deliver(channel.adapter, payload));
        }
        // Delivery starts in a microtask, after inspect has constructed its decision.
        if (this.queue.length && !this.scheduled) {
            this.scheduled = true;
            queueMicrotask(() => { this.scheduled = false; this.pump(); });
        }
    }
    private pump(): void {
        while (this.active.size < 8 && this.queue.length) {
            const task = this.queue.shift()!();
            this.active.add(task);
            void task.finally(() => { this.active.delete(task); this.pump(); });
        }
    }
    private async deliver(adapter: AlertAdapter, payload: AlertPayload): Promise<void> {
        const start = Date.now();
        let status: number | undefined, ok = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const result = await Promise.race([adapter.send(payload, controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('alert timeout')); }, 5000); })]);
                ok = result.ok;
                status = result.status;
                if (ok || (status !== undefined && status < 500 && status !== 429))
                    break;
            }
            catch { /* Isolated from application responses. */ }
            finally {
                clearTimeout(timer);
            }
            if (attempt < 2)
                await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
        }
        this.emit({ ...payload.event, ts: new Date().toISOString(), event_id: ulid(), event: ok ? 'alert_sent' : 'alert_failed', severity: ok ? 'debug' : 'medium', alert: { channel: adapter.name, latency_ms: Date.now() - start, ...(status === undefined ? {} : { status }) } });
    }
    async close(): Promise<void> { this.closed = true; this.pump(); while (this.active.size)
        await Promise.all([...this.active]); }
}
