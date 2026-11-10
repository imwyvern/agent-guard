import { expect, it } from 'vitest';
import { MicrosecondHistogram } from '../../bench/latency-hr.js';

it('uses nearest rank, rounds nanoseconds up to µs and invalidates sorted state', () => {
    const h = new MicrosecondHistogram();
    expect(() => h.percentile(.5)).toThrow('empty');
    for (const ns of [100001n, 1000n, 1000000n, 200000n]) h.recordNs(ns);
    expect(h.count).toBe(4);
    expect(h.summary()).toEqual({ p50: 101, p90: 1000, p99: 1000, p99_9: 1000 });
    expect(h.percentile(0)).toBe(1);
    expect(h.percentile(1)).toBe(1000);
    h.recordNs(0n);
    expect(h.percentile(0)).toBe(0);
    expect(h.percentile(.5)).toBe(101);
    expect(() => h.percentile(NaN)).toThrow(RangeError);
    expect(() => h.percentile(1.01)).toThrow(RangeError);
    expect(() => h.recordNs(-1n)).toThrow(RangeError);
});

it('resolves the p99.9 tail with nearest-rank boundary samples', () => {
    const h = new MicrosecondHistogram();
    for (let us = 1000; us >= 1; us--) h.recordNs(BigInt(us) * 1000n);
    expect(h.summary()).toEqual({ p50: 500, p90: 900, p99: 990, p99_9: 999 });
});
