# v0.1 implementation notes

The behavioral authority is design.md, followed by the implementation contract and KPI document. Those specification files were left unchanged. Implementation and validation are local research only.

## Resolved specification conflicts

- Robots integration defaults to `manual`, following design §9. The prose in §3 says default enabled. `robotsLines()` is always available; demos explicitly choose append. Default Disallow output includes the three documented default prefixes and each enabled decoy path, including aliases and overrides.
- Shaped vendor/JWT/hex tokens are not generated. The contract prohibits real vendor key shapes, while design §4.3 describes them as opt-in. Only canonical unmistakably inert tokens are issued. Exact registry matching still supports secret rotation.
- Canary IDs use crypto randomness as specified. Seed-derived harmless fake data is deterministic; token stability requires a persisted registry. Empty registry objects produce six placements in the guard's in-memory copy, without rewriting the caller's files.
- Forwarded IP headers are not trusted by default. Design §9 mentions trustProxy but defines no trustProxy configuration. The socket IP is the safe default; explicit `clientIp` implements an operator's established proxy trust policy.
- Direct core crawler bypass decisions contain a plain-text 404. Framework adapters delegate bypass to the host's missing-route handler, preserving native response bytes. Decoy routes must be reserved; disable/override collisions with real routes.
- Body scanning uses a host-provided parsed `req.body`, bounded at 16KiB, in both adapters. Node middleware and wrap do not consume or replace the application's stream. The native demo installs its bounded parser before inspection. Middleware belongs after body parsing and before compression.

## Environment restrictions and validation deviations

This wrap-up run (2026-11-10) used loopback TCP and headless Chrome successfully. The TCP latency runner keeps the autocannon load generator and each demo server in separate Node processes; supplementary fixed-rate measurements do not replace or relax AC-10. Lighthouse collects fresh reports for each mode/form factor and matches the full requested URL, with robots append and the `/login` HTML comment lure enabled for the on run.

The demo/test/benchmark-only `examples/shared/loopback.ts` transport still falls back to real IncomingMessage / ServerResponse framing over an in-memory Duplex if `listen(0, '127.0.0.1')` fails with `EPERM`. That helper is not in the library tarball. Sandboxes that forbid loopback sockets keep the latency demos in process and report partial results; when loopback sockets work, the same harness uses actual 127.0.0.1 HTTP automatically.

Consequences:

- AC-1–AC-15 behavioral tests pass for both demos. Acceptance AC-10 checks core inspect timing (pass). The TCP autocannon gate (100 connections, 30 s, median of 3) met p99 (express +0 ms, node +1 ms) and the 50k-client heap limit (≈7.9 MB). Saturated-load p50 failed on Express (+1 ms vs ≤0.2 ms) because installed autocannon reports integer-millisecond percentiles; a non-gating throughput-derived service-time estimate is ~4 µs. The benchmark records this as a gate failure, not a pass.
- Simulation S1–S5 ran over 127.0.0.1 TCP with the specified session counts, a fixed traffic seed, compressed think time and eight concurrent sessions. FP(human)=0, FP(verified crawler)=0, detection 100%, canary replay 100%, signed alert p95 well under 250 ms. These are local delivery observations, not Internet results.
- Lighthouse completed the full matrix (2 demos × 2 form factors × 5 URLs, five runs each) and passed all 20 score-delta gates. Category scores were unchanged on vs off; LCP deltas were under 1 ms.
- `npm run bench` returns nonzero for any measured gate failure and writes docs/bench-v0.1.md even after a failure. The current nonzero combined exit is the Express p50 latency gate above.
- The default npm cache is outside the writable roots. Package inspection uses `npm_config_cache=/tmp/agent-guard-npm-cache npm pack --dry-run --offline`; no package installation or network access occurs.
- `spawnSync` with captured pipe stdio also returns EPERM because it creates a socketpair. CLI and memory subprocess checks use file descriptors for stdout/stderr instead. Script execution uses `node --import tsx`, avoiding tsx CLI's IPC listener.
- The hanging webhook receiver intentionally never responds (equivalent to or longer than a 30-second hang); tests shorten the adapter timeout to 10ms, verify the <50ms decoy response independently, and wait for `alert_failed`. A fake-clock unit test also exercises a custom adapter that ignores AbortSignal through the dispatcher deadline and retries.

## Implementation choices and limits

- Runtime dependencies: zero. Express is an optional peer and a preinstalled development dependency. Node >=20, strict TypeScript and noUncheckedIndexedAccess, ESM/CJS root and adapter exports.
- Alert deduplication and delivery rate limits affect notifications only. Suppressed dedup/rate counts are included in the next admitted payload as a summary. No request is blocked or throttled. The queue is bounded to 1024 waiting deliveries with eight workers; overflow is counted in the next summary. No idle summary timer is created.
- Client score state is a bounded 50k-entry LRU, idle TTL 30min, packed timestamps/score/robots marker; score saturates at 1023. The 60-second robots signal expires even for active clients. Metrics keep at most 2048 inspect durations; state and scores are per-instance approximations.
- Crawler cache holds 10k results with 24h positive / 1h negative TTL; concurrent identical lookups share work. One 300ms deadline spans reverse and forward checks. Failure/timeouts use configured failOpen; a nonmatching suffix/forward address is a negative verification. IPv6 comparisons normalize equivalent addresses. Optional offline IP JSON is keyed by crawler family; no IP data is downloaded.
- Request logs omit raw body, Cookie and Authorization values. Alerts redact IP by default. Query values and arbitrary headers are never logged. Referer is omitted to avoid copying query credentials. Sink/observer exceptions do not affect requests. Webhooks refuse redirects and verify signed timestamp freshness; receivers still need event-ID deduplication within the freshness window.
- Lure response transforms apply to explicitly selected, successful uncompressed responses, buffered up to 1MiB. Larger streams pass through without transformation. Validators are removed only when transformation is eligible. Manual integration is available for applications with streaming/compression requirements.
- Optional mechanical timing and authenticated Prometheus exposure are not implemented; the public metrics() and onEvent APIs cover v0.1 observability. Future alert channels and runtime adapters remain out of scope.
- CLI scan skips symlinks, generated/vendor trees, the standard registry basename, and src/decoys TypeScript templates. Scan targeted real-configuration directories: documentation/tests intentionally contain canary prefixes. `report` exposes observed counts and delivery latency; labeled FP/detection rates come from simulate rather than inference from unlabeled logs.

## Verification

The generated benchmark report contains environment details, raw three-run latency samples and medians, heap delta, all simulation counts, signed alert p50/p95/p99, and Lighthouse comparisons. Unit/integration/acceptance tests enforce behavior for both demos; coverage enforces src line coverage >=90% and 100% branches for canary and crawler modules. Build artifacts and raw benchmark/coverage output are ignored. Package contents are verified with npm pack --dry-run; the package remains private.
