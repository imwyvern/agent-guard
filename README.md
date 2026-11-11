# agent-guard

An AI-agent honeypot middleware for Node and the edge.

[English](README.md) | [简体中文](docs/i18n/README.zh-CN.md) | [繁體中文](docs/i18n/README.zh-TW.md) | [日本語](docs/i18n/README.ja.md) | [한국어](docs/i18n/README.ko.md) | [Español](docs/i18n/README.es.md)

## Why

Attackers now use AI agents to probe servers, read configuration, and replay whatever keys they find. agent-guard plants isolated fake configs, keys, and endpoints — inert canaries that unlock nothing — on the HTTP/API surface of your application. When an attacker's AI touches them, you get an early, high-confidence alert and a window of time to respond: rotate keys, tighten access, or take the host offline.

This is a last-line tripwire and early-warning / delay layer at the server. It is not a replacement for patching, a WAF, or least privilege. Default mode is detect-and-alert only. An optional, default-off trap mode can slow or rate-limit a confirmed client; it does not claim to block attacks.

**What ships today, and what does not.**

- **Today** coverage is the HTTP/API layer: five isolated decoy routes, MCP and GraphQL decoys, and inert canary credentials (`AG-CANARY-…`). Zero runtime dependencies; adapters for Express, Node `http`, Hono, Fastify, and Koa on Node ≥20, plus Web / Edge adapters in v0.4b (unreleased).
- **Host-level honeyfiles** (fake `.env`, cloud creds, SSH keys, or kubeconfig on disk with access alerts) are **planned**, not shipped. A future `agent-guard seed` command is on the [roadmap](docs/roadmap.md).
- **"Fake success" deception** — a simulated environment that makes the attacker's AI believe it has breached the server — is **planned** (opt-in, safety-assessed first), not shipped. See [deception.md](docs/deception.md).
- **Burning the attacker's tokens** is **not yet demonstrated**. The experimental maze's byte ratio was 1:1 in simulation, below the 3:1 floor; the time-ratio numbers are a 25 ms/request model, not a measurement against real LLM agents. Do not enable the maze expecting token drain until that is measured. See [exhaust.md](docs/exhaust.md) and [trap-mode.md](docs/trap-mode.md).
- Canaries stay inert. The project never uses real credentials, never performs reverse prompt injection, and never probes outbound. It does not hack back.

