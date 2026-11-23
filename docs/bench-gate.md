# Latency gate method (v0.5c, unreleased)

Date: 2026-11-23 (HKT). Approved by the maintainer after v0.5a / v0.5b showed that a single `bench:latency:hr` invocation flips between PASS and FAIL on a shared machine (see [bench-v0.5b.md](bench-v0.5b.md)).

## What changed

Only the pass/fail **judgement** changed. Thresholds are unchanged: Δp50 ≤ 200 µs, Δp99 ≤ 1000 µs, 50k-client heap ≤ 10,000,000 bytes; only the 100-connection row decides latency.

| Command | Before | Now |
| --- | --- | --- |
| `npm run bench:latency:hr` | One invocation: `HR_RUNS` (default 3) interleaved on/off runs, per-mode median, one Δ per row, gated directly | `HR_OUTER_RUNS` (default 3, minimum 3) independent **outer runs**, each restarting both server processes and repeating the unchanged `HR_RUNS` measurement. The gate uses the **median of the per-outer-run Δ**; the min–max range and every per-outer-run value are reported. Every outer run must be error-free. |
| `npm run bench:latency:web` | Median of 5 runs, no range | Median of `WEB_RUNS` (default 5, minimum 3) runs, unchanged; min–max range of Δp50 / Δp99 now reported in `ranges` |

Raw output: `bench/results/latency-hr.json` (`aggregates[]` holds median/min/max/values per demo and connection count; `rows[]` keeps every outer run with its `outer` index). Wall time for the HR command is about 3× the previous run (about 7–8 minutes here).

A median of three outer runs tolerates one noisy outer run; it does not hide a real regression, which moves the median. The range is reported so that wide spreads remain visible rather than being averaged away.

## First run with the new gate

Node v24.22.1, Linux, shared box; `HR_OUTER_RUNS=3`, `HR_RUNS=3`, 3 s measure / 1 s warmup. Library tree: v0.5b batch 2 (`2f48490`) plus this gate change.

| Adapter (100 conn) | Δp50 median µs (min…max) | Δp99 median µs (min…max) | Verdict |
| --- | --- | --- | --- |
| express | -67 (-125…-15) | 573 (236…1079) | PASS |
| node | 8 (-41…31) | -221 (-501…823) | PASS |
| hono | -80 (-105…105) | -5 (-527…390) | PASS |

50k-client heap delta 8,599,824 bytes (gc available). Core inspect microbenchmark ≈ 2.43 µs/op.

Note: one Express outer run had Δp99 = 1079 µs, which the old single-run judgement would have reported as FAIL; the median is 573 µs. Negative deltas are measurement noise (guard-on faster than guard-off), not a speed-up.

`bench:latency:web` (5 runs): Δp50 median 3 µs (3…4), Δp99 median 8 µs (4…17); canary replay p50 60 µs / p99 293 µs; PASS.
