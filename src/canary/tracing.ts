import type { AgentGuardEvent, CanaryEntry } from '../types.js';
import { LRU } from '../core/lru.js';
import type { Registry } from './registry.js';

interface Trace { issuedAt?: number; clients: string[] }
const ttlMs = 24 * 60 * 60_000;

/** Process-local provenance only. Reads preserve the 24h TTL; eviction/restart
 * loses dwell time. A replay never establishes issuance. */
export class CanaryTracing {
    private readonly records: LRU<string, Trace>;
    constructor(private readonly now: () => number = Date.now, capacity = 50_000) {
        if (capacity > 50_000) throw new RangeError('canary tracing capacity exceeds 50k');
        this.records = new LRU(capacity, now);
    }
    get size(): number { return this.records.size; }
    delivered(body: string, registry: Registry): void {
        // Built-in responses are <=8KiB; also cap candidate visits independently.
        for (const token of registry.candidates(body, 64)) {
            const entry = registry.find(token);
            if (!entry) continue;
            const trace = this.records.get(entry.id) ?? { clients: [] };
            if (trace.issuedAt === undefined) {
                trace.issuedAt = this.now();
                this.records.set(entry.id, trace, ttlMs);
            }
        }
    }
    replay(entry: CanaryEntry, path: string, key: string): Pick<NonNullable<AgentGuardEvent['canary']>, 'leaked_at' | 'replayed_at' | 'dwell_ms' | 'client_keys_seen'> {
        let trace = this.records.get(entry.id);
        if (!trace) {
            trace = { clients: [] };
            this.records.set(entry.id, trace, ttlMs);
        }
        if (trace.clients.length < 8 && !trace.clients.includes(key)) trace.clients.push(key);
        return {
            leaked_at: entry.placement,
            replayed_at: path,
            ...(trace.issuedAt === undefined ? {} : { dwell_ms: Math.max(0, this.now() - trace.issuedAt) }),
            client_keys_seen: trace.clients.length,
        };
    }
}
