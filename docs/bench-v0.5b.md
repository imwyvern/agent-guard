# v0.5b first-batch local validation (unreleased)

Date: 2026-11-16 (HKT). Node v24.22.1, Linux; build target Node 20. Zero runtime dependencies and no new development dependencies. Baseline: v0.5a tree at b8e40a1 (the subsequent contract-only commit); no npm publication, tag, push, deployment or CI changes.

## Functional acceptance

The complete required command passed:

```sh
npm run build && npm run typecheck && npm run lint && npx vitest run && npm run check:neutral && npm run bench:deception-lint
```

- **1517 passed / 4 skipped**, 63 test files; existing tests and assertions retained. New cases cover DI-1–DI-7, 1000 ordinary GET/POST forwards, binary/chunked byte equality, HTTPS identity, Host/absolute-URI target pinning, CONNECT/Upgrade refusal, no added Date header, OPTIONS targets, 8 MiB streaming with a 16 KiB inspection window, fail-open errors/timeouts, upstream outage/recovery/deadlines, secret permissions/non-disclosure, safe init diffs and real Express/Node snippet typechecking, and bounded combined/common/JSON following with rotation.
- All **6** Web bundles passed neutrality checks. Deception lint: **140 samples, 0 violations**. No new code enters the Web dependency closure.
- Six READMEs each have **20 byte-identical fenced blocks**, with resolving relative file links. New source regexes are recorded in [the security audit](security-review.md); the existing adversarial timing assertions are unchanged.
- `npm audit --omit=dev`: **0 vulnerabilities**. `npm pack --dry-run --json`: **68 files**, restricted to dist/schema/package metadata/readme/changelog/legal notices; no source fixtures, node_modules, logs or secrets. Package name and private status are unchanged.
- Excluded external-name scan: **0 matches**, using terms recovered from repository history only in the search command; no terms added to files. No .github/workflows directory was created.
- Built CLI + local Node upstream + actual curl smoke: ordinary response bytes equal, /.env has noindex and a console decoy_hit, then upstream shutdown gives **502**; SIGTERM exits cleanly.

## Default library latency versus v0.5a

Ran the unchanged `npm run bench:latency:hr` twice for each tree. Each invocation uses its default three interleaved runs, 100 and 10 connections, 3 s measurement / 1 s warmup; tables below show the primary **100-connection** median deltas. Thresholds remain Δp50 ≤200 µs, Δp99 ≤1000 µs, and 50k-client heap ≤10,000,000 bytes. Full quantile samples for both connection counts are in [the measurement artifact](bench-v0.5b.json).

| Tree / invocation | Adapter | Δp50 µs | Δp99 µs | Unchanged latency gate |
| --- | --- | ---: | ---: | --- |
| v0.5a / 1 | express | 100 | 1303 | FAIL |
| v0.5a / 1 | node | -136 | -277 | PASS |
| v0.5a / 1 | hono | -39 | 1005 | FAIL |
| v0.5b / 1 | express | -114 | 188 | PASS |
| v0.5b / 1 | node | 75 | -278 | PASS |
| v0.5b / 1 | hono | -227 | 1440 | FAIL |
| v0.5a / 2 | express | -13 | 1364 | FAIL |
| v0.5a / 2 | node | -39 | -827 | PASS |
| v0.5a / 2 | hono | -84 | 120 | PASS |
| v0.5b / 2 | express | 16 | 1190 | FAIL |
| v0.5b / 2 | node | -5 | -471 | PASS |
| v0.5b / 2 | hono | -17 | 1494 | FAIL |

Both the clean baseline and updated tree show tail-latency gate failures on this shared machine; these failures are reported, not relabeled as passes. Hono's baseline p99 delta itself changes substantially between invocations, while some on/off deltas are negative. The results do not establish a stable tail-latency regression or a uniformly green latency gate. No threshold or benchmark implementation was changed.

As a separate check of default behavior, all **18** existing root/adapter JavaScript bundles (ESM, CJS and Web entries; excluding the changed CLI) are **byte-identical** between clean baseline and updated builds. SHA-256 values are recorded in the artifact. The new entry-point code adds no work to the existing library hot path. This is stronger evidence of unchanged default implementation than the noisy wall-time deltas, but it does not turn the failed measurements into passes.

| Tree / invocation | Core inspect samples ns/op | Median ns/op | 50k-client heap bytes |
| --- | --- | ---: | ---: |
| v0.5a / 1 | 2378.72, 2350.93, 2406.56 | 2378.72 | 8,598,296 |
| v0.5b / 1 | 2402.26, 2294.13, 2286.96 | 2294.13 | 8,599,144 |
| v0.5a / 2 | 2479.86, 2442.68, 2426.95 | 2442.68 | 8,598,680 |
| v0.5b / 2 | 2527.04, 2316.09, 2283.64 | 2316.09 | 8,599,144 |

## Proxy overhead (informational)

`npm run bench:proxy` uses one in-flight local keep-alive GET, 100 warmup plus 1000 measured requests per mode/run, and three interleaved direct/proxy runs in the same process. Median per-run proxy delta: **p50 +77.134 µs; p99 +238.494 µs**. This includes the second HTTP hop and inspection; it is not comparable to the isolated 100-connection library gate and has **no threshold**. Per-run values are in the artifact.

Docker/Compose/ingress snippets, Workers templates/Helm and real-agent evaluation remain planned. Token drain remains unproven; the prior maze simulation byte ratio remains 1:1. See [entry-point boundaries](distribution.md) and [the implementation contract](codex-contract-v0.5b.md).
