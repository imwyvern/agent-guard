import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAZE_DEFAULTS = Object.freeze({
    maxDepth: 6, maxPages: 50, maxBytes: 512 * 1024, maxDurationMs: 10 * 60 * 1000,
    maxConcurrent: 20, maxBytesPerMinute: 5 * 1024 * 1024,
    inspectP99Ms: 1, eventLoopDelayMs: 20,
});
export type MazeLimits = { [K in keyof typeof MAZE_DEFAULTS]: number };
export type StopReason = 'invalid' | 'depth' | 'pages' | 'bytes' | 'duration' | 'concurrency' | 'rate' | 'circuit' | 'closed';
export interface MazeSession {
    readonly startedMs: number;
    pages: number;
    bytes: number;
    stopReason?: StopReason;
}
export interface MazeResponse {
    kind: 'page' | 'stop';
    status: 200 | 404;
    body: string;
    links: string[];
    headers: Readonly<Record<string, string>>;
    reason?: StopReason;
}
const prefix = '/api/internal/archive/';
const headers = Object.freeze({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' });
const templates = [
    '<h1>Archive {id}</h1><p>Read-only catalog, revision 3. Layer {depth}; synthetic staging inventory.</p>',
    '<h1>Snapshot {id}</h1><p>Internal index, revision 2. Layer {depth}; synthetic retention metadata.</p>',
];

/** Offline E2 reference only. Nodes carry a 100-bit base32 HMAC plus bounded ancestry
 * in a query parameter: a bare truncated digest cannot be verified statelessly.
 * The ancestry is authenticated by recomputing HMAC(seed, parent|index|depth).
 * No node registry, real clock, timers, cookies, hosts or network are involved. */
export class MazeModel {
    readonly limits: MazeLimits;
    readonly events = { exhaust_budget_spent: 0, exhaust_circuit_open: 0 };
    private clockMs = 0;
    private circuitOpen = false;
    private active = new Set<MazeSession>();
    private outbound: Array<{ at: number; bytes: number }> = [];
    private windowBytes = 0;

    constructor(private readonly seed: string, limits: Partial<MazeLimits> = {}) {
        this.limits = { ...MAZE_DEFAULTS, ...limits };
        for (const [name, value] of Object.entries(this.limits)) {
            if (!Number.isFinite(value) || value < (name === 'maxDepth' ? 0 : Number.MIN_VALUE))
                throw new Error(`invalid maze limit: ${name}`);
            if (name.startsWith('max') && !Number.isSafeInteger(value)) throw new Error(`non-integer maze limit: ${name}`);
        }
        if (this.limits.maxDepth > 32) throw new Error('reference ancestry cap is 32');
    }
    get nowMs(): number { return this.clockMs; }
    get activeSessions(): number { return this.active.size; }
    get entry(): string { return this.path(''); }

    startSession(): MazeSession {
        const session: MazeSession = { startedMs: this.clockMs, pages: 0, bytes: 0 };
        if (this.circuitOpen) session.stopReason = 'circuit';
        else if (this.active.size >= this.limits.maxConcurrent) this.spend(session, 'concurrency');
        else this.active.add(session);
        return session;
    }
    endSession(session: MazeSession): void {
        this.active.delete(session);
        session.stopReason ??= 'closed';
    }
    advance(ms: number): void {
        if (!Number.isFinite(ms) || ms < 0) throw new Error('simulated time must advance monotonically');
        this.clockMs += ms;
        for (const session of this.active)
            if (this.clockMs - session.startedMs >= this.limits.maxDurationMs) this.spend(session, 'duration');
        while (this.outbound[0] && this.outbound[0].at <= this.clockMs - 60_000)
            this.windowBytes -= this.outbound.shift()!.bytes;
    }
    injectOverload(sample: { inspectP99Ms?: number; eventLoopDelayMs?: number }): void {
        if (!this.circuitOpen && ((sample.inspectP99Ms ?? 0) > this.limits.inspectP99Ms ||
            (sample.eventLoopDelayMs ?? 0) > this.limits.eventLoopDelayMs)) {
            this.circuitOpen = true;
            this.events.exhaust_circuit_open++;
            for (const session of this.active) session.stopReason = 'circuit';
            this.active.clear();
        }
    }
    visit(session: MazeSession, path: string): MazeResponse {
        // MAC validation precedes accounting: invalid paths never spend a budget.
        const trail = this.verify(path);
        if (trail === undefined) return this.stop('invalid');
        if (this.circuitOpen) return this.stop('circuit');
        if (session.stopReason) return this.stop(session.stopReason);
        if (!this.active.has(session)) return this.stop('closed');
        if (trail.length > this.limits.maxDepth) return this.spend(session, 'depth');
        if (session.pages >= this.limits.maxPages) return this.spend(session, 'pages');
        const links = Array.from({ length: 8 }, (_, i) => this.path(trail + i));
        links.push(this.path(trail.slice(0, -1)), this.entry);
        const id = path.slice(prefix.length, prefix.length + 20);
        const content = templates[trail.length % templates.length]!.replace('{id}', id).replace('{depth}', String(trail.length));
        const body = `<!doctype html><html lang="en"><head><meta name="robots" content="noindex,nofollow"><title>Archive</title></head><body>${content}<nav>${links.map((link, i) => `<a rel="nofollow" href="${link}">Catalog ${i}</a>`).join('')}</nav></body></html>`;
        const bytes = Buffer.byteLength(body);
        if (session.bytes + bytes > this.limits.maxBytes) return this.spend(session, 'bytes');
        if (this.windowBytes + bytes > this.limits.maxBytesPerMinute) return this.spend(session, 'rate');
        session.pages++;
        session.bytes += bytes;
        this.windowBytes += bytes;
        this.outbound.push({ at: this.clockMs, bytes });
        return { kind: 'page', status: 200, body, links, headers };
    }
    private tag(trail: string): string {
        let parent = this.mac('root|0|0');
        for (let i = 0; i < trail.length; i++) parent = this.mac(`${parent}|${trail[i]}|${i + 1}`);
        return parent;
    }
    private mac(value: string): string {
        const bytes = createHmac('sha256', this.seed).update(value).digest();
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = 0, buffer = 0, result = '';
        for (const byte of bytes) {
            buffer = (buffer << 8) | byte;
            bits += 8;
            while (bits >= 5 && result.length < 20) {
                bits -= 5;
                result += alphabet[(buffer >>> bits) & 31];
            }
            if (result.length === 20) break;
        }
        return result;
    }
    private path(trail: string): string { return `${prefix}${this.tag(trail)}?trail=${trail || 'r'}`; }
    private verify(path: string): string | undefined {
        if (path.length > 128 || !path.startsWith(prefix)) return;
        const match = /^([A-Z2-7]{20})\?trail=(r|[0-7]{1,33})$/.exec(path.slice(prefix.length));
        if (!match) return;
        const trail = match[2] === 'r' ? '' : match[2]!;
        if (trail.length > this.limits.maxDepth + 1) return;
        return timingSafeEqual(Buffer.from(match[1]!), Buffer.from(this.tag(trail))) ? trail : undefined;
    }
    private stop(reason: StopReason): MazeResponse { return { kind: 'stop', status: 404, body: '', links: [], headers, reason }; }
    private spend(session: MazeSession, reason: StopReason): MazeResponse {
        if (!session.stopReason) {
            session.stopReason = reason;
            this.events.exhaust_budget_spent++;
            this.active.delete(session);
        }
        return this.stop(session.stopReason);
    }
}
