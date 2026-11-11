# agent-guard

HTTP middleware for Node ≥20: five isolated decoy routes and inert canary credentials detect credential replay and exploratory scanning. It records events and sends asynchronous alerts. Zero runtime dependencies; optional Express peer. Apache-2.0, copyright 2026 Wesley Wang.

This is an open-source research project, not yet published to npm. Install from source or create a local tarball with `npm pack`. The working package name is `@imwyvern/agent-guard`.

See the [security policy](SECURITY.md), [contributing guide](CONTRIBUTING.md), and [roadmap](docs/roadmap.md).

## Install and validate locally

Development tools are already installed in this workspace. Do not install additional dependencies here.

```sh
npm run build
npm run typecheck
npm run lint          # strict-compiler lint (tsc --noUnusedLocals --noUnusedParameters)
npm test
npm run test:coverage
npm run bench
npm pack --dry-run
```

For a separate local consumer, create a tarball with `npm pack` and install `./imwyvern-agent-guard-0.1.0.tgz`. The tarball contains only `dist/`, `schema/`, the readme/changelog, and legal notices. `private: true` prevents publishing.

## Express

```ts
import express from 'express';
import { createAgentGuard, consoleAdapter } from '@imwyvern/agent-guard';
import { agentGuard } from '@imwyvern/agent-guard/express';

const guard = createAgentGuard({
  project: 'local-catalog', env: 'demo', mode: 'detect',
  projectSeed: 'stable-project-seed',
  canary: {
    secret: process.env.AG_CANARY_SECRET!, // operator-supplied HMAC secret
    registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] },
  },
  alerts: { adapters: [consoleAdapter()] },
  lures: { robots: 'append' },
});
const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(agentGuard(guard)); // body parsers must precede the guard
app.get('/', (_req, res) => res.send('<h1>Local catalog</h1>'));
app.use((_req, res) => res.status(404).send('Not Found\n'));
const server = app.listen(3000, '127.0.0.1');
// On shutdown: stop accepting requests, then await guard.close() to flush alerts.
```

When using a registry filename, prepare it with the CLI. An empty registry generates six canonical decoy canaries in memory. Persist registry placements with the CLI if tokens must remain stable across restarts. The seed controls harmless fake data; canary IDs remain cryptographically random.

## Native Node HTTP

```ts
import { createServer } from 'node:http';
import { agentGuardNode, wrap } from '@imwyvern/agent-guard/node';

// Reuse the guard configured above.
const middleware = agentGuardNode(guard);
const server = createServer((req, res) => {
  // If this host parses a body, attach the bounded parsed value as req.body
  // before calling middleware. The guard never consumes the request stream.
  middleware(req, res, () => {
    res.statusCode = 404;
    res.end('Not Found\n');
  });
});
// Equivalent for a host that already provides req.body:
const listener = wrap(guard, (_req, res) => res.end('Hello'));
```

`inspect(AGRequest)` returns `{ action: 'pass', events }` or `{ action: 'respond', response, events }`. Direct users handle the core's plain `404` themselves. Adapters delegate verified crawlers to the host so its native missing-route response is preserved. Reserve decoy paths: disable or override any decoy that collides with a real route.

Opt-in robots/HTML/llms transformations buffer at most 1 MiB on selected paths; ordinary streams pass through. Install before compression. Transformations apply only to successful, uncompressed responses. Only the login HTML comment changes a real HTML page, when explicitly enabled.

## Hono (Node runtime)

The v0.2 Hono adapter is available as `@imwyvern/agent-guard/hono`, with an optional `hono` peer. It requires Node ≥20: the shared core still uses `node:crypto` and Node DNS. Edge runtimes and a WebCrypto core are roadmap v0.3 work.

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { agentGuard } from '@imwyvern/agent-guard/hono';

