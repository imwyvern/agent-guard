import { expect, it } from 'vitest';
import { outerVerdict, spread } from '../../bench/latency-hr.js';

it('gates on the median of outer-run deltas and reports the min–max range', () => {
    // One noisy outer run (p99 +1949 µs) must not flip the gate when the median is within 1000 µs.
    const v = outerVerdict([{ p50: 40, p99: 300 }, { p50: 60, p99: 1949 }, { p50: 50, p99: 700 }], [true, true, true]);
    expect(v.deltaP99Us).toEqual({ median: 700, min: 300, max: 1949, values: [300, 1949, 700] });
    expect(v.deltaP50Us.median).toBe(50);
    expect(v.latencyPassed).toBe(true);
    expect(v.clean).toBe(true);
});

it('fails when the median exceeds an unchanged threshold or any outer run had errors', () => {
    expect(outerVerdict([{ p50: 0, p99: 1001 }, { p50: 0, p99: 1200 }, { p50: 0, p99: 10 }], [true, true, true]).latencyPassed).toBe(false);
    expect(outerVerdict([{ p50: 201, p99: 0 }, { p50: 250, p99: 0 }, { p50: 0, p99: 0 }], [true, true, true]).latencyPassed).toBe(false);
    expect(outerVerdict([{ p50: 200, p99: 1000 }, { p50: 200, p99: 1000 }, { p50: 200, p99: 1000 }], [true, true, true]).latencyPassed).toBe(true);
    expect(outerVerdict([{ p50: 0, p99: 0 }, { p50: 0, p99: 0 }, { p50: 0, p99: 0 }], [true, false, true]).clean).toBe(false);
});

it('spread uses the even-count midpoint and rejects empty input', () => {
    expect(spread([4, 1, 3, 2])).toMatchObject({ median: 2.5, min: 1, max: 4 });
    expect(() => spread([])).toThrow('empty');
});
