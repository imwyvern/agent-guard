import { createWebGuard } from '../src/web/index.js';
import { generateCanaryAsync } from '../src/canary/format-core.js';
import { webCrypto } from '../src/crypto/web.js';
import type { AGRequest } from '../src/types.js';
import { MicrosecondHistogram } from './latency-hr.js';

const warmup = 3000, samples = 20000, replayWarmup = 200, replaySamples = 2000, runCount = 5;
const guard = createWebGuard({ project: 'web-latency', env: 'bench', projectSeed: 'web-latency-fixed-seed',
    canary: { secret: 'web-latency-test-secret', registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
});
const token = (await generateCanaryAsync({ secret: 'web-latency-test-secret' }, webCrypto)).token;
function ordinary(): AGRequest {
    return { method: 'GET', path: '/', ip: '192.0.2.1', query: {}, headers: { 'user-agent': 'Mozilla/5.0 Chrome/130.0' } };
}
function replay(): AGRequest { const req = ordinary(); req.headers.authorization = token; return req; }
async function measure(mode: 'baseline' | 'ordinary' | 'replay') {
    const count = mode === 'replay' ? replaySamples : samples, warm = mode === 'replay' ? replayWarmup : warmup;
    const histogram = new MicrosecondHistogram();
    for (let i = -warm; i < count; i++) {
        const started = process.hrtime.bigint();
        // Both ordinary phases include identical AGRequest construction. Only the
        // guarded phase runs (and awaits) inspect; the baseline does no guard work.
        const req = mode === 'replay' ? replay() : ordinary();
        if (mode !== 'baseline') {
            const decision = await guard.inspect(req);
            if (decision.action !== 'pass' || (mode === 'ordinary' ? decision.events.length !== 0 : decision.events[0]?.event !== 'canary_replay'))
                throw new Error('benchmark request did not exercise the expected inspection path');
        }
        if (i >= 0) histogram.recordNs(process.hrtime.bigint() - started);
    }
    return { p50: histogram.percentile(.5), p99: histogram.percentile(.99) };
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
try {
    const runs = [];
    for (let run = 1; run <= runCount; run++) {
        // Alternate order to avoid assigning all warm-machine effects to one phase.
        let baseline, ordinary;
        if (run % 2) { baseline = await measure('baseline'); ordinary = await measure('ordinary'); }
        else { ordinary = await measure('ordinary'); baseline = await measure('baseline'); }
        const replay = await measure('replay');
        runs.push({ run, baseline, ordinary, delta: { p50: ordinary.p50 - baseline.p50, p99: ordinary.p99 - baseline.p99 }, replay });
    }
    const medians = { delta: { p50: median(runs.map(r => r.delta.p50)), p99: median(runs.map(r => r.delta.p99)) },
        replay: { p50: median(runs.map(r => r.replay.p50)), p99: median(runs.map(r => r.replay.p99)) } };
    const thresholds = { deltaP50: 200, deltaP99: 1000 };
    const passed = medians.delta.p50 <= thresholds.deltaP50 && medians.delta.p99 <= thresholds.deltaP99;
    console.log(JSON.stringify({ unit: 'microseconds', histogram: 'integer us rounded up; nearest rank ceil(q*n)',
        warmup, samples, replayWarmup, replaySamples, runCount, runs, medians, thresholds, passed }, null, 2));
    if (!passed) process.exitCode = 1;
} finally { await guard.close(); }
