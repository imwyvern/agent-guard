# Trap mode core (v0.4a, run 3)

`mode` is required and accepts `detect` or `trap`. The demos remain in `detect` mode. All trap feature flags default to false. Express, Node, Hono, Fastify and Koa inherit trap decisions from `inspect()`.

To opt in, add this to an existing valid guard configuration:

```ts
mode: 'trap',
trap: {
  delay: { enabled: true, ms: 1000, maxConcurrent: 20 },
  rateLimit: { enabled: true, capacity: 10, refillPerSec: 1 },
  block: { enabled: false, ttlMs: 900000, maxKeys: 8192 },
  gate: { minScore: 200 },
  circuit: { inspectP99Ns: 5000000000, eventLoopDelayMs: 1000 },
  maze: { enabled: false },
},
```

The values shown are defaults, except for the explicit delay and rate-limit opt-ins. Numeric options must be safe integers. Delay is limited to 3000 ms; block TTL is positive and limited to 24 hours; block keys and delay concurrency are limited to 50000. Rate-limit capacity and delay concurrency must be positive; refill can be zero.

Verified crawlers and IP/CIDR/UA/header-token allowlists bypass trap controls. The gate requires a previous canary replay, incident confidence `high`, or detection score at least `minScore` (default 200) with a detection signal from an earlier request. A fresh `/.env` hit scores 50, or 60 with an automation UA, and does not qualify even if the configured threshold is zero. Mechanical `automation_score` is independent and never qualifies by itself. Keep the score threshold conservative when overriding it.

Delay and token buckets apply only to D1–D5 decoy paths. Real pages never receive their delay or 429. The existing D5 login delay remains and the trap delay stacks after it. At the delay concurrency cap, requests skip the extra delay. Confirmation and token buckets each retain at most 8192 keys, with a 30-minute idle TTL.

Block requires a canary replay or high-confidence incident; detection score alone cannot block. Each 403 logs `trap_block`, and responses have `no-store`, no cookies and an empty body for HEAD. Blocks apply to exactly the existing client key, with a fixed TTL and LRU eviction. Ordinary requests do not renew the TTL. Client keys already combine a network prefix and UA; they are approximate client identities and can be shared. Trap never broadens a key into another CIDR rule.

`AGENT_GUARD_TRAP=off` is checked at runtime. Other environment values do not force features on. `guard.setTrapEnabled(false)` also disables trap; `true` reenables it and resets an open circuit. Pending trap delays are released by manual disable, circuit opening and guard shutdown. Existing blocks and token buckets remain bounded in memory while disabled, but cannot affect responses.

The circuit checks inspect p99 at most every 250 ms during inspection, using the existing latency samples, and tracks event-loop drift with an unreferenced 250 ms interval. The first inspect observing an exceeded threshold opens the circuit, emits `trap_circuit_open` once, and returns to detection. Manual reenable or restart resets the circuit. The default p99 threshold includes intentional D5 and trap delays. Trap events use the existing alert adapters and their delivery deduplication and rate limits; per-403 local logging remains independent.

Prometheus exports effective `agent_guard_trap_enabled`, the current block count in `agent_guard_trap_blocked`, and current delay concurrency in `agent_guard_trap_delayed`. New event counter series appear when their first event occurs. There are no path labels. `agent_guard_trap_maze_active` stays zero.

Maze routing and callback canaries are deferred to run 4. `trap.maze.enabled` is accepted but inert, including when true; archive-like paths keep the host's missing-route behavior. AC-16 is covered only for this native 404 behavior; AC-20/22/23 are deferred. No new dependencies or outbound requests are introduced by trap controls.