**What it is / is not.** agent-guard detects, traps, and observes hostile or exploratory AI-agent traffic on your APIs. It does not hack back or attack anyone. See [What it is NOT](#what-it-is-not) for non-goals, opt-in features and experimental limits.

This is an open-source research project, not yet published to npm. Install from source or create a local tarball with `npm pack`. The working package name is `@imwyvern/agent-guard`. Apache-2.0, copyright 2026 Wesley Wang.

See the [security policy](SECURITY.md), [contributing guide](CONTRIBUTING.md), [positioning](docs/positioning.md), and [roadmap](docs/roadmap.md).

## Roadmap: where this is heading

These items are planned, not shipped, except where noted:

- **Host honeyfiles** — `agent-guard seed` plants inert fake `.env`, cloud credentials, SSH keys, and kubeconfig on disk, with access alerts.
- **Fake-success environment** — opt-in, safety-assessed first: a simulated service surface that may lead an attacker's AI to treat fake data as real. See [deception.md](docs/deception.md).
- **Response time window** — an incident timeline with a dwell-time metric, plus hooks so operators can run their own key-rotation or block scripts. Process-local incident correlation and `dwell_ms` already ship; the operator-facing timeline and hooks do not.
- **Isolated decoy host** — a dedicated decoy environment, separate from the production application process.
- **Real-agent token-cost evaluation** — measure whether the experimental maze actually costs a real AI agent tokens before anyone should enable it. The current 1:1 byte ratio is only a hypothesis.
- **Edge adapters (v0.4b)** — **shipped (unreleased)**: Web-standard core, Cloudflare Workers, Next.js middleware / Vercel Edge, Deno, Bun, and Hono-web.

The detailed plan is in [docs/roadmap.md](docs/roadmap.md). Scope and honest claims are in [docs/positioning.md](docs/positioning.md).

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

The v0.2 Hono adapter is available as `@imwyvern/agent-guard/hono`, with an optional `hono` peer. It requires Node ≥20: its Node core uses `node:crypto` and Node DNS. For Workers/Bun/Deno, use `@imwyvern/agent-guard/hono-web` with `createWebGuard` from `@imwyvern/agent-guard/web` (v0.4b, unreleased).

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

In default `mode: 'detect'`, detection remains alert-only: canary replay continues to the host, decoys have noindex/no-store headers, and verified crawlers reach the host's native missing-route handler. Opt-in robots/HTML/llms transforms preserve the existing 1 MiB buffer limit. Run `npm run demo:hono` (`PORT` and `AGENT_GUARD=off` work as in the other catalog demos). Hono runs the same shared acceptance suite as Express and Node.

## Fastify and Koa (Node runtime)

v0.3a (unreleased) adds `agentGuard` at `@imwyvern/agent-guard/fastify` and `@imwyvern/agent-guard/koa`, accepting the same guard or config. Register the Fastify plugin with `await app.register(agentGuard(guard))` before routes; inspection runs in `preHandler` after body parsing. Use `app.use(agentGuard(guard))` in Koa after your bounded body parser. Neither adapter consumes the request stream. Both preserve native crawler 404s, alert-only replay in detect mode, and opt-in lure transforms; frameworks are optional peers and the core adds no runtime dependencies. See the [Fastify demo](examples/fastify-demo/server.ts), [Koa demo](examples/koa-demo/server.ts), and [adapter guide](docs/community.md).

## Edge / Web runtimes

v0.4b is implemented in this **unreleased tree**, with zero runtime dependencies. Install from git/source or a local `npm pack` tarball; this package is not published to npm. Web entries use WebCrypto and structural host types; the adapters do not import `next` or `hono`.

`createWebGuard(config)` returns a Web guard; `await guard.handle(request, ctx?)` yields `Response` when intercepted or `null` to continue to the host.

| Runtime | Import suffix after `@imwyvern/agent-guard` | Client IP |
| --- | --- | --- |
| Web-standard host | `/web` (`createWebGuard`) | Host `ctx.clientIp`, or explicit `ipHeader`; otherwise `unknown` |
| Cloudflare Workers | `/workers` (`fromEnv`, `withAgentGuard`) | `fromEnv` defaults to `CF-Connecting-IP` |
| Next.js middleware / Vercel Edge | `/next` (`agentGuardMiddleware`) | Operator must set `ipHeader` |
| Deno | `/deno` (`denoHandler`) | `remoteAddr.hostname` |
| Bun | `/bun` (`bunHandler`) | `server.requestIP(request)` |
| Hono on edge | `/hono-web` (`honoWeb`) + `/web` | Explicit `ipHeader` on the Web guard |
| Hono on Node ≥20 | `/hono` (`agentGuard`) + root Node core | Socket IP; trusted `clientIp` override |

The following applies to `/web` and all five Web adapters above, including Hono on Bun/Deno. `/hono` retains the Node core (`node:crypto` / Node DNS).

| Feature | Web core / Workers / Next / Deno / Bun / Hono-web | Hono on Node (`/hono`) |
| --- | --- | --- |
| Stateless features | Decoy routes, canary generation/replay detection, HMAC-stateless maze **nodes**, fetch alerts, Prometheus (single isolate view) | Available; metrics are per process |
| Incident correlation, rateLimit, block, timing scores, maze session admission | Need `StateStore`; no store → automatically off, one console warning per guard. `memoryStore()` is per isolate, never global | Bounded process-local state |
| Crawler policy | Default `ua-bypass`: claimed Googlebot/Bingbot and other recognized search crawlers never enter trap/maze/block; `crawler.verified: false`. `custom` verifier allowed. No DNS / no DoH | Node DNS verification, or configured policy |
| `trap.delay` | Default-off; discouraged on edge because of wall-time billing; capped at 3000 ms when explicitly enabled | Default-off, opt-in |
| Forwarded headers | Unconfigured headers are untrusted; explicitly configured `x-forwarded-for` uses the rightmost nonempty hop, requiring a trusted proxy | Explicit trusted `clientIp` callback |
| SMTP | Unavailable; use webhook / Slack / Telegram / Feishu via fetch | Node-only SMTP available |

Trap remains default-off everywhere. Signed maze nodes do not grant session admission without a store; the maze remains experimental (simulation byte ratio 1:1). Durable/persistent stores are operator-provided. See [the Edge operator guide](docs/edge.md) for StateStore examples, the full degradation table, and troubleshooting. The configuration and alert examples later in this README describe the Node API.

**Workers** — supply `AG_CANARY_SECRET` and `AG_PROJECT_SEED` through environment bindings; `fromEnv(env)` rejects missing/empty values and has no default secret. This minimal example has no StateStore.

```ts
import { fromEnv, withAgentGuard } from '@imwyvern/agent-guard/workers';
import type { WebContext, WebGuard } from '@imwyvern/agent-guard/web';

let guard: WebGuard | undefined;
export default {
  fetch(request: Request, env: Record<string, unknown>, ctx: WebContext) {
    // Bind AG_CANARY_SECRET and AG_PROJECT_SEED in the host environment.
    guard ??= fromEnv(env);
    return withAgentGuard(guard, {
      fetch: () => new Response('Hello'),
    }).fetch(request, env, ctx);
  },
};
```

**Next.js / Vercel Edge** — `middleware.ts`; configure a header your trusted ingress overwrites. The adapter returns `Response` on interception and `undefined` to continue, without importing `next`.

```ts
import { createWebGuard } from '@imwyvern/agent-guard/web';
import { agentGuardMiddleware } from '@imwyvern/agent-guard/next';

const secret = process.env.AG_CANARY_SECRET;
const projectSeed = process.env.AG_PROJECT_SEED;
if (!secret || !projectSeed) throw new Error('Set AG_CANARY_SECRET and AG_PROJECT_SEED');
const guard = createWebGuard({
  project: 'catalog', env: 'production', mode: 'detect', projectSeed,
  ipHeader: 'x-real-ip', // Only trust a header overwritten by your ingress.
  canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
});
export const middleware = agentGuardMiddleware(guard);
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|assets/).*)'],
};
```

**Deno** — use a local consumer installation of the tarball with Deno 2's `nodeModulesDir: "manual"`; allow environment access for these two bindings and network access for the server.

```ts
import { createWebGuard } from '@imwyvern/agent-guard/web';
import { denoHandler } from '@imwyvern/agent-guard/deno';

const secret = Deno.env.get('AG_CANARY_SECRET');
const projectSeed = Deno.env.get('AG_PROJECT_SEED');
if (!secret || !projectSeed) throw new Error('Set AG_CANARY_SECRET and AG_PROJECT_SEED');
const guard = createWebGuard({
  project: 'catalog', env: 'production', mode: 'detect', projectSeed,
  canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
});
Deno.serve(denoHandler(guard, () => new Response('Hello')));
```

**Bun** — the adapter takes the connection IP from the server.

```ts
import { createWebGuard } from '@imwyvern/agent-guard/web';
import { bunHandler } from '@imwyvern/agent-guard/bun';

const secret = Bun.env.AG_CANARY_SECRET;
const projectSeed = Bun.env.AG_PROJECT_SEED;
if (!secret || !projectSeed) throw new Error('Set AG_CANARY_SECRET and AG_PROJECT_SEED');
const guard = createWebGuard({
  project: 'catalog', env: 'production', mode: 'detect', projectSeed,
  canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
});
Bun.serve({ fetch: bunHandler(guard, () => new Response('Hello')) });
```

**Hono on edge** — this Workers example uses the same required bindings. For Bun/Deno, create the Web guard with `createWebGuard` and configure a trusted `ipHeader` for that host. Install Hono in the consuming application.

```ts
import { Hono } from 'hono';
import { fromEnv } from '@imwyvern/agent-guard/workers';
import { honoWeb } from '@imwyvern/agent-guard/hono-web';
import type { WebGuard } from '@imwyvern/agent-guard/web';

let guard: WebGuard | undefined;
const app = new Hono<{ Bindings: Record<string, unknown> }>();
app.use('*', (c, next) => honoWeb(guard ??= fromEnv(c.env))(c, next));
app.get('/', c => c.text('Hello'));
export default app;
```

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

## GraphQL and API-only scenarios

v0.3a exports `graphqlDecoys()` and `inspectGraphqlRequest(guard, request)`. Add the returned field/type metadata to your host schema so introspection lists `internalAdminUsers`, then inspect once after bounded body parsing and before execution. A selected decoy emits `decoy_hit` with `decoy.id: "GQL"` and returns a standard GraphQL `FORBIDDEN` error with noindex/no-store; no real resolver executes for that request. Give the decoy its own inert error resolver too. Real queries pass through; malformed or excessive queries go to the host validator. Verified crawlers reach the host's native 404. See the [GraphQL demo](examples/graphql-demo/server.ts) and run `npm run demo:graphql`.

For APIs without HTML, see the [API-only guide](docs/scenarios/api-only.md): inert canaries in OpenAPI `example`, decoy error `docs_url`, and isolated `/.well-known/` files, with boundaries for SDKs and documentation clients.

## Configuration

Every public field has defaults documented in [src/types.ts](src/types.ts). Required fields: `project`, `env`, `mode: 'detect'`, `projectSeed`, and `canary.secret`/`canary.registry`.

| Option | Default / behavior |
| --- | --- |
| `canary.prefix` | `AG-CANARY-`; pattern `^[A-Z][A-Z0-9]{1,15}-CANARY-$` |
| `canary.registry` | Required version-1 object or JSON path; no secret is stored in it |
| `incident.windowMs` | 900000; fixed 15-minute correlation window, 0 disables; metadata only |
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
| `alerts.adapters` | No default destinations; webhook, console, Slack, Telegram, Feishu and SMTP/email adapters available |
| `alerts.minSeverity` | `info` for decoy/replay; explicit value also enables probe/discovery escalation |
| `alerts.dedupeWindowSec` | 600; same event + placement/ID + client key |
| `alerts.ratePerMinute` | 30 per channel; suppressed counts carried in the next alert summary |
| `alerts.redactIp` | `true`; coarse IPv4/IPv6 networks in alerts |
| `log.sink` / `level` / `keepIp` | stdout JSONL / `info` / `true` |
| `clientIp` | Socket IP; override only after validating a trusted proxy |
| `onEvent` | Optional observer; observer/sink failures are isolated |

`guard.robotsLines()` supports manual robots integration. `guard.htmlCommentFor(path)` returns the opt-in comment or null. `guard.metrics()` returns request/event/delivery counts and bounded recent inspect timing quantiles. Timing scores are bounded per-instance observations; detection scores may qualify opt-in trap gates. Client state: 50k entries, 30-minute idle TTL; crawler cache: 10k, positive 24h / negative 1h. No forwarded header is trusted automatically.

In detect mode, D5 always denies login with a deterministic 300–600ms delay. All decoys are `noindex`, `no-store`, ≤8KiB, use `.invalid` fake hostnames by default (an explicitly configured self-hosted callback URL is the exception), and never create cookies, authenticate, or call business services. Declared AI crawler decoy hits have `info` severity. In detect mode, search crawler DNS checks occur on decoy routes; opted-in trap and callback handling extend verification to preserve crawler immunity. Errors/timeouts fail open to a native 404.

## Incident correlation and canary propagation

v0.3a attaches optional `incident` metadata to existing events for the same `client_key`: `id`, ordered `sequence` (for example `robots → D1 → D2`), `first_seen`, `last_seen`, and `confidence`. `incident.windowMs` defaults to 900000 (15 minutes from the first observation); 0 disables correlation. State uses a 50k-client LRU and retains the latest 32 observations. Repeated isolated hits have low confidence; distinct decoys or discovery plus a decoy raise it to medium; `canary_replay` raises it to high. Confidence never falls within the window. Robots visits are internal markers and add no new event type. Shared networks can merge clients; correlation does not raise severity. In default detect mode it preserves HTTP responses and decoy decisions; opt-in v0.4a trap can use high confidence as a gate. Verified crawlers and allowlists remain immune. See [trap mode](docs/trap-mode.md).

Replay alerts retain `canary.id`, `placement`, `env`, `found_in`, and `field`, adding `leaked_at` (placement), `replayed_at` (pathname), `dwell_ms` (time since first decoy delivery), and `client_keys_seen` (distinct replaying client keys, capped at 8). Issuance starts when a returned decoy body contains the token; HEAD and crawler bypass do not count. Tracing is process-local, with a 50k-entry LRU and 24-hour TTL. Eviction, restart, or delivery outside built-in decoys leaves issuance unknown, so `dwell_ms` is omitted. These observations do not prove identity or malicious intent.

## Alerts and signatures

First-party adapters now include `slackAdapter`, `telegramAdapter`, `feishuAdapter` and `smtpAdapter`, alongside webhook and console. Configure destinations and credentials explicitly; none is enabled by default, and they add zero runtime dependencies. The new HTTP adapters require HTTPS except loopback and refuse redirects; SMTP supports implicit TLS (465) and STARTTLS (587), with AUTH PLAIN/LOGIN. They share the queue, deduplication, rate limits and `close()` flush described below.

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
node dist/cli/main.js lint ./config
```

`agent-guard lint <path>` (or the built CLI above) checks built-in decoy/lure output and placement files for imperative language, hidden characters, non-reserved URL hosts, and real vendor key prefixes. Findings exit 1; usage errors exit 2. It checks placement safety; use `canary scan` separately to detect accidental token leakage.

`canary new` also accepts `--prefix ACME-CANARY-` when creating a registry and `--registry <file>`. Scan exits 1 with `file:line` when canonical prefixes or registry tokens appear outside the registry/`src/decoys/*.ts` whitelist; usage errors exit 2. Symlinks and `.git`, `node_modules`, `dist`, `coverage` are skipped. Scan a targeted configuration directory to avoid intentional documentation/test examples. Registry exact matches permit older tokens after secret rotation. `report` summarizes observed events/delivery latency; FP/detection rates require labeled simulation sessions.

Example adopting-project CI step (uses only the built CLI):

```yaml
- name: Prevent canaries in real configuration
  run: node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
```

## Demos and benchmarks

```sh
npm run demo:express
npm run demo:hono
npm run demo:fastify
npm run demo:koa
npm run demo:graphql
npm run demo:mcp
PORT=3001 npm run demo:node
AGENT_GUARD=off npm run demo:express
npm run bench:simulate
npm run bench:exhaust-sim
npm run bench:deception-lint
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

From v0.3b, `npm run bench:exhaust-sim` runs an in-memory cost-ratio simulation of a bounded maze against scripted greedy agents, and `npm run bench:deception-lint` safety-scans current decoy output plus a deterministic persona prototype. Neither command enables trap features; v0.4a now separately ships opt-in trap mode with an experimental maze. See [v0.3b offline evaluation](docs/bench-v0.3b.md).

## What it is NOT

It is not a WAF, DDoS defense, authentication system or general bot blocker. It is not a replacement for patching, least privilege, or secret hygiene. This research project provides neither a production deployment nor a guarantee of search-engine behavior.

Host-level honeyfiles and "fake success" deception are planned, not shipped. Burning the attacker's tokens is not demonstrated. See [positioning](docs/positioning.md) and the short [roadmap list](#roadmap-where-this-is-heading) above.

Reverse prompt injection / counter-injection (E4) is never in the product. There is no outbound probing or guard-initiated callback toward third parties; operator-configured alert adapters are the only outbound notification exception. Existing crawler-identity DNS checks remain unchanged. Canaries stay inert HMAC tokens, never real vendor credentials. No third-party honeytoken service (Canarytokens, etc.) is used; the callback canary is operator-hosted only.

Edge / Web runtimes are **supported in this unreleased v0.4b tree**. There is no durable state unless the operator provides a store: without `StateStore`, incident correlation, rateLimit, block, timing scores and maze session admission are off with one warning; `memoryStore()` is per isolate only. The default crawler policy is unverified `ua-bypass` (no DNS / no DoH); SMTP is Node-only; `trap.delay` is default-off, discouraged on edge, and capped at 3000 ms if explicitly enabled. See [Edge / Web runtimes](#edge--web-runtimes) and [the operator guide](docs/edge.md).

v0.4a ships these **opt-in, default-off** integrations and controls. Default mode remains `mode: 'detect'`:

- Slack, Telegram, Feishu and SMTP/email alert adapters, with zero new runtime dependencies and no default destinations.
- Prometheus text export via `guard.prometheusText()` / `prometheusHandler(guard)`: no endpoint is mounted by default, and there are no path labels.
- `mode: 'trap'` with independently switched `delay`, `rateLimit`, `block` and **experimental** `maze`; verified crawlers and allowlists are never trapped.
- Self-hosted callback canaries via `canary.callback.baseUrl` + `callbackHandler(guard)`. The handler must be mounted explicitly; the guard never fetches `baseUrl`.

Mechanical timing `automation_score` also ships as an observation only: it never promotes severity or triggers block/maze by itself. The current code collects timing automatically after enough samples and has no separate enable flag.

The **experimental maze** needs the operator's own real-agent measurement before enabling it. In the [v0.3b offline simulation](docs/bench-v0.3b.md), scripted agents showed time ratios of hundreds-to-one under a **25 ms/request** model, but a **1:1 byte ratio**, below the **3:1 floor**. This does not establish real-agent cost savings. See [trap controls and risks](docs/trap-mode.md) and [Exhaust](docs/exhaust.md).

## Roadmap & design docs

- [Positioning](docs/positioning.md) — the pitch, scope boundaries, and an honest claims table (claim / status / evidence).
- [Community](docs/community.md) — how to contribute adapters, signatures, translations, and RFCs.
- [Roadmap](docs/roadmap.md) — direction of travel, v0.4a/v0.4b completion (unreleased), and the v0.5+ plan; persona/deception extensions remain design work.
- [Edge operator guide](docs/edge.md) — runtime setup, StateStore examples, degradation, and troubleshooting.
- [Exhaust](docs/exhaust.md) — implemented opt-in delay and experimental maze; context burn (E3) remains unimplemented; token drain is not demonstrated.
- [Deception](docs/deception.md) — making decoy data believable so an attacker’s agent may treat it as real; "fake success" is planned, not shipped.
- [Design](docs/design.md), [contract](docs/codex-contract.md), [KPI](docs/kpi.md), and [threat model](docs/threat-model.md). Prior art informed concepts only; no third-party project code was copied.
