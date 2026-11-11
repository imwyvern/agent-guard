import type { AgentGuardConfig, AgentGuardEvent, AGResponse } from '../types.js';
import { decoyHeaders } from '../decoys/headers.js';
import { LRU } from './lru.js';

const stateTtlMs = 30 * 60_000;
export interface TrapMetrics { enabled: boolean; blocked: number; delayed: number; mazeActive?: number }

/** Per-guard global budgets; keys are exactly the existing detection client keys.
 * No per-client timers, no network activity, and no automation timing input. */
export class Trap {
    private readonly confirmed = new LRU<string, boolean>(8192);
    private readonly buckets = new LRU<string, { tokens: number; time: number }>(8192);
    private readonly blocks: LRU<string, boolean>;
    // Expiry bookkeeping also makes the exported blocked gauge exclude stale entries.
    private readonly expiries = new Map<string, number>();
    private readonly pending = new Set<() => void>();
    private manual = true;
    private circuitOpen = false;
    private probe?: ReturnType<typeof setInterval>;
    private loopDelayMs = 0;
    private nextCheck = 0;
    private readonly options: NonNullable<AgentGuardConfig['trap']>;
    constructor(private readonly mode: AgentGuardConfig['mode'], options?: AgentGuardConfig['trap']) {
        this.options = options ?? {};
        this.blocks = new LRU(this.options.block?.maxKeys ?? 8192);
        if (mode === 'trap' && (options?.delay?.enabled || options?.rateLimit?.enabled || options?.block?.enabled || options?.maze?.enabled)) {
            let previous = process.hrtime.bigint();
            this.probe = setInterval(() => {
                const now = process.hrtime.bigint();
                this.loopDelayMs = Math.max(this.loopDelayMs, Number(now - previous) / 1e6 - 250);
                previous = now;
            }, 250);
            this.probe.unref();
        }
    }
    get enabled(): boolean { return this.mode === 'trap' && this.manual && !this.circuitOpen && process.env.AGENT_GUARD_TRAP !== 'off'; }
    setEnabled(enabled: boolean): void {
        this.manual = enabled;
        if (enabled) {
            this.circuitOpen = false;
            this.loopDelayMs = 0;
            this.nextCheck = Date.now() + 250;
        } else this.releaseDelays();
    }
    /** Check at most four p99 snapshots per second, and open only once per reset. */
    checkCircuit(p99: () => number): boolean {
        if (!this.enabled) { this.releaseDelays(); return false; }
        if (!this.probe) return false;
        if (this.loopDelayMs > (this.options.circuit?.eventLoopDelayMs ?? 1000)) return this.trip();
        if (Date.now() < this.nextCheck) return false;
        this.nextCheck = Date.now() + 250;
        return p99() > (this.options.circuit?.inspectP99Ns ?? 5e9) && this.trip();
    }
    /** Internal test-visible trip path. Emission belongs to inspect, where request metadata is available. */
    trip(): boolean {
        if (this.circuitOpen) return false;
        this.circuitOpen = true;
        this.releaseDelays();
        return true;
    }
    observe(event: AgentGuardEvent): void {
        if (this.mode !== 'trap' || (event.event !== 'canary_replay' && event.incident?.confidence !== 'high')) return;
        const key = event.req.client_key, fresh = !this.confirmed.get(key);
        this.confirmed.set(key, true, stateTtlMs);
        // Do not renew a block on ordinary requests or historical incident=high.
        if (this.enabled && this.options.block?.enabled && (fresh || event.event === 'canary_replay')) {
            const ttl = this.options.block.ttlMs ?? 15 * 60_000;
            this.blocks.set(key, true, ttl);
            this.expiries.delete(key);
            this.expiries.set(key, Date.now() + ttl);
            if (this.expiries.size > this.blocks.capacity) this.expiries.delete(this.expiries.keys().next().value!);
        }
    }
    gated(key: string, score: number, previousScore = 0): boolean {
        // Even a configured threshold of zero cannot qualify a fresh, single decoy hit.
        return !!this.confirmed.get(key) || (previousScore > 0 && score >= (this.options.gate?.minScore ?? 200));
    }
    blocked(key: string): boolean {
        if (!this.enabled || !this.options.block?.enabled) return false;
        const blocked = !!this.blocks.get(key);
        // Keep expiry recency in sync with the LRU for deterministic eviction.
        const expiry = this.expiries.get(key);
        this.expiries.delete(key);
        if (blocked && expiry !== undefined) this.expiries.set(key, expiry);
        return blocked;
    }
    limited(key: string): boolean {
        if (!this.enabled || !this.options.rateLimit?.enabled) return false;
        const now = Date.now(), capacity = this.options.rateLimit.capacity ?? 10;
        const bucket = this.buckets.get(key) ?? { tokens: capacity, time: now };
        bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.time) / 1000 * (this.options.rateLimit.refillPerSec ?? 1));
        bucket.time = now;
        const limited = bucket.tokens < 1;
        if (!limited) bucket.tokens--;
        this.buckets.set(key, bucket, stateTtlMs);
        return limited;
    }
    async delay(): Promise<void> {
        if (!this.enabled || !this.options.delay?.enabled || this.pending.size >= (this.options.delay.maxConcurrent ?? 20)) return;
        const ms = this.options.delay.ms ?? 1000;
        if (!ms) return;
        await new Promise<void>(resolve => {
            const finish = (): void => { clearTimeout(timer); this.pending.delete(finish); resolve(); };
            const timer = setTimeout(finish, ms);
            this.pending.add(finish);
        });
    }
    snapshot(): TrapMetrics {
        for (const [key, expiry] of this.expiries) {
            if (expiry <= Date.now()) { this.expiries.delete(key); this.blocks.get(key); }
        }
        return { enabled: this.enabled, blocked: this.expiries.size, delayed: this.pending.size };
    }
    private releaseDelays(): void { for (const finish of this.pending) finish(); }
    close(): void { clearInterval(this.probe); this.manual = false; this.releaseDelays(); }
}

export function trapResponse(status: 403 | 429, head = false): AGResponse {
    return { status, headers: decoyHeaders('text/plain'), body: head ? '' : status === 403 ? 'Forbidden\n' : 'Too Many Requests\n' };
}
