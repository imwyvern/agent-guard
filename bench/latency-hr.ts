import { spawn } from 'node:child_process';
import { Agent, request } from 'node:http';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, freemem, loadavg, platform, release, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentGuard } from '../src/index.js';
import { browserUA, demoConfig } from '../examples/shared/site.js';
import { isMain, save } from './common.js';
import { latencyGate } from './latency.js';

type Mode = 'off' | 'on';
type Demo = 'express' | 'node' | 'hono';
const percentiles = ['p50', 'p90', 'p99', 'p99_9'] as const;

/** Exact integer-µs sorted histogram; nearest-rank percentiles, no interpolation. */
export class MicrosecondHistogram {
    private values: number[] = [];
    private sorted = true;
    recordNs(ns: bigint): void {
        if (ns < 0n) throw new RangeError('negative latency');
        this.values.push(Number((ns + 999n) / 1000n));
        this.sorted = false;
    }
    percentile(q: number): number {
        if (!(q >= 0 && q <= 1)) throw new RangeError('percentile outside [0, 1]');
        if (!this.values.length) throw new Error('empty histogram');
        if (!this.sorted) { this.values.sort((a, b) => a - b); this.sorted = true; }
        return this.values[Math.max(0, Math.ceil(q * this.values.length) - 1)]!;
    }
    get count(): number { return this.values.length; }
    summary() {
        return { p50: this.percentile(.5), p90: this.percentile(.9), p99: this.percentile(.99), p99_9: this.percentile(.999) };
    }
}
interface WorkerConfig { url: string; connections: number; durationSeconds: number; warmupSeconds: number }

async function load(config: WorkerConfig) {
    const url = new URL(config.url);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('loopback HTTP only');
    const agent = new Agent({ keepAlive: true, maxSockets: config.connections, maxFreeSockets: config.connections });
    const sockets = new WeakSet<object>();
    let socketCount = 0;
    async function phase(seconds: number) {
        const histogram = new MicrosecondHistogram();
        let errors = 0, timeouts = 0, non200 = 0;
        const start = process.hrtime.bigint(), deadline = start + BigInt(Math.round(seconds * 1e9));
        async function lane() {
            while (process.hrtime.bigint() < deadline) {
                const began = process.hrtime.bigint();
                await new Promise<void>(resolve => {
                    let settled = false;
                    const finish = (ok: boolean) => {
                        if (settled) return;
                        settled = true;
                        if (ok) histogram.recordNs(process.hrtime.bigint() - began);
                        else errors++;
                        resolve();
                    };
                    const req = request(url, { agent, headers: { 'user-agent': browserUA } }, res => {
                        res.on('error', () => finish(false));
                        res.on('aborted', () => finish(false));
                        res.on('end', () => {
                            if (res.statusCode !== 200) non200++;
                            finish(res.statusCode === 200);
                        });
                        res.resume(); // Time through the full body, not just first byte.
                    });
                    req.on('socket', socket => {
                        if (!sockets.has(socket)) { sockets.add(socket); socketCount++; }
                    });
                    req.on('error', () => finish(false));
                    req.setTimeout(2000, () => { timeouts++; req.destroy(new Error('request timeout')); });
                    req.end();
                });
            }
        }
        await Promise.all(Array.from({ length: config.connections }, lane));
        const elapsedSeconds = Number(process.hrtime.bigint() - start) / 1e9;
        if (!histogram.count) throw new Error(`no successful responses: ${errors} errors`);
        return { latencyUs: histogram.summary(), requests: histogram.count, elapsedSeconds,
            requestsPerSecond: histogram.count / elapsedSeconds, errors, timeouts, non200 };
    }
    try {
        const warmup = await phase(config.warmupSeconds);
        const measured = await phase(config.durationSeconds);
        return { ...measured, warmup, socketCount, clientPid: process.pid };
    } finally { agent.destroy(); }
}
type Measurement = Awaited<ReturnType<typeof load>>;

