# Community guide

agent-guard is an open-source research project: HTTP middleware that detects, deceives, and observes AI-agent and scanner traffic with isolated decoy routes and inert canary credentials. It is alert-only by default. It does not hack back, probe, or attack anyone.

This page describes how to contribute. Also read [CONTRIBUTING.md](../CONTRIBUTING.md), the [roadmap](roadmap.md), its [charter and non-goals](roadmap.md#6-明确不做non-goals延续-charter), the [design](design.md), and the [security policy](../SECURITY.md). Follow the [Code of Conduct](../CODE_OF_CONDUCT.md) in all project interactions.

## Contribution paths

### Runtime adapter (~50 lines)

The core interface is `AgentGuard.inspect(req): Promise<AGDecision>` in [`src/types.ts`](../src/types.ts). Existing adapters live in [`src/adapters/`](../src/adapters/):

- Express ([`express.ts`](../src/adapters/express.ts)) is a thin wrapper around the Node adapter.
- Node `http` ([`node.ts`](../src/adapters/node.ts)) maps the request to `AGRequest`, calls `inspect`, writes a decoy response or calls `next()`, and optionally installs lure transforms.
- Fastify ([`fastify.ts`](../src/adapters/fastify.ts), v0.3a / unreleased) uses `preHandler` after body parsing and `onSend` for opted-in lure transforms.
- Koa ([`koa.ts`](../src/adapters/koa.ts), v0.3a / unreleased) inspects after the host body parser and applies opted-in transforms after downstream handlers.
- Hono ([`hono.ts`](../src/adapters/hono.ts)) does the same on Hono's Web-standard `Request`/`Response`, still on Node ≥20. The shared core uses `node:crypto` and Node DNS; the Web-standard core and Edge adapters remain v0.4b work.

A new adapter should follow that contract, not invent a second inspection API:

1. Accept an existing `AgentGuard` or `AgentGuardConfig` (create the guard with `createAgentGuard` when given config).
2. Map the host request into `AGRequest`: `method`, `path` (pathname), bounded `query`, `headers`, socket IP, and `body` only when the host has already parsed it. Do not consume the request stream. Do not trust forwarded headers unless the operator supplies a `clientIp` callback. Leave over-long URLs intact so the core cannot match a truncated decoy path; see `toRequest` in the Node adapter.
3. Call `guard.inspect(request)`. Inspection or hook failures must fail open to the host.
4. If `action === 'respond'` and the events do **not** include `crawler_bypass`, send `decision.response` status, headers, and body, then stop the routing chain.
5. Otherwise continue to the host, including verified-crawler bypass, so the host's native missing-route response is preserved.
6. Optional robots/HTML/`llms.txt` transforms must match the existing adapters: only opted-in paths, only successful uncompressed responses, at most 1 MiB buffered. Ordinary streams pass through.
7. Export a framework subpath, following the existing `@imwyvern/agent-guard/fastify` and `@imwyvern/agent-guard/koa` adapters. The framework may be an optional peer. Add no runtime dependencies.
8. Run the shared acceptance suite used by Express, Node, Hono, Fastify, and Koa: ordinary human traffic does not alert; canary replay alerts; verified crawlers never enter decoys.

Fastify and Koa ship as real adapters in v0.3a (unreleased). Reuse the guard from the [README](../README.md) and register it before routes:

```ts
import Fastify from 'fastify';
import { agentGuard } from '@imwyvern/agent-guard/fastify';

const app = Fastify();
await app.register(agentGuard(guard));
app.get('/', async () => ({ status: 'ok' }));
```

```ts
import Koa from 'koa';
import { agentGuard } from '@imwyvern/agent-guard/koa';

const app = new Koa();
// Install your bounded body parser here, before the guard.
app.use(agentGuard(guard));
app.use(async ctx => { ctx.body = { status: 'ok' }; });
```

Both accept a config or an existing guard, preserve alert-only canary replay in default detect mode and verified-crawler native 404s, and add no runtime dependencies. They also forward opt-in trap decisions from the shared core. Run `npm run demo:fastify` or `npm run demo:koa`; full integrations are in [fastify-demo](../examples/fastify-demo/server.ts) and [koa-demo](../examples/koa-demo/server.ts). Close the guard on shutdown to flush alerts.

A Next.js middleware or edge adapter should say clearly which signals require Node (`node:crypto`, Node DNS, in-memory client state) and which degrade in a stateless edge runtime; a complete Edge port waits for the Web-standard core on the [roadmap](roadmap.md).

### Alerts, metrics and opt-in trap controls

v0.4a adds first-party `slackAdapter`, `telegramAdapter`, `feishuAdapter` and `smtpAdapter` (email), alongside webhook and console. All destinations require explicit operator configuration and add zero runtime dependencies. They share the bounded asynchronous queue, deduplication, rate limits and `close()` flush. The new HTTP adapters require HTTPS except loopback and refuse redirects; SMTP supports implicit TLS and STARTTLS. Alert text contains request metadata and canary IDs, never request bodies, Cookie/Authorization values or adapter credentials.

`guard.prometheusText()` and the exported Node listener `prometheusHandler(guard)` provide Prometheus text without path labels. No metrics route is mounted automatically; routing and access controls belong to the host. The self-hosted callback canary similarly requires `canary.callback.baseUrl` and an explicit `callbackHandler(guard)` mount. Its HMAC tokens are inert, HTTPS is required except loopback, and the guard never fetches `baseUrl` or contacts a third-party honeytoken service.

Default `mode: 'detect'` remains alert-only. `mode: 'trap'` exposes independent, default-off delay, rateLimit, block and **experimental** maze flags. Verified crawlers and allowlists are immune, a single `/.env` hit is insufficient, and runtime kill switches and a circuit breaker stop trap actions. Block can affect real routes for a confirmed client key. Read [trap-mode.md](trap-mode.md) and [exhaust.md](exhaust.md) before enabling controls; the v0.3b simulation's byte ratio was 1:1, below the 3:1 floor, so maze needs the operator's own real-agent measurement. Mechanical `automation_score` is automatically observed after enough samples, has no enable flag, and never raises severity or triggers block/maze by itself.

### Persona / scenario pack (roadmap)

GraphQL helpers and a [local demo](../examples/graphql-demo/server.ts) ship in v0.3a (unreleased); see also the [API-only placement guide](scenarios/api-only.md) and existing [MCP scenario](scenarios/mcp.md). Richer decoy personas and a reusable pack format for docs sites, cloud-console style, and other scenarios remain **roadmap proposals**. See [deception.md](deception.md) and [docs/scenarios/](scenarios/). If you want to contribute a pack, open a [design RFC](../.github/ISSUE_TEMPLATE/rfc.md) first and describe the format, isolation rules, and tests. Do not add a pack loader to the core until that RFC is accepted.

Until then, scenario work should stay as documented examples plus tests, following the MCP and GraphQL helpers and demos: fake data only, inert canaries, `noindex` / `no-store`, no imperative or hidden-character lure text, and verified crawlers never see decoy content.

### Detection signatures

Useful contributions include crawler-family suffixes, user-agent patterns, and regression fixtures that improve classification without changing default enforcement. Please include tests and anonymized or synthetic samples only. Behavioral scores must not, by themselves, label a client as an agent or block it. The optional incident field correlates up to 32 observations per client in a fixed 15-minute window (50k-client cap); confidence may rise without changing severity. Detect responses stay unchanged; opt-in trap can use high confidence as a gate. Canary propagation is process-local (50k records, 24-hour TTL, at most 8 replaying client keys); unknown issuance must omit dwell time. Verified crawlers and allowlisted clients must continue to bypass trap controls.

### Benchmarks and simulations

Improvements to `bench:exhaust-sim`, `bench:deception-lint`, latency runners, or documented local research harnesses are welcome. Add no new runtime or unsolicited development dependencies. Do not change `src/` behavior in a benchmark-only change. Record assumptions honestly, especially when a cost ratio is simulated rather than measured on a real agent.

### Translations

README translations live in [`docs/i18n/`](i18n/). When `README.md` changes, update all five files (`zh-CN`, `zh-TW`, `ja`, `ko`, `es`). Translate prose; keep code blocks byte-identical to the English README; keep the English product tagline and add a short gloss in the target language; and re-check relative links from `docs/i18n/`.

## RFC process

Open an issue with the [RFC template](../.github/ISSUE_TEMPLATE/rfc.md) (`design` label) **before** implementing a change to core behavior or to a safety line. Examples: altering `mode`, decoy isolation, canary inertness, crawler bypass, alert-only defaults, outbound network behavior, or adding blocking, delay, maze, or trap behavior.

An RFC should state the problem, the proposed change, the effect on the safety lines below, alternatives, and how the change will be validated locally. Discussion happens on the issue. Implementation starts only after a maintainer agrees.

Ordinary bug fixes, documentation, tests, and adapter work that preserve the existing contract do not need an RFC.

## Labels

- `good first issue` — self-contained, with acceptance criteria, suitable for a first contribution.
- `help wanted` — the project would like help; the work may be larger than a first issue.
- `design` — RFC or other design discussion; not an invitation to start coding yet.

Use existing labels such as `bug`, `enhancement`, and `documentation` when they apply.

## Safety lines

These are not optional. Pull requests that cross them will be rejected:

- Canaries stay **inert**: they never authenticate and never enter real identity providers, user databases, secret stores, cloud key lists, or CI secrets.
- No outbound probing, callbacks initiated toward a requester, retaliation, or attacks on third-party systems. Operator-configured alert adapters are the only outbound notification exception; existing crawler DNS verification retains its identity-checking scope. An operator-hosted callback **handler** may receive requests, but the library must never fetch its URL, call third-party honeytoken services (including Canarytokens), or probe attackers. Fake hosts use `.invalid`, `.example`, or reserved documentation address space; the configured self-hosted callback URL is the only decoy URL exception. Programmatic lint permits explicitly supplied exact `allowedHosts`, without relaxing the other safety rules.
- No reverse prompt injection or counter-injection (E4) in the product. Lure and decoy text is data, not instructions, and must not contain imperative "ignore previous instructions" language, hidden characters, or inducements to call out.
- No real credentials, real user data, or real business records in decoys, fixtures, issues, or logs.
- Verified crawlers (and, when implemented, verified agents) never enter decoys. Preserve fail-open crawler verification and the host's native missing-route response.
- Default remains detect + alert only. Shipped delay, rateLimit, block and experimental maze controls must remain explicitly opt-in and disabled by default, with crawler/allowlist immunity, bounded state/budgets, kill switches and circuit protection.

## Maintainers

The current maintainer is [@imwyvern](https://github.com/imwyvern).

Security vulnerabilities are reported privately through [GitHub Security Advisories](https://github.com/imwyvern/agent-guard/security/advisories/new), as described in [SECURITY.md](../SECURITY.md). Conduct reports use the same private channel, or a GitHub issue when the matter is not sensitive; see the [Code of Conduct](../CODE_OF_CONDUCT.md).

## Review checklist

Before requesting review:

- [ ] `npm run build`, `npm run typecheck`, `npm run lint`, and `npm test` pass locally.
- [ ] New behavior has focused tests. Shared acceptance coverage is updated for adapter work.
- [ ] [README.md](../README.md) and all five translations in `docs/i18n/` are updated when the English README or public behavior changes.
- [ ] [CHANGELOG.md](../CHANGELOG.md) records the change.
- [ ] The safety lines above still hold. No real secrets or personal data appear in the diff, fixtures, or issue text.
- [ ] No new runtime dependencies. Framework packages for an adapter are optional peers.
- [ ] The work is original and licensed under Apache-2.0. Do not copy code from other projects, including GPL projects.

## Contributor expectations

- Use Node.js 20 or newer, discuss substantial changes in an issue first, and keep pull requests small enough to review.
- Write original work you have the right to submit. By contributing, you license it under [Apache-2.0](../LICENSE).
- A Developer Certificate of Origin sign-off (`git commit -s`) is welcome and **optional**. There is no DCO check.
- Be respectful and constructive, and follow the Code of Conduct.
- Never commit secrets. Use only inert sample data in issues, tests, and documentation.
- Use concise imperative commit subjects in the existing `type: description` style, for example `fix: reject forged canary checksums` or `docs: clarify Fastify adapter contract`.
