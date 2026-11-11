# Trap mode (v0.4a, runs 3–4)

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

Prometheus exports effective `agent_guard_trap_enabled`, the current block count in `agent_guard_trap_blocked`, and current delay concurrency in `agent_guard_trap_delayed`. New event counter series appear when their first event occurs. There are no path labels. `agent_guard_trap_maze_active` counts current maze sessions and is zero while trap is disabled or its circuit is open.

## Experimental bounded maze

The maze is experimental and defaults off. The v0.3b simulation showed a **1:1 byte ratio**; there has been **no real-agent measurement**. It is a bounded local decoy surface, with no LLM generation or context-poison content.

```ts
mode: 'trap',
trap: {
  maze: {
    enabled: true,
    maxDepth: 6,
    maxPages: 50,
    maxBytes: 512 * 1024,
    maxDurationMs: 10 * 60 * 1000,
    maxConcurrent: 20,
    bytesPerMinute: 5 * 1024 * 1024,
  },
},
```

These budget values are defaults. Depth is 0 at entry and permits pages through `maxDepth` inclusive; the next depth returns 404. Maximum configured depth is 64, duration is at most 24 hours, and concurrency is at most 8192. Other budgets are positive safe integers. Each HEAD counts as a page and sends zero body bytes. Byte budgets count UTF-8 response bodies; the global byte window is a fixed minute per guard instance.

While effectively enabled, D1–D4 contain a relative entry path under `{decoys.basePath ?? '/api/internal'}/archive/` once the client qualifies through the trap gate. D5 does not change. The archive prefix is included in robots disallows. Unconfirmed D1–D4 bodies remain unchanged unless callback placement is configured. Detect mode and trap with maze disabled preserve decoy bodies and native missing-route behavior. A valid entry is still 404 until the same trap gate used by delay qualifies the client. Crawlers and allowlists bypass the maze. Runtime switches and the circuit stop pages immediately.

Nodes use **`canary.secret`**, with domain-separated HMAC-SHA256 over `maze:v1|parent|index|depth`. Their fixed 43-character Crockford base32 form carries a two-character depth, a 20-character parent MAC, a one-character child index, and a truncated 20-character (100-bit) MAC. The entry has a fixed zero parent and index. Routing data is signed, so topology verification needs no node registry and clients cannot change depth. Changing the secret invalidates existing links. Forged, truncated or otherwise invalid nodes return plain `404 Not Found` for gated clients; for unconfirmed clients they pass through to the host's native missing route. Neither case changes maze budgets or emits exhaustion events.

Pages substitute metadata into a fixed small HTML template and contain ten relative links with `rel="nofollow"`. They stay below 8 KiB, use `decoyHeaders('text/html')`, have `noindex`, `nofollow`, and `no-store`, and contain no cookies or absolute external URLs. Callback URLs are confined to D1–D4 and never appear in maze HTML.

If block is also enabled, a blocked client receives the existing 403 for valid maze paths; malformed nodes still return 404 without spending maze budgets. Delay and rate-limit options retain their D1–D5 scope.

Budgets use the existing approximate client key, held in an 8192-entry LRU. Duration runs from the first valid maze request, without renewal. A spent session returns 404 and emits `exhaust_budget_spent` exactly once, through the usual logs and Dispatcher. Its record remains until 30 minutes after its duration deadline, or LRU eviction; requests never extend that window. Active sessions free their concurrency slot when spent or at their duration deadline. At the global session cap, new clients receive 404 without admission or an exhaustion event. Crossing a session byte budget or the global byte budget marks the requesting session spent. Limits are process-local; multiple instances each have their own budgets.

## Self-hosted callback canaries

Callback placement is independent of trap mode:

```ts
canary: {
  secret: process.env.AG_CANARY_SECRET!,
  registry,
  callback: { baseUrl: 'https://callbacks.operator.example' },
},
```

The operator supplies their own endpoint. `baseUrl` must be an absolute HTTPS URL without credentials, query or fragment. HTTP is accepted only for `127.0.0.1`, `localhost` and `::1` loopback hosts. A path prefix is allowed; a reverse proxy must strip that prefix before forwarding to the handler.

When configured, D1–D4 include `baseUrl + '/ag/cb/' + token`. Tokens have a dedicated inert `AGCB-CANARY-` format, a stable placement ID, and a domain-separated 100-bit HMAC using `canary.secret` and `env`. They are unrelated to vendor credentials and do not authenticate. A separate instance with the same secret and environment can verify them. Unconfigured outputs remain unchanged.

`callbackHandler(guard)` is an exported Node HTTP listener and is **never mounted automatically**. Mount it ahead of inspection middleware so tokens do not enter general request-path logs:

```ts
import { createServer } from 'node:http';
import { callbackHandler } from '@imwyvern/agent-guard';

const callback = callbackHandler(guard);
const server = createServer((req, res) => {
  if (req.url?.startsWith('/ag/cb/')) callback(req, res);
  else application(req, res);
});
```

The shared Node demo includes this explicit mount when its supplied configuration contains `canary.callback`; its default configuration leaves the endpoint unmounted.

Valid GET/HEAD requests return empty 204 with `no-store` and no cookies, and emit high-severity `canary_callback`. Invalid tokens, other methods/paths, closed guards and handler errors return 404. Verified crawlers and allowlisted clients receive the valid-token 204 without callback events or alerts. Event metadata includes only the ID and placement; the recorded path uses the ID, never the token. Callback events use Dispatcher deduplication and rate limits, and are counted in Prometheus without incident-sequence steps. The guard never fetches the callback URL; there is no third-party honeytoken service.

Placement lint keeps its strict default host rules. For operator callback output, supply the exact configured hostname as `lintSample({ name, body, capBytes: 8192, allowedHosts: [new URL(baseUrl).hostname] })`, or `lintFiles(path, allowedHosts)` / `lintPlacement(path, allowedHosts)`. This adds only those exact hosts, including loopback only when explicitly supplied; subdomains and other hosts remain violations. Vendor prefixes, hidden characters, imperatives and size limits are still checked. Built-in samples and CLI lint need no allowance.