/** File stdio follows the original runner's isolation pattern, without IPC sockets. */
function startChild(args: string[], log: string, timeoutMs: number) {
    const fd = openSync(log, 'w');
    const child = (() => {
        try { return spawn(process.execPath, args, { stdio: ['ignore', fd, fd] }); }
        finally { closeSync(fd); }
    })();
    const done = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`child ${code ?? signal}: ${log}\n${readFileSync(log, 'utf8')}`)));
    });
    // Observe server failures immediately, even before readiness / shutdown awaits done.
    void done.catch(() => {});
    const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    void done.finally(() => clearTimeout(timeout)).catch(() => {});
    return { child, done, async close() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
        try { await done; } finally { clearTimeout(kill); }
    } };
}
async function server(demo: Demo, mode: Mode) {
    const log = `bench/results/hr-${demo}-${mode}-server.log`;
    const proc = startChild(['--import', 'tsx', 'bench/latency-server.ts', demo, mode], log, 330000);
    try {
        for (let i = 0; i < 600; i++) {
            if (proc.child.exitCode !== null || proc.child.signalCode !== null) { await proc.done; throw new Error('server exited before readiness'); }
            const output = readFileSync(log, 'utf8');
            if (output.endsWith('\n')) {
                const ready = JSON.parse(output.trim()) as { url: string; virtual: boolean };
                if (ready.virtual) throw new Error('hr benchmark requires real loopback TCP; no in-process fallback');
                return { ...proc, url: ready.url, pid: proc.child.pid };
            }
            await delay(25);
        }
        throw new Error(`readiness timeout: ${log}`);
    } catch (error) { await proc.close(); throw error; }
}
function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
function summarize(samples: Measurement[]) {
    return { latencyUs: Object.fromEntries(percentiles.map(p => [p, median(samples.map(s => s.latencyUs[p]))])) as Record<typeof percentiles[number], number>,
        requestsPerSecond: median(samples.map(s => s.requestsPerSecond)),
        errors: samples.reduce((n, s) => n + s.errors + s.warmup.errors, 0) };
}
interface Row {
    demo: Demo; connections: number; primary: boolean; order: Mode[];
    serverPids: { off: number | undefined; on: number | undefined };
    samples: Record<Mode, Measurement[]>; off: ReturnType<typeof summarize>; on: ReturnType<typeof summarize>;
    deltaUs: Record<typeof percentiles[number], number>; latencyPassed: boolean; clean: boolean;
}
function positive(name: string, fallback: number, integer = false) {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) throw new Error(`invalid ${name}`);
    return value;
}
async function microbenchmark(runs: number) {
    const guard = createAgentGuard(demoConfig({ log: { sink: () => {} }, alerts: { adapters: [] } }));
    const req = { method: 'GET', path: '/', query: {}, headers: { 'user-agent': browserUA }, ip: '127.0.0.1' };
    const iterations = 100000, samplesNsPerOp: number[] = [];
    try {
        for (let i = 0; i < 20000; i++) await guard.inspect(req);
        for (let run = 0; run < runs; run++) {
            const start = process.hrtime.bigint();
            for (let i = 0; i < iterations; i++) {
                const result = await guard.inspect(req);
                if (result.action !== 'pass' || result.events.length) throw new Error('human homepage did not pass');
            }
            samplesNsPerOp.push(Number(process.hrtime.bigint() - start) / iterations);
        }
    } finally { await guard.close(); }
    return { method: 'await guard.inspect(human homepage); includes await, decision check, metrics, bounds and scanning; excludes adapter/HTTP',
        warmupIterations: 20000, iterations, runs, samplesNsPerOp, medianNsPerOp: median(samplesNsPerOp) };
}

