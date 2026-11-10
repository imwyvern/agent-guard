import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { openSync, closeSync, readFileSync, mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { startDemo, demoConfig, browserUA } from '../examples/shared/site.js';
import { listenLocal } from '../examples/shared/loopback.js';
import { median, quantile, isMain, save, report } from './common.js';

interface Sample {
    p50: number;
    p99: number;
}
interface Measurement extends Sample {
    p97_5?: number;
    // Preserve all numeric histogram fields, with no display rounding.
    latency: Record<string, number>;
    requestsPerSecond: number;
    errors: number;
    timeouts: number;
    non2xx: number;
}
interface BenchmarkServer {
    url: string;
    close(): Promise<void>;
}
type Mode = 'on' | 'off';
type DemoKind = 'express' | 'node';
export function latencyGate(delta: Sample, memory: number): boolean { return delta.p50 <= .2 && delta.p99 <= 1 && memory <= 10000000; }

async function childDemo(kind: DemoKind, mode: Mode): Promise<BenchmarkServer> {
    const file = `bench/results/latency-${kind}-${mode}-server.log`, fd = openSync(file, 'w');
    let child;
    try {
        child = spawn(process.execPath, ['--import', 'tsx', 'bench/latency-server.ts', kind, mode], { stdio: ['ignore', fd, fd] });
    } finally { closeSync(fd); }
    let error: Error | undefined, exited = false;
    child.once('error', e => { error = e; });
    const stopped = new Promise<void>(resolve => child.once('close', () => { exited = true; resolve(); }));
    const close = async (): Promise<void> => {
        if (exited)
            return;
        child.kill('SIGTERM');
        const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
        try { await stopped; } finally { clearTimeout(timeout); }
    };
    try {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const output = readFileSync(file, 'utf8');
            if (error || exited)
                throw new Error(`latency server failed: ${error?.message ?? output}`);
            if (output.endsWith('\n')) {
                const ready = JSON.parse(output.trim()) as { url: string; virtual: boolean };
                if (ready.virtual)
                    throw new Error('child server cannot listen on TCP after successful parent probe');
                return { url: ready.url, close };
            }
            await delay(25);
        }
        throw new Error(`latency server readiness timed out; see ${file}`);
    } catch (error) { await close(); throw error; }
}

async function sample(url: string, duration: number, fallback: boolean, overallRate?: number): Promise<Measurement> {
    if (!fallback) {
        const autocannon = createRequire(import.meta.url)('autocannon') as (o: Record<string, unknown>, cb: (e: Error | null, r: {
            latency: Record<string, number> & Sample;
            requests: { total: number };
            duration: number;
            errors: number;
            timeouts: number;
            non2xx: number;
        }) => void) => void;
        return new Promise((resolve, reject) => autocannon({ url, connections: 100, duration, headers: { 'user-agent': browserUA }, ...(overallRate === undefined ? {} : { overallRate }) }, (e, r) => {
            if (e) { reject(e); return; }
            const requestsPerSecond = r.requests.total / r.duration;
            if (r.errors || r.timeouts || r.non2xx || !Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
                reject(new Error('autocannon did not complete a clean successful HTTP run: ' + JSON.stringify(r)));
                return;
            }
            resolve({ p50: r.latency.p50, p99: r.latency.p99, p97_5: r.latency.p97_5, latency: r.latency, requestsPerSecond, errors: r.errors, timeouts: r.timeouts, non2xx: r.non2xx });
        }));
    }
    const times: number[] = [], began = performance.now();
    for (let i = 0; i < 3000; i++) {
        const start = performance.now();
        const response = await fetch(url, { headers: { 'user-agent': browserUA } });
        await response.text();
        if (response.status !== 200)
            throw new Error('fallback home page did not return HTTP 200');
        times.push(performance.now() - start);
    }
    const latency = { p50: quantile(times, .5), p97_5: quantile(times, .975), p99: quantile(times, .99) };
    return { ...latency, latency, requestsPerSecond: times.length * 1000 / (performance.now() - began), errors: 0, timeouts: 0, non2xx: 0 };
}
function summarize(samples: Measurement[]) {
    return { p50: median(samples.map(s => s.p50)), p99: median(samples.map(s => s.p99)),
        ...(samples.every(s => s.p97_5 !== undefined) ? { p97_5: median(samples.map(s => s.p97_5!)) } : {}),
        requestsPerSecond: median(samples.map(s => s.requestsPerSecond)) };
}

