import type { AgentGuardConfig, AgentGuardEvent } from '../types.js';
import type { StateStore } from '../state/store.js';
import { automationScore } from '../core/timing.js';
import { ulid } from '../core/ulid-core.js';
import { webCrypto } from '../crypto/web.js';
import { incidentConfidence, incidentSteps } from '../core/incidents-core.js';
import { LRU } from '../core/lru.js';

export interface ClientState {
    score: number;
    seenAt?: number;
    robotsAt?: number;
    confirmedUntil?: number;
    blockedUntil?: number;
    bucket?: { tokens: number; time: number };
    timing?: { last: number; intervals: number[] };
    incident?: { id: string; first: number; last: number; sequence: string[]; features: string[] };
}
export const stateTtl = 30 * 60_000;
export class WebState {
    private readonly clients = new LRU<string, boolean>(50_000);
    private readonly timings = new LRU<string, boolean>(2048);
    blocked = 0;
    get clientCount(): number { return this.clients.size; }
    get timingCount(): number { return this.timings.size; }
    private tail: Promise<unknown> = Promise.resolve();
    readonly prefix: string;
    constructor(readonly store: StateStore | undefined, private readonly config: AgentGuardConfig) {
        this.prefix = 'ag:' + JSON.stringify([config.project, config.env]) + ':';
    }
    // StateStore has no atomic update primitive. Serialize within this guard; an
    // external store must arrange its own coordination across isolates if needed.
    exclusive<T>(work: () => T | Promise<T>): Promise<T> {
        const task = this.tail.then(work);
        this.tail = task.catch(() => {});
        return task;
    }
    run<T>(key: string, work: (state: ClientState) => T | Promise<T>): Promise<T> {
        return this.exclusive(async () => {
            const storeKey = this.prefix + 'client:' + key;
            const state = this.store ? structuredClone(await this.store.get<ClientState>(storeKey) ?? { score: 0 }) : { score: 0 };
            const now = Date.now();
            if (state.seenAt !== undefined && now - state.seenAt >= stateTtl) { state.score = 0; delete state.robotsAt; }
            state.seenAt = now;
            const blockKey = this.prefix + 'blocks';
            const blocks = this.store && this.config.trap?.block?.enabled ? (await this.store.get<Array<{ key: string; expires: number }>>(blockKey) ?? []).filter(b => b.expires > now) : [];
            state.blockedUntil = blocks.find(b => b.key === key)?.expires;
            const result = await work(state);
            if (this.store) {
                this.clients.set(key, true, stateTtl);
                this.timings.set(key, true, stateTtl);
                if (this.config.trap?.block?.enabled) {
                    const retained = blocks.filter(b => b.key !== key);
                    if ((state.blockedUntil ?? 0) > now) retained.push({ key, expires: state.blockedUntil! });
                    const capped = retained.slice(-(this.config.trap.block.maxKeys ?? 8192));
                    this.blocked = capped.length;
                    if (capped.length) await this.store.set(blockKey, capped, Math.max(...capped.map(b => b.expires)) - now);
                    else await this.store.delete(blockKey);
                }
                await this.store.set(storeKey, state, Math.max(stateTtl, (state.blockedUntil ?? 0) - now, state.incident ? state.incident.first + (this.config.incident?.windowMs ?? 900_000) - now : 0));
            }
            return result;
        });
    }
    timing(state: ClientState): number | undefined {
        if (!this.store) return;
        const now = Date.now(), previous = state.timing;
        state.timing ??= { last: now, intervals: [] };
        if (!previous) return;
        previous.intervals.push(Math.max(0, Math.min(0xffff_ffff, Math.floor(now - previous.last))));
        previous.last = now;
        if (previous.intervals.length > 20) previous.intervals.shift();
        return previous.intervals.length === 20 ? automationScore(previous.intervals) : undefined;
    }
    incident(state: ClientState, step: string): AgentGuardEvent['incident'] {
        const window = this.config.incident?.windowMs ?? 900_000;
        if (!this.store || !window) return;
        const now = Date.now();
        if (!state.incident || now - state.incident.first >= window)
            state.incident = { id: ulid(webCrypto), first: now, last: now, sequence: [], features: [] };
        const incident = state.incident;
        incident.last = Math.max(incident.first, now);
        incident.sequence.push(step);
        if (incident.sequence.length > 32) incident.sequence.shift();
        if (!incident.features.includes(step)) incident.features.push(step);
        if (incident.sequence.length < 2 && step !== 'canary_replay') return;
        const features = incident.features.reduce((n, step) => n | (1 << incidentSteps.indexOf(step as typeof incidentSteps[number])), 0);
        return { id: incident.id, first_seen: new Date(incident.first).toISOString(), last_seen: new Date(incident.last).toISOString(), sequence: [...incident.sequence], confidence: incidentConfidence(features) };
    }
    limited(state: ClientState): boolean {
        const options = this.config.trap?.rateLimit;
        if (!this.store || !options?.enabled) return false;
        const now = Date.now(), capacity = options.capacity ?? 10;
        const bucket = state.bucket && now - state.bucket.time < stateTtl ? state.bucket : (state.bucket = { tokens: capacity, time: now });
        bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.time) / 1000 * (options.refillPerSec ?? 1));
        bucket.time = now;
        if (bucket.tokens < 1) return true;
        bucket.tokens--;
        return false;
    }
}
