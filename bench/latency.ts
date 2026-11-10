import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { startDemo, demoConfig, browserUA } from '../examples/shared/site.js';
import { socketFallback } from '../examples/shared/loopback.js';
import { median, quantile, isMain, save, report } from './common.js';
interface Sample {
    p50: number;
    p99: number;
}
export function latencyGate(delta: Sample, memory: number): boolean { return delta.p50 <= .2 && delta.p99 <= 1 && memory <= 10000000; }
export async function latency() {
    const rows = [];
    for (const kind of ['express', 'node'] as const) {
        const on = await startDemo(kind, demoConfig({ log: { sink: () => { } }, alerts: { adapters: [] } })), off = await startDemo(kind, false);
        const samples: {
            on: Sample[];
            off: Sample[];
        } = { on: [], off: [] };
        try {
            const sample = async (url: string, duration: number): Promise<Sample> => {
                if (!socketFallback) {
                    const autocannon = createRequire(import.meta.url)('autocannon') as (o: Record<string, unknown>, cb: (e: Error | null, r: {
                        latency: {
                            p50: number;
                            p99: number;
                        };
                    }) => void) => void;
                    return new Promise((resolve, reject) => autocannon({ url, connections: 100, duration, headers: { 'user-agent': browserUA } }, (e, r) => e ? reject(e) : resolve({ p50: r.latency.p50, p99: r.latency.p99 })));
                }
                const times: number[] = [];
                for (let i = 0; i < 3000; i++) {
                    const start = performance.now();
                    const r = await fetch(url, { headers: { 'user-agent': browserUA } });
                    await r.text();
                    times.push(performance.now() - start);
                }
                return { p50: quantile(times, .5), p99: quantile(times, .99) };
            };
            await sample(off.url, 3);
            await sample(on.url, 3);
            for (let run = 0; run < 3; run++) {
                // Alternate order to reduce systematic thermal/JIT bias.
                for (const mode of run % 2 ? ['on', 'off'] as const : ['off', 'on'] as const) {
                    samples[mode].push(await sample(mode === 'on' ? on.url : off.url, 30));
                }
            }
        }
        finally {
            await on.close();
            await off.close();
        }
        const offMedian = { p50: median(samples.off.map(s => s.p50)), p99: median(samples.off.map(s => s.p99)) }, onMedian = { p50: median(samples.on.map(s => s.p50)), p99: median(samples.on.map(s => s.p99)) };
        rows.push({ demo: kind, samples, off: offMedian, on: onMedian, delta: { p50: onMedian.p50 - offMedian.p50, p99: onMedian.p99 - offMedian.p99 } });
    }
    // File descriptors avoid spawnSync's socketpair, which is also blocked in this sandbox.
    const file = 'bench/results/memory-output.json', fd = openSync(file, 'w');
    let child;
    try {
        child = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', 'bench/memory.ts'], { stdio: ['ignore', fd, fd] });
    }
    finally {
        closeSync(fd);
    }
    if (child.error || child.status !== 0)
        throw new Error('memory benchmark failed: ' + readFileSync(file, 'utf8'));
    const memory = JSON.parse(readFileSync(file, 'utf8')) as {
        clients: number;
        heapDeltaBytes: number;
        gc: boolean;
    };
    const numericPassed = rows.every(r => latencyGate(r.delta, memory.heapDeltaBytes));
    const result = { status: numericPassed ? (socketFallback ? 'partial' : 'passed') : 'failed', transport: socketFallback ? 'in-process HTTP; autocannon TCP gate SKIPPED (listen EPERM)' : 'autocannon TCP', warmup: socketFallback ? '3000 requests per mode' : '3 seconds per mode', runs: 3, connections: socketFallback ? 1 : 100, durationSeconds: socketFallback ? null : 30, rows, memory, numericPassed };
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
