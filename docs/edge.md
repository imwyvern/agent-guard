# Edge / Web operator guide

Status: v0.4b Web core and v0.5c Workers local template / Web Bot Auth implemented, **unreleased**, 2026-11-23 (HKT). The package is not published to npm. Zero runtime dependencies; the Workers template is source in git only, with no deployed Worker or published artifact. Managed StateStore adapters are not supplied. This guide covers the Web-standard core and its thin host adapters. See the [README](../README.md#edge--web-runtimes), [design](design.md), and [threat model](threat-model.md).

## Install and choose an entry

Use a git/source checkout: run `npm run build`, then `npm pack` and install the resulting `imwyvern-agent-guard-0.1.0.tgz` in a separate consuming application. See [local installation](../README.md#install-and-validate-locally). No registry installation is available yet. This guide and its storage examples are documentation only, outside the current npm pack file list; they add no dependencies. The tarball's Node ≥20 engine declaration remains; Web entry bundles are built for neutral hosts.

| Import | API / host |
| --- | --- |
| `@imwyvern/agent-guard/web` | `createWebGuard`, `memoryStore`, `WebBotAuthVerifier`, `acceptSignatureHeader`, `StateStore` / `WebGuard` / `WebBotAuthOptions` types, Web fetch alert adapters |
| `@imwyvern/agent-guard/workers` | `fromEnv(env)`, `withAgentGuard(guard, handler)` around `{ fetch }` |
| `@imwyvern/agent-guard/next` | `agentGuardMiddleware(guard)` for Next.js middleware / Vercel Edge; no `next` import |
| `@imwyvern/agent-guard/deno` | `denoHandler(guard, next)` for `Deno.serve` |
| `@imwyvern/agent-guard/bun` | `bunHandler(guard, next)` for `Bun.serve` |
| `@imwyvern/agent-guard/hono-web` | `honoWeb(guard)` for Hono on Workers/Bun/Deno; no `hono` import inside the adapter |
| `@imwyvern/agent-guard/hono` | Existing Node adapter: `agentGuard`, Node `node:crypto` / DNS, optional Hono peer |

Import Web alert adapters from `/web`, not the root Node entry. Install host frameworks in the consuming application. Deno 2 can resolve bare package imports from a consumer `package.json` and an installed tarball with `nodeModulesDir: "manual"` in `deno.json`; there is no published npm package for an `npm:` download. Run the Deno server with permission to read `AG_CANARY_SECRET` and `AG_PROJECT_SEED` (`--allow-env=AG_CANARY_SECRET,AG_PROJECT_SEED`) and the network permissions your listener/alert destinations need.

`createWebGuard(config)` returns a `WebGuard`. `await guard.handle(request, ctx?)` returns a standard `Response` when intercepted and **`null`** to continue to the host. `guard.inspect(request)` returns a decision; `prometheusText()`, `setTrapEnabled(boolean)`, and async `close()` provide metrics, the runtime trap switch, and delivery flush. The Next adapter translates `null` to **`undefined`**. Adapters pass inspection failures through to the host. Eligible body inspection uses a bounded clone; the original body remains available downstream. Hosts still own wire-size limits and body-read deadlines.

Create one guard per isolate/configuration and reuse it. Configure `project`, `env`, `projectSeed`, and `canary.secret`/an in-memory `canary.registry` object. `mode` defaults to `detect`; the examples state it explicitly. Keep secret bindings in the host's secret manager. Empty registries generate inert canaries in memory; canary IDs are random, so supply a stable registry object when placements must survive restarts.

`fromEnv(env)` requires nonempty `AG_CANARY_SECRET` **and** `AG_PROJECT_SEED`; missing bindings throw and no default secret exists. Optional bindings are `AG_PROJECT` (default `default`), `AG_ENV` (`production`), `AG_MODE` (`detect`), and `AG_IP_HEADER` (`CF-Connecting-IP`). It creates a guard without a StateStore or alert destinations; use `createWebGuard` for those configurations. It does not cache the guard for you.

## Workers local source template

The [Workers template and local instructions](../deploy/workers/README.md) in `deploy/workers/` implement E-5 in the unreleased source tree. It is supplied only in git, excluded from npm packaging, and is neither a deployed Worker nor a published template artifact. Helm remains planned. Build the library from source before using the package self-reference; an operator installs Wrangler separately for local `wrangler dev --local --ip 127.0.0.1`.

The template wraps a small example handler with `fromEnv` / `withAgentGuard`, lazily initializes a module-level guard and reuses it per isolate. It forces `mode: 'detect'` even if `AG_MODE` changes; no trap or automatic blocking is enabled. It configures no StateStore, event sink or alert destination: events contribute to isolate metrics, and the stateful capabilities in the degradation table below are off with one warning. Ordinary `/` requests reach the example handler; `/.env` is an inert decoy with noindex/no-store. This does not provide persistence or cross-isolate coordination.

For local development, copy `.dev.vars.example` to ignored `.dev.vars` and fill in your own nonempty bindings. For an operator-managed environment, use `wrangler secret put AG_CANARY_SECRET` and `wrangler secret put AG_PROJECT_SEED`; these configure remote secrets and are separate from the local-only development workflow. Never put secret values in `[vars]`. The example configuration has a pinned compatibility date, no account ID or active routes, and only commented KV / Durable Object bindings. `CF-Connecting-IP` is trusted by `fromEnv` only because ingress must overwrite it; direct local callers can spoof it. See [IP header trust](#ip-header-trust).

## Web Bot Auth configuration

The verifier follows `draft-ietf-webbotauth-httpsig-protocol-01` / RFC 9421 and accepts both Dictionary `Signature-Agent` (label mapped directly to an HTTPS JWKS URL) and the legacy bare sf-string. It uses only `globalThis.crypto.subtle`; Ed25519 is the supported verification algorithm and is required in the host WebCrypto implementation. Missing WebCrypto or Ed25519 support yields `unsupported`, without a trust bypass or an exception to the host. Node and all Web adapters use the same verifier; Node crawler DNS and Web's existing UA/custom policies continue to apply independently.

Set `webBotAuth.enabled: true` on `createWebGuard` or `createAgentGuard`. The default is false, with no signature parsing, cryptography or key discovery. `fromEnv` exposes no Web Bot Auth environment binding; use `createWebGuard` for this configuration. For static keys, pass this option alongside your usual project, canary and secret configuration:

```ts
import type { WebBotAuthOptions, JsonWebKeySet } from '@imwyvern/agent-guard/web';

export function staticAgentAuth(keys: JsonWebKeySet): WebBotAuthOptions {
  return {
    enabled: true,
    trustedAgents: [{ url: 'https://agent.example/jwks.json', keys }],
  };
}
```

Supply the agent's public Ed25519 JWKS. Only a valid signature **and** a URL in `trustedAgents` grants trust. The guard emits debug `crawler_bypass` with `ua_class: 'verified_crawler'` and `web_bot_auth: { agent_url, keyid, verified: true, trusted: true }`. It bypasses decoy bodies, maze and every trap action; reserved decoy/maze routes follow crawler missing-route behavior, while ordinary routes continue to the host. This grants no application authentication or authorization. Untrusted/self-signed, invalid, expired or unsupported signatures produce the same decisions as unsigned requests, apart from observational metadata on existing events; they do not independently increase severity or block. A valid fetched key for an unlisted URL can yield `verified: true, trusted: false` and still grants no bypass. Signature bytes are never recorded.

| Option under `webBotAuth` | Default | Validated guard configuration / behavior |
| --- | --- | --- |
| `enabled` | `false` | Explicit opt-in only |
| `trustedAgents` | Empty | Each `{ url, keys? }` binds one normalized HTTPS agent URL to its own public JWKS; 1–64 keys per supplied set. No key lookup by `keyid` alone |
| `clockSkewSeconds` | 60 | Safe integer 0–86400; tolerates future creation / expired timestamps within skew |
| `maxSignatureAgeSeconds` | 86400 (24 h) | Safe integer 1–`Number.MAX_SAFE_INTEGER`; bounds both `expires - created` and age since creation (with skew) |
| `fetchKeys` | Absent | No outbound fetch by default; static keys take precedence for that URL; no startup prefetch |
| `fetchKeys.fetcher` | None | Required operator callback `(url, { signal, headers, redirect: 'manual' }) => Promise<Response>` |
| `fetchKeys.allowHosts` | Required with fetcher | Exact case-insensitive hostnames; no wildcard or subdomain matching; empty list means no fetch |
| `fetchKeys.timeoutMs` | 2000 | Safe integer 1–5000 ms; includes cache read, fetch and streamed body read |
| `fetchKeys.maxBytes` | 65536 (64 KiB) | Safe integer 1–262144 (256 KiB); checks Content-Length and actual streamed bytes |
| `fetchKeys.maxTtlSeconds` | 86400 | Safe integer 0–86400; caps positive cache lifetime, respects Cache-Control max-age / no-cache / no-store and Age |
| `fetchKeys.cache` | Absent | Optional operator StateStore; local LRU remains bounded at 256 URLs, failures cached for 30 s, at most 32 pending lookups per verifier |

Agent URLs are at most 2048 characters, HTTPS only, with no credentials, fragments, backslashes, whitespace or non-default ports. Lookup uses the complete normalized URL, with no well-known-path discovery. An injected fetcher receives `redirect: 'manual'`; 3xx, redirected responses, mismatched final URLs and non-200 responses are rejected. Accepted media types are `application/json`, `application/jwk-set+json` and `application/http-message-signatures-directory+json`, each carrying a direct public JWKS, not a nested directory traversal. Invalid UTF-8/JSON/JWKS, timeouts and oversized responses grant no trust and get bounded negative caching. The operator must honor redirect/cancellation settings and restrict DNS/egress for allowed hosts; host matching alone does not prevent DNS rebinding or access to private addresses. External cache capacity and integrity are also the operator's responsibility; see the [threat model](threat-model.md).

Signatures must include `created`, `expires`, a SHA-256 JWK-thumbprint `keyid`, `tag="web-bot-auth"`, `@authority`, and coverage of the matching `"signature-agent";key="<label>"` member (the whole bare-string field for legacy form). Other tags are ignored. There is **no nonce store**: replay remains possible within `expires` plus clock skew and within the covered components. Signing only the required authority/agent components does not bind method, path, query or body; agents should cover the request-specific components they need. This is signature verification, not proof of benign intent.

The root Node entry and `/web` export `WebBotAuthVerifier`, `acceptSignatureHeader`, `signatureBase`, `verifyEd25519` and `jwkThumbprint`, with types including `WebBotAuthOptions`, `JsonWebKeySet` and `WebBotAuthResult`. The standalone verifier also defaults to disabled. `acceptSignatureHeader({ label?, legacy? })` returns an `Accept-Signature` value covering authority and the agent field, tagged `web-bot-auth` (default label `sig1`, Dictionary form). An operator may attach it to their own normal/403 response; the guard **never adds it automatically**, including to decoys. The cryptographic helpers alone do not enforce agent trust policy.

## Full support and degradation table

All six Web entries (`/web`, `/workers`, `/next`, `/deno`, `/bun`, `/hono-web`) use the same Web core. Runtime-specific IP sourcing is listed below. `/hono` continues to use the Node core.

| Capability | Web, no StateStore | Web with `store` | Node core / `/hono` |
| --- | --- | --- | --- |
| Decoy routes; canary generation/replay detection | Available | Available | Available |
| HMAC-stateless maze node construction/MAC verification | Available as stateless logic; no session admission | Available; serving sessions still requires opt-in trap/maze and admission gates | Available with opt-in maze |
| Incident correlation | Automatically off | Enabled unless `incident.windowMs: 0`; store scope applies | Bounded process-local state |
| `trap.rateLimit`, `trap.block` | Automatically off | Available only with explicit trap flags and confirmation gates; store scope/coordination applies | Opt-in, process-local |
| Timing / `automation_score` | Automatically off | Observed after enough samples; never alone triggers block/maze or increases severity | Bounded process-local observation |
| Maze session admission and budgets | Automatically off, even for a valid signed node | Explicit opt-in; store scope/coordination applies | Experimental, bounded process-local state |
| Warning on degradation | One console warning at guard creation listing the five state-dependent capabilities | No missing-store warning; `memoryStore()` is still only per isolate | No Web degradation warning |
| Webhook / Slack / Telegram / Feishu alerts | Fetch delivery available; explicit destinations | Same; delivery queues, dedupe and channel limits remain per guard | Available |
| SMTP/email | Unavailable; never import the Node transport into the Web graph | Unavailable | Node-only |
| Prometheus | Single isolate / guard view; host must mount/protect endpoint | Still a single isolate view, even with persistent state | Per-process view |
| Search crawler policy | Default `ua-bypass`, unverified; `custom` alternative; no DNS or DoH | Same | Node DNS or configured policy |
| Web Bot Auth | Opt-in, default-off, WebCrypto Ed25519; trusted URL + valid signature bypasses decoy/maze/trap; no store required for static keys | Same; `fetchKeys.cache` is a separate optional key-cache setting | Same verifier, independent of crawler DNS |
| `trap.delay` | Default-off; current decoy delay path needs store-backed admission | Default-off, explicit opt-in, capped at 3000 ms; discouraged on edge (wall-time billing) | Default-off opt-in trap delay |
| Registry files / `crawler.ipRangesFile` / DNS resolver options | Rejected: use an in-memory registry, `ua-bypass` or `custom` | Same | Node filesystem/DNS options available |
| Node robots/HTML/llms response transforms and `prometheusHandler` | Not exposed by the Web guard; host owns response integration and metrics routing | Same | Node integration APIs available |
| Node propagation observations (`dwell_ms`, `client_keys_seen`) | Not collected by the Web core; replay still includes ID and placement/path provenance | Not added by providing a store | Process-local issuance/replay tracing |

Missing store means these stateful features are off; supplying `memoryStore()` enables them **within one isolate only**. Neither isolate reuse nor durable persistence implies global rate-limit/block enforcement. Trap is default-off in every runtime; `setTrapEnabled(true)` does not opt into individual features. The maze remains experimental: the simulation byte ratio is 1:1, not demonstrated token drain. See [trap mode](trap-mode.md) and [Exhaust](exhaust.md).

## Minimal host examples

These five fenced examples are byte-identical to the corresponding README examples. They intentionally omit a store and alert destinations; expect the one missing-store warning.

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

## StateStore contract and isolate memory

The public interface accepts synchronous or asynchronous implementations. `ttlMs` is milliseconds. Reads must return `undefined` after expiry and must not renew TTL. Keep values JSON-serializable for the remote examples; preserve nested arrays/objects and keep project/environment namespaces separate.

```ts
interface StateStore {
  get<T>(key: string): T | undefined | Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}
```

For local experiments, reuse a bounded store within the guard's isolate:

```ts
import { createWebGuard, memoryStore } from '@imwyvern/agent-guard/web';
import type { WebGuardConfig } from '@imwyvern/agent-guard/web';

export function isolateGuard(config: WebGuardConfig) {
  return createWebGuard({ ...config, store: memoryStore({ maxEntries: 50_000 }) });
}
```

The default cap is 50k entries, with LRU eviction. Expiry/eviction, isolate restart and scale-out lose or partition observations; this is never a global block list. External stores are operator-provided. Their latency affects inspection and their failures can cause inspection to pass through to the host.

**Coordination boundary:** `StateStore` has only get/set/delete, with no atomic read-modify-write operation. The guard serializes updates within that guard. Multiple guards/isolates can race on client state, the shared block list, or maze budgets even against a strongly consistent backend. KV adapters below illustrate persistence and TTL, not strict global enforcement. If you need coherent budgets, route all requests in a project/environment to one coordinating guard (for example the Durable Object below), or design equivalent coordination around the entire inspection operation.

### Cloudflare KV (documentation only)

Wrap an operator-created KV namespace binding; no Cloudflare package is required. Native KV is eventually consistent and has minimum expiration granularity. The envelope enforces the requested TTL on reads; the KV expiration only reclaims storage. This cannot repair stale reads, lost concurrent updates or platform write-rate limits. Do not treat it as an authoritative global rate limiter or blocker.

```ts
import type { StateStore } from '@imwyvern/agent-guard/web';

type KVNamespaceLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
  delete(key: string): Promise<void>;
};
export function cloudflareKvStore(kv: KVNamespaceLike): StateStore {
  return {
    async get<T>(key: string) {
      const raw = await kv.get(key);
      if (raw === null) return undefined;
      const entry = JSON.parse(raw) as { value: T; expires: number };
      return entry.expires > Date.now() ? entry.value : undefined;
    },
    async set<T>(key: string, value: T, ttlMs: number) {
      if (ttlMs <= 0) { await kv.delete(key); return; }
      await kv.put(key, JSON.stringify({ value, expires: Date.now() + ttlMs }), {
        expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000)),
      });
    },
    delete: key => kv.delete(key),
  };
}
```

Pass `store: cloudflareKvStore(env.AG_STATE)` to `createWebGuard` alongside your config. Supply the namespace binding yourself. Benchmark latency and provider write limits before considering it for a request path.

### Cloudflare Durable Object (documentation only)

Keep the **guard itself** in one object and send the same project/environment's requests to that object. Merely forwarding store get/set/delete calls from independent edge guards does not serialize whole inspections. This example uses structural storage types, an expiry envelope and lazy cleanup. Operators must configure the object binding, migrations, ingress and storage cleanup/quotas; it is not a shipped Workers template.

```ts
import { createWebGuard } from '@imwyvern/agent-guard/web';
import type { StateStore, WebGuard } from '@imwyvern/agent-guard/web';

type ObjectStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
};
function durableObjectStore(storage: ObjectStorage): StateStore {
  return {
    async get<T>(key: string) {
      const entry = await storage.get<{ value: T; expires: number }>(key);
      if (!entry) return undefined;
      if (entry.expires > Date.now()) return entry.value;
      await storage.delete(key);
      return undefined;
    },
    async set<T>(key: string, value: T, ttlMs: number) {
      if (ttlMs <= 0) { await storage.delete(key); return; }
      await storage.put(key, { value, expires: Date.now() + ttlMs });
    },
    async delete(key: string) { await storage.delete(key); },
  };
}
export class GuardObject {
  private readonly guard: WebGuard;
  constructor(ctx: { storage: ObjectStorage; waitUntil(p: Promise<unknown>): void },
    env: { AG_CANARY_SECRET: string; AG_PROJECT_SEED: string }) {
    this.guard = createWebGuard({
      project: 'catalog', env: 'production', mode: 'detect',
      projectSeed: env.AG_PROJECT_SEED,
      ipHeader: 'CF-Connecting-IP',
      canary: { secret: env.AG_CANARY_SECRET,
        registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
      store: durableObjectStore(ctx.storage),
    });
    this.context = ctx;
  }
  private readonly context: { waitUntil(p: Promise<unknown>): void };
  async fetch(request: Request) {
    return await this.guard.handle(request, this.context) ?? new Response('Hello');
  }
}
```

The trusted ingress must preserve/overwrite the real `CF-Connecting-IP` before forwarding. Route to one object ID per configured project/environment, not a new object per request. In a real integration, replace `Hello` with your host handler; the library itself does not proxy to a production origin. Store durability does not make metrics or alert dedupe global, nor does it persist randomly generated canary registry entries.

### Vercel KV / Redis REST (documentation only)

Use an operator-provisioned Vercel KV integration exposing a Redis-compatible REST endpoint and bearer token. The example uses native `fetch`, not an installed KV SDK. It stores JSON values with millisecond `PX` expiry. It has the same cross-isolate read-modify-write race described above; verify your provider's command, TTL, consistency and latency guarantees. Keep endpoint credentials server-side.

```ts
import type { StateStore } from '@imwyvern/agent-guard/web';

export function vercelKvStore(endpoint: string, token: string): StateStore {
  if (new URL(endpoint).protocol !== 'https:') throw new Error('KV requires HTTPS');
  async function command(args: Array<string | number>): Promise<unknown> {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'manual',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) throw new Error('KV request failed');
    const reply = await response.json() as { result?: unknown; error?: string };
    if (reply.error) throw new Error('KV command failed');
    return reply.result;
  }
  return {
    async get<T>(key: string) {
      const raw = await command(['GET', key]);
      if (raw === null) return undefined;
      if (typeof raw !== 'string') throw new Error('Unexpected KV value');
      return JSON.parse(raw) as T;
    },
    async set<T>(key: string, value: T, ttlMs: number) {
      if (ttlMs <= 0) { await command(['DEL', key]); return; }
      await command(['SET', key, JSON.stringify(value), 'PX', Math.ceil(ttlMs)]);
    },
    async delete(key: string) { await command(['DEL', key]); },
  };
}
```

Pass `store: vercelKvStore(endpoint, token)` to `createWebGuard`, reading the endpoint/token from the integration's environment bindings. This example is not used for alerts; it is explicit operator storage traffic, not crawler DNS or probing.

## IP header trust

| Host | Default / operator action |
| --- | --- |
| Bare `/web` | Host-supplied `ctx.clientIp`; without that or `ipHeader`, IP is `unknown` |
| Workers `fromEnv` | `CF-Connecting-IP`; optional `AG_IP_HEADER` override is a trust decision |
| Next.js / Vercel Edge | Set `ipHeader` explicitly, for example `x-real-ip` or `x-forwarded-for`, only behind ingress that overwrites/sanitizes it |
| Deno | `denoHandler` supplies `info.remoteAddr.hostname` |
| Bun | `bunHandler` supplies `server.requestIP(request)?.address` |
| Hono-web | Configure `ipHeader` for the actual trusted ingress; it does not infer a Deno/Bun socket IP |

Unconfigured forwarded headers are ignored. A configured `ipHeader` takes precedence over the connection context; a missing/empty value produces `unknown`. Configured `x-forwarded-for` selects the **rightmost nonempty hop**. The guard does not discover a trusted proxy chain: you must ensure that this hop is the intended client and untrusted callers cannot forge it. Do not select the leftmost client-supplied value or expose an origin that accepts forged ingress headers. Shared/unknown addresses merge client keys and distort correlation, allowlists and trap decisions. The Node `clientIp` configuration is separate; it is not an automatic trust policy for forwarded headers.

## Crawler policy

The Web default is `crawler.verify: 'ua-bypass'`. A UA claiming Googlebot/Bingbot or another recognized search crawler bypasses traps, maze and block, including otherwise confirmed clients. Bypass events use `crawler.verified: false` and debug severity; this does not verify identity or escalate severity. Decoy/maze requests return a plain 404; ordinary routes continue. Spoofed crawler UAs can evade detection by design, to avoid SEO damage. Declared AI training/retrieval crawler classification is separate from recognized search-crawler bypass.

The guard does **no DNS and no DNS-over-HTTPS** on Web. `crawler.verify: 'custom'` accepts `crawler.customVerify: async (ip, ua) => boolean` using your own trusted verification data/service. Set `timeoutMs` and `failOpen` deliberately (defaults 300 ms and true); errors/timeouts with fail-open preserve bypass. Do not treat a user-supplied bot header as verification. Node DNS options and filesystem IP-range inputs are rejected on Web.

## Alerts, lifecycle and delay

Import `webhookAdapter`, `slackAdapter`, `telegramAdapter` and `feishuAdapter` from `/web`. They use fetch and explicit operator-configured destinations; SMTP needs Node TCP/TLS and is unavailable on Web. Webhook HMAC uses WebCrypto. Web/shared fetch transport uses `redirect: 'manual'` and rejects 3xx without following redirects, because workerd does not support `redirect: 'error'`. HTTPS is required except explicit loopback destinations.

Workers `{ fetch }` and Next's middleware event pass `waitUntil` to keep asynchronous deliveries alive without blocking the response. `honoWeb` uses `executionCtx` when the host provides it. Without a lifecycle context, delivery is fire-and-forget and errors are isolated; the host can terminate work after the response. Use a host lifecycle hook when available and call `close()` during graceful shutdown. Queues, dedupe, channel limits and metrics are local observations, even with an external store. Alerts contain metadata and canary ID/provenance, never request bodies, Cookie/Authorization values or credentials.

Trap remains opt-in and default-off. Edge `trap.delay` occupies wall time and may increase billing; it is discouraged. If explicitly enabled, it is capped at 3000 ms and still needs an admitted decoy request/store in the current Web path. D5's existing deterministic 300–600 ms fake-login response delay is separate from the opt-in `trap.delay` setting. Use the runtime `setTrapEnabled(false)` switch to stop trap work; the Web core does not read Node process environment kill switches.

## Troubleshooting

| Symptom | Check / remedy |
| --- | --- |
| Missing StateStore warning; no incident/timing/block/maze session | You forgot `store`. Supply an operator store, or explicitly accept stateless degradation. `memoryStore()` is only per isolate, not a global workaround |
| Forged/changing IPs or unrelated clients sharing decisions | Check trusted ingress and explicit `ipHeader`. Untrusted `X-Forwarded-For` is spoofable; configured XFF uses the rightmost nonempty hop. Missing IP becomes `unknown` |
| Workers guard refuses startup | Set both `AG_CANARY_SECRET` and `AG_PROJECT_SEED` bindings; there is no fallback secret. Reuse the guard after initialization |
| SMTP configuration/import fails on Web | Use fetch webhook / Slack / Telegram / Feishu from `/web`, or send SMTP from a Node service |
| Claimed Googlebot sees 404 / evades trap | Expected under default unverified `ua-bypass`. Use a trusted `custom` verifier if needed; no DNS/DoH fallback exists |
| Alert destination redirects / Workers fetch errors | Use the final HTTPS URL. Redirects are rejected; `manual` is the workerd-compatible fetch mode |
| Alert absent after response | Configure a destination and pass a host `waitUntil` context where available; check delivery events and local dedupe/channel limits |
| Unexpected edge cost or slow requests | Disable `trap.delay`; review wall-time billing, D5 login delay, remote store latency and host body deadlines |
| Bundle contains Node APIs | Import `/web` and Web adapters, not root or `/hono`. Run `npm run build` then `npm run check:neutral`; do not hide `node:*`, `Buffer`, `process` or `require` behind runtime detection |
| Runtime integration uncertain | From this source checkout run `npm run smoke:workers` (miniflare/workerd), `npm run smoke:bun` or `npm run smoke:deno`. These are local smoke scripts, not deployment templates |

Next return semantics are covered with structural request/event types, without installing Next. If a smoke runtime binary is absent, treat that smoke as skipped rather than passed. `npm run bench:latency:web` measures Web inspection latency separately from the Node TCP benchmark.
