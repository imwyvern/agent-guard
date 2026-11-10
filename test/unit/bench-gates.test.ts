import { it, expect } from 'vitest';
import { latencyGate } from '../../bench/latency.js';
import { lighthouseGate } from '../../bench/lighthouse.js';
it('latency and memory gates reject regressions', () => { expect(latencyGate({ p50: .2, p99: 1 }, 10000000)).toBe(true); expect(latencyGate({ p50: .201, p99: 0 }, 0)).toBe(false); expect(latencyGate({ p50: 0, p99: 1.001 }, 0)).toBe(false); expect(latencyGate({ p50: 0, p99: 0 }, 10000001)).toBe(false); });
it('Lighthouse gates cover scores, LCP, TBT and exact CLS equality', () => { const zero = { performance: 0, accessibility: 0, 'best-practices': 0, seo: 0, lcp: 0, tbt: 0, cls: 0 }; expect(lighthouseGate(zero)).toBe(true); for (const [key, value] of [['performance', 3], ['accessibility', -3], ['best-practices', 3], ['seo', 3], ['lcp', 101], ['tbt', 51], ['cls', .001]] as const)
    expect(lighthouseGate({ ...zero, [key]: value })).toBe(false); });