export async function latency() {
    mkdirSync('bench/results', { recursive: true });
    // Probe before spawning: virtual endpoints must live with their in-process fetch.
    const probe = await listenLocal(createServer()), fallback = probe.virtual;
    await probe.close();
    const rows = [];
    for (const kind of ['express', 'node'] as const) {
        const start = (mode: Mode): Promise<BenchmarkServer> => fallback
            ? startDemo(kind, mode === 'on' ? demoConfig({ log: { sink: () => { } }, alerts: { adapters: [] } }) : false)
            : childDemo(kind, mode);
        const on = await start('on');
        let off: BenchmarkServer | undefined;
        const samples: Record<Mode, Measurement[]> = { on: [], off: [] };
        try {
            off = await start('off');
            const servers = { on, off };
            await sample(off.url, 3, fallback);
            await sample(on.url, 3, fallback);
            for (let run = 0; run < 3; run++) {
                // THE gate: saturated, 30 seconds, 100 connections, browser UA, home page.
                for (const mode of run % 2 ? ['on', 'off'] as const : ['off', 'on'] as const)
                    samples[mode].push(await sample(servers[mode].url, 30, fallback));
            }
            const offMedian = summarize(samples.off), onMedian = summarize(samples.on);
            let supplementary;
            if (fallback) {
                supplementary = { gating: false, status: 'skipped', reason: 'Fixed-rate autocannon and saturated TCP throughput require loopback TCP' };
            } else {
                // Three 10-second pairs add two minutes total, keeping the whole command
                // around 8.5 minutes including the six-minute gate and warmups.
                const overallRate = Math.max(100, Math.floor(offMedian.requestsPerSecond * .5));
                const fixed: Record<Mode, Measurement[]> = { on: [], off: [] };
                const details = { gating: false, overallRate, fractionOfOffThroughput: overallRate / offMedian.requestsPerSecond,
                    connections: 100, durationSeconds: 10, runs: 3, latencyUnit: 'ms', precision: 'Unrounded autocannon histogram values; installed autocannon may quantize percentiles to integer ms',
                    serviceTimeDeltaUs: 1e6 / onMedian.requestsPerSecond - 1e6 / offMedian.requestsPerSecond,
                    serviceTimeMethod: '1e6 / median saturated on rps - 1e6 / median saturated off rps; throughput-derived estimate, not a direct service-time measurement' };
                try {
                    for (let run = 0; run < 3; run++)
                        for (const mode of run % 2 ? ['on', 'off'] as const : ['off', 'on'] as const)
                            fixed[mode].push(await sample(servers[mode].url, 10, false, overallRate));
                    const fixedOff = summarize(fixed.off), fixedOn = summarize(fixed.on);
                    supplementary = { ...details, status: 'measured', samples: fixed, off: fixedOff, on: fixedOn,
                        delta: { p50: fixedOn.p50 - fixedOff.p50, p99: fixedOn.p99 - fixedOff.p99 } };
                } catch (error) {
                    // Supplementary failures are reported but never decide the contract gate.
                    supplementary = { ...details, status: 'failed', samples: fixed, reason: error instanceof Error ? error.message : String(error) };
                }
            }
            rows.push({ demo: kind, samples, off: offMedian, on: onMedian, delta: { p50: onMedian.p50 - offMedian.p50, p99: onMedian.p99 - offMedian.p99 }, supplementary });
        } finally {
            await on.close();
            await off?.close();
        }
    }
    // File descriptors avoid spawnSync's socketpair, which is also blocked in this sandbox.
    const file = 'bench/results/memory-output.json', fd = openSync(file, 'w');
    let child;
    try {
        child = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', 'bench/memory.ts'], { stdio: ['ignore', fd, fd], timeout: 30000 });
    } finally { closeSync(fd); }
    if (child.error || child.status !== 0)
        throw new Error('memory benchmark failed: ' + readFileSync(file, 'utf8'));
    const memory = JSON.parse(readFileSync(file, 'utf8')) as { clients: number; heapDeltaBytes: number; gc: boolean };
    const numericPassed = rows.every(r => latencyGate(r.delta, memory.heapDeltaBytes));
    const result = { status: numericPassed ? (fallback ? 'partial' : 'passed') : 'failed', transport: fallback ? 'in-process HTTP; autocannon TCP gate SKIPPED (listen EPERM)' : 'autocannon TCP; each demo server in a separate child process',
        warmup: fallback ? '3000 requests per mode' : '3 seconds per mode', runs: 3, connections: fallback ? 1 : 100, durationSeconds: fallback ? null : 30, rows, memory, numericPassed };
    save('latency', result);
    return result;
}
if (isMain(import.meta.url)) {
    const result = await latency();
    console.log(JSON.stringify(result, null, 2));
    report();
    if (result.status === 'failed')
        process.exitCode = 1;
}
