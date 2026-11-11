import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hookLimits, validateHooks } from '../config.js';
import { ulid } from '../core/ulid.js';
import type { AgentGuardConfig, AgentGuardEvent, ResponseHook } from '../types.js';

export interface HookChild {
    on(event: 'error', listener: (error: Error) => void): this;
    once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
    kill(signal: NodeJS.Signals): boolean;
    unref?(): void;
}
export type HookSpawn = (file: string, args: string[], options: {
    shell: false; env: Record<string, string>; stdio: 'ignore'; windowsHide: true;
}) => HookChild;
export interface HookDependencies {
    spawn?: HookSpawn;
    now?: () => number;
}

type Result = NonNullable<AgentGuardEvent['hook']>;
interface Entry {
    config: Required<ResponseHook>;
    active: number;
    count: number;
    windowStart?: number;
}
interface Attempt {
    entry: Entry;
    event: AgentGuardEvent;
    env: Record<string, string>;
    done: Promise<void>;
    resolve: () => void;
    immediate?: ReturnType<typeof setImmediate>;
    timer?: ReturnType<typeof setTimeout>;
    killTimer?: ReturnType<typeof setTimeout>;
    child?: HookChild;
    recorded: boolean;
    finished: boolean;
    stopping?: 'timeout' | 'cancelled';
}

// Includes starts scheduled for the next turn, across all runner instances.
let globalActive = 0;

/** Node-only, no shell, no inherited environment, no output capture or work queue.
 * Spawn is deferred beyond inspection; reservations and fixed windows bound work.
 * Result events contain no executable, arguments, output or request details. */
export class HookRunner {
    private readonly entries: Entry[];
    private readonly active = new Set<Attempt>();
    private readonly high = new Map<string, true>();
    private readonly spawn: HookSpawn;
    private readonly now: () => number;
    private closed = false;
    private closing?: Promise<void>;

    constructor(hooks: AgentGuardConfig['hooks'], private readonly emit: (event: AgentGuardEvent) => void, dependencies: HookDependencies = {}) {
        validateHooks(hooks);
        this.entries = (hooks ?? []).map(hook => ({ config: {
            ...hook, run: [...hook.run], timeoutMs: hook.timeoutMs ?? hookLimits.timeoutMs.default,
            maxPerHour: hook.maxPerHour ?? hookLimits.maxPerHour.default, maxConcurrent: hook.maxConcurrent ?? hookLimits.maxConcurrent.default,
        }, active: 0, count: 0 }));
        this.spawn = dependencies.spawn ?? ((file, args, options) => spawn(file, args, options));
        this.now = dependencies.now ?? Date.now;
    }

    dispatch(event: AgentGuardEvent): void {
        if (this.closed || !this.entries.length || event.event === 'hook_result') return;
        try {
            let firstHigh = false;
            const incident = event.incident;
            if (incident?.confidence === 'high' && this.entries.some(entry => entry.config.on === 'incident_high')) {
                firstHigh = !this.high.has(incident.id);
                this.high.delete(incident.id);
                this.high.set(incident.id, true);
                if (this.high.size > 50_000) this.high.delete(this.high.keys().next().value!);
            }
            for (const entry of this.entries) {
                const on = entry.config.on;
                if (on === 'incident_high' ? firstHigh : event.event === on) this.schedule(entry, event);
            }
        } catch { /* Hook failures cannot escape into inspection or watch. */ }
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true;
        this.high.clear();
        const pending = [...this.active];
        for (const attempt of pending) this.stop(attempt, 'cancelled');
        this.closing = Promise.all(pending.map(attempt => attempt.done)).then(() => {});
        return this.closing;
    }