export async function latencyHr() {
    mkdirSync('bench/results', { recursive: true });
    const began = process.hrtime.bigint(), generatedAt = new Date().toISOString();
    const runs = positive('HR_RUNS', 3, true);
    if (runs < 3) throw new Error('HR_RUNS must be >= 3');
    const connections = [...new Set([positive('HR_CONNECTIONS', 100, true), positive('HR_LOW_CONNECTIONS', 10, true)])];
    const durationSeconds = positive('HR_DURATION', 3), warmupSeconds = positive('HR_WARMUP', 1);
    const rows: Row[] = [];
    for (const demo of ['express', 'node', 'hono'] as const) {
        const servers: Partial<Record<Mode, Awaited<ReturnType<typeof server>>>> = {};
        try {
            servers.off = await server(demo, 'off');
            servers.on = await server(demo, 'on');
            for (const concurrency of connections) {
                const samples: Record<Mode, Measurement[]> = { off: [], on: [] };
                const order: Mode[] = [];
                for (let run = 0; run < runs; run++) {
                    for (const mode of run % 2 ? ['on', 'off'] as const : ['off', 'on'] as const) {
                        const config: WorkerConfig = { url: servers[mode]!.url, connections: concurrency, durationSeconds, warmupSeconds };
                        const stem = `bench/results/hr-${demo}-${concurrency}-${run}-${mode}`;
                        writeFileSync(stem + '-config.json', JSON.stringify(config));
                        const proc = startChild(['--import', 'tsx', 'bench/latency-hr.ts', '--worker', stem + '-config.json', stem + '.json'], stem + '.log', (durationSeconds + warmupSeconds + 15) * 1000);
                        await proc.done;
                        samples[mode].push(JSON.parse(readFileSync(stem + '.json', 'utf8')) as Measurement);
                        order.push(mode);
                    }
                }
                const off = summarize(samples.off), on = summarize(samples.on);
                const deltaUs = Object.fromEntries(percentiles.map(p => [p, on.latencyUs[p] - off.latencyUs[p]])) as Record<typeof percentiles[number], number>;
                const row = { demo, connections: concurrency, primary: concurrency === 100, order, serverPids: { off: servers.off.pid, on: servers.on.pid },
                    samples, off, on, deltaUs, latencyPassed: latencyGate({ p50: deltaUs.p50 / 1000, p99: deltaUs.p99 / 1000 }, 0), clean: off.errors + on.errors === 0 };
                rows.push(row);
                console.log(JSON.stringify({ demo, connections: concurrency, deltaUs, offRps: off.requestsPerSecond, onRps: on.requestsPerSecond, errors: off.errors + on.errors }));
            }
        } finally { await Promise.all(Object.values(servers).map(s => s.close())); }
    }
    const memoryFile = 'bench/results/hr-memory.json';
    await startChild(['--expose-gc', '--import', 'tsx', 'bench/memory.ts'], memoryFile, 30000).done;
    const memory = JSON.parse(readFileSync(memoryFile, 'utf8')) as { clients: number; heapDeltaBytes: number; gc: boolean };
    const micro = await microbenchmark(runs);
    const autocannonFile = 'bench/results/latency.json';
    const autocannonSecondary = existsSync(autocannonFile) ? { source: autocannonFile, fileModifiedAt: statSync(autocannonFile).mtime.toISOString(),
        historical: true, note: 'Previously recorded, unchanged autocannon run; not rerun by this command.', result: JSON.parse(readFileSync(autocannonFile, 'utf8')) as unknown } : { source: 'docs/bench-v0.1.md', historical: true, note: 'No raw autocannon JSON present; see the committed v0.1 report.' };
    const verdicts = (['express', 'node', 'hono'] as const).map(demo => {
        const primary = rows.find(row => row.demo === demo && row.primary);
        return { demo, verdict: !primary ? 'UNVALIDATED' : primary.clean && primary.latencyPassed && memory.clients === 50000 && memory.gc && memory.heapDeltaBytes <= 10000000 ? 'PASS' : 'FAIL' };
    });
    const result = { generatedAt, status: verdicts.every(v => v.verdict === 'PASS') ? 'passed' : 'failed',
        environment: { node: process.version, platform: platform(), release: release(), arch: arch(), cpus: cpus().map(c => ({ model: c.model, speedMHz: c.speed })), totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), loadAverage: loadavg() },
        method: { transport: '127.0.0.1 HTTP/1.1 keep-alive; server and load generator in separate child processes', runs, connections, durationSeconds, warmupSeconds,
            load: 'closed-loop, one in-flight request per connection, no rate limit or pipelining', histogram: 'integer µs rounded up; sorted array; nearest rank ceil(q*n); per-mode median of run percentiles; delta = on median - off median',
            boundary: 'requests started before deadline are drained and included; throughput denominator includes drain; warmup uses the same Agent, separate histogram',
            thresholds: { p50DeltaUs: 200, p99DeltaUs: 1000, heapDeltaBytes: 10000000, clients: 50000 }, primaryConnections: 100 },
        rows, memory, microbenchmark: micro, autocannonSecondary, verdicts, wallSeconds: Number(process.hrtime.bigint() - began) / 1e9 };
    save('latency-hr', result);
    return result;
}
if (isMain(import.meta.url)) {
    if (process.argv[2] === '--worker') {
        const config = JSON.parse(readFileSync(process.argv[3]!, 'utf8')) as WorkerConfig;
        writeFileSync(process.argv[4]!, JSON.stringify(await load(config)) + '\n');
    } else {
        const result = await latencyHr();
        console.log(JSON.stringify({ verdicts: result.verdicts, memory: result.memory, microbenchmark: result.microbenchmark, wallSeconds: result.wallSeconds }, null, 2));
        if (result.status !== 'passed') process.exitCode = 1;
    }
}
