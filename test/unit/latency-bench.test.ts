import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    files: new Map<string, string>(), descriptors: new Map<number, string>(), nextFd: 10,
    children: [] as Array<{ args: string[]; stdio: unknown[]; stopped: boolean }>,
    calls: [] as Array<Record<string, unknown>>,
    supplementaryFails: false, gateFails: true,
}));
vi.mock('node:fs', () => ({
    mkdirSync: vi.fn(), closeSync: vi.fn(),
    openSync: (file: string) => { const fd = state.nextFd++; state.descriptors.set(fd, file); state.files.set(file, ''); return fd; },
    readFileSync: (file: string) => state.files.get(file) ?? '',
}));
vi.mock('node:child_process', () => ({
    spawn: (_executable: string, args: string[], options: { stdio: unknown[] }) => {
        const child = new EventEmitter(), record = { args, stdio: options.stdio, stopped: false };
        state.children.push(record);
        const port = args.at(-1) === 'on' ? 4100 : 4101;
        state.files.set(state.descriptors.get(options.stdio[1] as number)!, JSON.stringify({ url: `http://127.0.0.1:${port}`, virtual: false }) + '\n');
        return Object.assign(child, { kill: () => { record.stopped = true; child.emit('close', 0); return true; } });
    },
    spawnSync: (_executable: string, _args: string[], options: { stdio: unknown[] }) => {
        state.files.set(state.descriptors.get(options.stdio[1] as number)!, JSON.stringify({ clients: 50000, heapDeltaBytes: 1000, gc: true }));
        return { status: 0 };
    },
}));
vi.mock('node:module', () => ({
    createRequire: () => () => (options: Record<string, unknown>, callback: (error: Error | null, result?: unknown) => void) => {
        state.calls.push(options);
        const fixed = options.overallRate !== undefined, on = String(options.url).endsWith(':4100');
        if (fixed && state.supplementaryFails) { callback(new Error('supplementary run failed')); return; }
        const p50 = fixed ? .12345 : on && state.gateFails ? 2 : 1;
        callback(null, { latency: { p50, p99: 3, p97_5: fixed ? .6789 : 2.5, average: .23456 },
            requests: { total: (on ? 1000 : 2000) * Number(options.duration) }, duration: options.duration,
            errors: 0, timeouts: 0, non2xx: 0 });
    },
}));
vi.mock('../../examples/shared/loopback.js', () => ({ listenLocal: async () => ({ virtual: false, close: async () => { } }) }));
vi.mock('../../examples/shared/site.js', () => ({
    startDemo: () => { throw new Error('TCP servers must run in child processes'); },
    demoConfig: vi.fn(), browserUA: 'Mozilla/5.0 test browser',
}));
vi.mock('../../bench/common.js', async importOriginal => ({
    ...await importOriginal<typeof import('../../bench/common.js')>(), isMain: () => false, save: vi.fn(),
}));
import { latency } from '../../bench/latency.js';

beforeEach(() => {
    state.files.clear(); state.descriptors.clear(); state.children.length = 0; state.calls.length = 0;
    state.supplementaryFails = false; state.gateFails = true;
});
it('isolates TCP servers, keeps the saturated gate, and records unrounded non-gating measurements within ten minutes', async () => {
    const result = await latency();
    expect(result.status).toBe('failed'); // Good fixed-rate percentiles cannot rescue a failing AC-10.
    expect(state.children).toHaveLength(4);
    for (const child of state.children) {
        expect(child.args.slice(0, 3)).toEqual(['--import', 'tsx', 'bench/latency-server.ts']);
        expect(child.stdio[0]).toBe('ignore');
        expect(typeof child.stdio[1]).toBe('number');
        expect(child.stdio[1]).toBe(child.stdio[2]);
        expect(child.stopped).toBe(true);
    }
    const gate = state.calls.filter(call => call.duration === 30);
    expect(gate).toHaveLength(12);
    expect(gate.every(call => call.connections === 100 && call.overallRate === undefined && (call.headers as Record<string, string>)['user-agent'] === 'Mozilla/5.0 test browser')).toBe(true);
    const fixed = state.calls.filter(call => call.overallRate !== undefined);
    expect(fixed).toHaveLength(12);
    expect(fixed.every(call => call.overallRate === 1000 && call.duration === 10 && call.connections === 100)).toBe(true);
    expect(state.calls.reduce((seconds, call) => seconds + Number(call.duration), 0)).toBeLessThan(600);
    for (const row of result.rows) {
        expect(row.supplementary).toMatchObject({ gating: false, serviceTimeDeltaUs: 500,
            off: { p50: .12345, p97_5: .6789, p99: 3 }, on: { p50: .12345, p97_5: .6789, p99: 3 },
            samples: { on: [expect.objectContaining({ latency: expect.objectContaining({ average: .23456 }) }), expect.anything(), expect.anything()] } });
    }
});
it('reports supplementary errors without changing a passing contract gate', async () => {
    state.gateFails = false; state.supplementaryFails = true;
    const result = await latency();
    expect(result.status).toBe('passed');
    expect(result.rows.every(row => row.supplementary.status === 'failed' && !row.supplementary.gating)).toBe(true);
    expect(state.children.every(child => child.stopped)).toBe(true);
});