// Reuse the guard configured in the Express example.
const app = new Hono();
app.use('*', agentGuard(guard));
app.post('/login', async c => c.json(await c.req.json()));
app.get('/', c => c.text('Local catalog'));
app.notFound(c => c.text('Not Found\n', 404));
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 3000 });
```

Install Hono and your Node server integration in the consuming app. This repository installs both only as dev dependencies; the adapter adds no runtime dependencies. `agentGuard` accepts a guard or config, scans eligible bodies from a cloned request up to the configured body cap (default 16 KiB), and leaves the original body available to downstream handlers. JSON and form bodies are supported; malformed/truncated input is scanned as bounded text. The host remains responsible for wire-size limits and body-read deadlines. `@hono/node-server` supplies the socket IP; forwarded headers require an explicit trusted `clientIp` callback.

Detection remains alert-only: canary replay continues to the host, decoys have noindex/no-store headers, and verified crawlers reach the host's native missing-route handler. Opt-in robots/HTML/llms transforms preserve the existing 1 MiB buffer limit. Run `npm run demo:hono` (`PORT` and `AGENT_GUARD=off` work as in the other catalog demos). Hono runs the same shared acceptance suite as Express and Node.

## MCP / LLM tool endpoint decoy

```sh
npm run demo:mcp
curl -s http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"export_customer_records","arguments":{}}}'
```

The local Node HTTP example implements minimal JSON-RPC `initialize`, `tools/list` and `tools/call` at `POST /mcp`. `echo` and `get_time` are harmless real tools. Calling the listed `export_customer_records` decoy emits `decoy_hit` with `decoy.id: "MCP"` through the normal alert pipeline and returns a JSON-RPC permission error. It executes no business operation and returns no records, secrets or canaries. Real tool calls remain alert-only, including normal inert canary replay detection in tool arguments.

The root exports `mcpDecoyTools`, `inspectMcpRequest(guard, request, toolName?)` and `lintMcpDecoyDescription`. Call the helper once after bounded parsing, passing a tool name only for `tools/call`; handle `crawler_bypass` as the host's native 404. The example applies this to discovery too, so verified crawlers never see decoy tools. All MCP JSON responses are noindex/no-store. Built-in descriptions are neutral data, with tests rejecting imperative language, URLs and hidden characters. This example is a limited HTTP scenario, without full MCP Streamable HTTP, sessions or SSE support. See [MCP scenario and safety rules（中文）](docs/scenarios/mcp.md) for OWASP MCP01/MCP08 threat mapping, schema details and integration boundaries.

## Configuration

Every public field has defaults documented in [src/types.ts](src/types.ts). Required fields: `project`, `env`, `mode: 'detect'`, `projectSeed`, and `canary.secret`/`canary.registry`.

| Option | Default / behavior |
| --- | --- |
| `canary.prefix` | `AG-CANARY-`; pattern `^[A-Z][A-Z0-9]{1,15}-CANARY-$` |
| `canary.registry` | Required version-1 object or JSON path; no secret is stored in it |
| `decoys.enabled` | D1–D5; `/.env` aliases, admin subtree, ops notes, OpenAPI, fake login |
| `decoys.basePath` | `/api/internal` |
| `decoys.paths` / `siteName` | Optional path overrides / `.invalid` email domain |
| `lures.robots` | `manual`; `append` preserves the host robots response, `off` disables integration |
| `lures.htmlComment` | `false`; `{ paths: ['/login'] }` opts in; ≤120 bytes/page |
| `lures.llmsTxt` | `false`; appends a reference only to an existing successful response |
| `canaryScan.headers` / `query` | Both `true`; paths always scanned |
| `canaryScan.bodyPaths` / `maxBodyBytes` | `['/login', '/api/auth/*']` / 16384; D5 always scanned |
| `crawler.verify` / `timeoutMs` / `failOpen` | `true` / 300 / `true` |
| `crawler.resolver` | Node DNS; inject `{ reverse, resolve }` for offline use |
| `crawler.extraSuffixes` / `ipRangesFile` | Optional crawler-family suffixes / offline JSON `{ google: ['CIDR'] }` |
| `allowlist` | Optional exact `ips`, IPv4/IPv6 `cidrs`, `uaPatterns`, exact `headerToken` |
| `alerts.adapters` | No default destinations; `webhookAdapter()` and `consoleAdapter()` available |
| `alerts.minSeverity` | `info` for decoy/replay; explicit value also enables probe/discovery escalation |
| `alerts.dedupeWindowSec` | 600; same event + placement/ID + client key |
| `alerts.ratePerMinute` | 30 per channel; suppressed counts carried in the next alert summary |
| `alerts.redactIp` | `true`; coarse IPv4/IPv6 networks in alerts |
| `log.sink` / `level` / `keepIp` | stdout JSONL / `info` / `true` |
| `clientIp` | Socket IP; override only after validating a trusted proxy |
| `onEvent` | Optional observer; observer/sink failures are isolated |

`guard.robotsLines()` supports manual robots integration. `guard.htmlCommentFor(path)` returns the opt-in comment or null. `guard.metrics()` returns request/event/delivery counts and bounded recent inspect timing quantiles. Scores are bounded per-instance observations, never enforcement. Client state: 50k entries, 30-minute idle TTL; crawler cache: 10k, positive 24h / negative 1h. No forwarded header is trusted automatically.

D5 always denies login with a deterministic 300–600ms delay. All decoys are `noindex`, `no-store`, ≤8KiB, use only `.invalid` hostnames, and never create cookies, authenticate, or call business services. Declared AI crawler decoy hits have `info` severity. Search crawler DNS checks occur only on decoy routes. Errors/timeouts fail open to a native 404.

## Alerts and signatures

```ts
import { webhookAdapter, verifyWebhookSignature } from '@imwyvern/agent-guard';
const adapter = webhookAdapter({
  url: 'http://127.0.0.1:4000/events', secret: process.env.AG_WEBHOOK_SECRET!,
  timeoutMs: 5000,
});
// Receiver: verify the ORIGINAL body string before parsing JSON.
const valid = verifyWebhookSignature({
  body: rawBody, timestamp: timestampHeader, signature: signatureHeader,
  secret: process.env.AG_WEBHOOK_SECRET!, toleranceSec: 300,
});
```

HMAC input is `timestamp + '.' + body`; headers are `X-AgentGuard-Timestamp` and `X-AgentGuard-Signature: sha256=<hex>`. Redirects are refused. The receiver should additionally deduplicate event IDs to reject duplicate delivery inside the timestamp window. Delivery runs asynchronously with eight workers, a bounded queue, 5s attempt deadline, and two retries; `close()` flushes pending deliveries. Webhook-specific deadlines can be shorter. Alert records contain only request metadata and canary ID/provenance, never body or Cookie/Authorization values. Summary counts represent suppressed notifications and are emitted with the next admitted alert, not a background timer. Probe/discovery traffic logs without alerting by default.

## Canary CLI

```sh
# Set AG_CANARY_SECRET in your environment; never commit it.
node dist/cli/main.js canary new --env demo --placement 'D1:/.env#ADMIN_API_TOKEN'
node dist/cli/main.js canary list
node dist/cli/main.js canary scan ./config
node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
node dist/cli/main.js report --since 7d ./events.jsonl
```

`canary new` also accepts `--prefix ACME-CANARY-` when creating a registry and `--registry <file>`. Scan exits 1 with `file:line` when canonical prefixes or registry tokens appear outside the registry/`src/decoys/*.ts` whitelist; usage errors exit 2. Symlinks and `.git`, `node_modules`, `dist`, `coverage` are skipped. Scan a targeted configuration directory to avoid intentional documentation/test examples. Registry exact matches permit older tokens after secret rotation. `report` summarizes observed events/delivery latency; FP/detection rates require labeled simulation sessions.

Example adopting-project CI step (uses only the built CLI):

```yaml
- name: Prevent canaries in real configuration
  run: node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
```

## Demos and benchmarks

```sh
npm run demo:express
PORT=3001 npm run demo:node
AGENT_GUARD=off npm run demo:express
npm run bench:simulate
npm run bench:latency
npm run bench:latency:hr
npm run lhci
npm run bench
```

Demos default to `PORT=3000`, `AGENT_GUARD=on`, console alerts, and offline injected DNS. Optional `AG_WEBHOOK_URL` adds the signed webhook; `AG_WEBHOOK_SECRET` and `AG_CANARY_SECRET` override local demo secrets. These demo defaults are for local research.

Both demos share `/`, `/list`, `/item/:id`, `/login`, `/logout`, `/pricing`, robots/sitemap/static content, and the native 404. Demo login uses `demo@example.invalid` / `demo-password`. The benchmark runs S1–S5 on both demos with the specified session counts and a fixed seed, validates signed alert arrival, runs latency warmup + median of three runs, and checks 50k client memory. With TCP available it runs autocannon for 30 seconds / 100 connections per run. Lighthouse uses local Chrome, `--headless --no-sandbox`, both form factors, five URLs, and five runs per URL/mode/demo.

Quick manual check against a running demo (second terminal):

```sh
PORT=3000 npm run demo:express          # or: npm run demo:node
curl -s -A 'Mozilla/5.0 Chrome/130' http://127.0.0.1:3000/   # real page, no event
TOKEN=$(curl -s http://127.0.0.1:3000/.env | sed -n 's/^ADMIN_API_TOKEN=//p')   # decoy_hit (high)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/internal/admin/users   # canary_replay (critical)
```

The demo terminal prints one-line JSON events and console alerts. All tokens are inert `AG-CANARY-` strings that unlock nothing.

From v0.2, `npm run bench:latency:hr` is the primary AC-10 measurement for Express, Node and Hono: isolated keep-alive clients/servers, µs-resolution timing, three interleaved runs at 100/10 connections, and core inspect ns/op (about 3 minutes). Thresholds remain Δp50 ≤200 µs, Δp99 ≤1000 µs, and 50k-client heap ≤10 MB; only the 100-connection row decides latency. See [v0.2 results and configuration](docs/bench-v0.2.md); raw JSON is `bench/results/latency-hr.json`, including historical autocannon secondary evidence. The original `bench` command retains its v0.1 autocannon gate.

Measured gate failures produce a nonzero benchmark exit. `bench:latency` runs each demo server in its own child process and drives it with autocannon (100 connections, 30 s, median of 3 runs); it also records a non-gating fixed-rate run and a throughput-derived per-request overhead estimate. Lighthouse needs about 35 minutes for the full matrix. If a sandbox forbids local sockets, the research harness uses actual HTTP request/response objects over in-memory Duplex streams; TCP latency remains **unvalidated**. Chrome startup failures are **skipped**, not passed. See [benchmark report](docs/bench-v0.1.md) and [implementation notes](docs/implementation-notes.md) for the exact environment limitations. The library does not include this harness.

## What it is NOT

A WAF, DDoS defense, authentication system, bot blocker, production deployment, or guarantee of search-engine behavior. There is no auto-block, traffic throttling, trap mode, maze, reverse prompt injection, outbound probing, real vendor credential, or third-party callback honeytoken. Slack/Telegram/Feishu/email and Edge/Fastify/Hono adapters remain future work. Mechanical timing and a Prometheus endpoint are optional design ideas and are not enabled in v0.1.

See [design](docs/design.md), [contract](docs/codex-contract.md), [KPI](docs/kpi.md), and [threat model](docs/threat-model.md). Prior art informed concepts only; no third-party project code was copied.