    private schedule(entry: Entry, source: AgentGuardEvent): void {
        // Fresh whitelist only. A client key is rehashed with hex SHA-256 even
        // when the upstream key already happens to be a digest.
        const env: Record<string, string> = Object.create(null) as Record<string, string>;
        if (source.incident?.id) env.AG_INCIDENT_ID = source.incident.id;
        env.AG_EVENT_TYPE = source.event;
        const hash = source.req.client_key ? createHash('sha256').update(source.req.client_key).digest('hex') : '';
        if (hash) env.AG_CLIENT_KEY_HASH = hash;
        if (source.canary?.id) env.AG_CANARY_ID = source.canary.id;
        const placement = source.canary?.placement ?? source.honeyfile?.placement;
        if (placement !== undefined) env.AG_PLACEMENT = placement;
        const event: AgentGuardEvent = {
            v: 1, ts: '', event_id: '', event: 'hook_result', severity: 'info', project: source.project, env: source.env,
            req: { method: 'HOOK', path: '', client_key: hash },
            ...(source.incident ? { incident: { ...source.incident, sequence: source.incident.sequence.slice(0, 32) } } : {}),
        };
        const now = this.now();
        const reset = entry.windowStart === undefined || now - entry.windowStart >= 3_600_000;
        const reason = (!reset && entry.count >= entry.config.maxPerHour) ? 'rate_limit'
            : entry.active >= entry.config.maxConcurrent ? 'concurrency_limit'
                : globalActive >= hookLimits.globalConcurrent ? 'global_concurrency_limit' : undefined;
        if (reason) { this.record(event, { on: entry.config.on, status: 'refused', reason }); return; }
        if (reset) { entry.windowStart = now; entry.count = 0; }
        let resolve!: () => void;
        const done = new Promise<void>(complete => { resolve = complete; });
        const attempt: Attempt = { entry, event, env, done, resolve, recorded: false, finished: false };
        entry.active++; entry.count++; globalActive++;
        this.active.add(attempt);
        attempt.immediate = setImmediate(() => this.start(attempt));
    }

    private start(attempt: Attempt): void {
        if (attempt.finished) return;
        attempt.immediate = undefined;
        try {
            const { run, timeoutMs } = attempt.entry.config;
            const child = this.spawn(run[0], run.slice(1), { shell: false, env: attempt.env, stdio: 'ignore', windowsHide: true });
            attempt.child = child;
            // Keep an error listener after completion as kill/spawn can report a
            // late error; finish is idempotent and never records it twice.
            child.on('error', () => this.finish(attempt, 'failure', 'spawn_error'));
            child.once('exit', (code, signal) => this.finish(attempt, code === 0 && !signal ? 'success' : 'failure', signal ? 'signal' : code === 0 ? undefined : 'exit_nonzero'));
            attempt.timer = setTimeout(() => this.stop(attempt, 'timeout'), timeoutMs);
            attempt.timer.unref();
        } catch { this.finish(attempt, 'failure', 'spawn_error'); }
    }

    private stop(attempt: Attempt, status: 'timeout' | 'cancelled'): void {
        if (attempt.finished || attempt.stopping) return;
        if (!attempt.child) { this.finish(attempt, status, status === 'cancelled' ? 'closed' : undefined); return; }
        attempt.stopping = status;
        this.report(attempt, status, status === 'cancelled' ? 'closed' : undefined);
        try { attempt.child.kill('SIGTERM'); } catch { /* Still attempt SIGKILL. */ }
        if (attempt.finished) return;
        attempt.killTimer = setTimeout(() => {
            try { attempt.child?.kill('SIGKILL'); } catch { /* Shutdown has a hard deadline. */ }
            try { attempt.child?.unref?.(); } catch { /* Injected/native cleanup cannot hold close open. */ }
            this.finish(attempt, status, status === 'cancelled' ? 'closed' : undefined);
        }, hookLimits.killGraceMs);
    }

    private finish(attempt: Attempt, status: Result['status'], reason?: Result['reason']): void {
        if (attempt.finished) return;
        attempt.finished = true;
        clearImmediate(attempt.immediate);
        clearTimeout(attempt.timer);
        clearTimeout(attempt.killTimer);
        this.active.delete(attempt);
        attempt.entry.active--; globalActive--;
        this.report(attempt, status, reason);
        attempt.resolve();
    }

    private report(attempt: Attempt, status: Result['status'], reason?: Result['reason']): void {
        if (attempt.recorded) return;
        attempt.recorded = true;
        this.record(attempt.event, { on: attempt.entry.config.on, status, ...(reason ? { reason } : {}) });
    }

    private record(base: AgentGuardEvent, hook: Result): void {
        try {
            const now = this.now();
            const event = { ...base, ts: new Date(now).toISOString(), event_id: ulid(), hook };
            if (event.incident) event.incident.dwell_ms = Math.max(0, Math.floor(now - Date.parse(event.incident.first_touch_at ?? event.incident.first_seen)));
            this.emit(event);
        } catch { /* Observers, clocks and result logging cannot affect the host. */ }
    }
}
