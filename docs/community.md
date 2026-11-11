# Community guide

agent-guard is an open-source research project: HTTP middleware that detects, traps, and observes AI-agent and scanner traffic with isolated decoy routes and inert canary credentials. It is alert-only by default. It does not hack back, probe, or attack anyone.

This page describes how to contribute. Also read [CONTRIBUTING.md](../CONTRIBUTING.md), the [roadmap](roadmap.md), its [charter and non-goals](roadmap.md#6-明确不做non-goals延续-charter), the [design](design.md), and the [security policy](../SECURITY.md). Follow the [Code of Conduct](../CODE_OF_CONDUCT.md) in all project interactions.

## Contribution paths

### Runtime adapter (~50 lines)

The core interface is `AgentGuard.inspect(req): Promise<AGDecision>` in [`src/types.ts`](../src/types.ts). Existing adapters live in [`src/adapters/`](../src/adapters/):

- Express ([`express.ts`](../src/adapters/express.ts)) is a thin wrapper around the Node adapter.
- Node `http` ([`node.ts`](../src/adapters/node.ts)) maps the request to `AGRequest`, calls `inspect`, writes a decoy response or calls `next()`, and optionally installs lure transforms.
- Hono ([`hono.ts`](../src/adapters/hono.ts)) does the same on Hono's Web-standard `Request`/`Response`, still on Node ≥20. The shared core uses `node:crypto` and Node DNS; edge runtimes are roadmap work.

A new adapter should follow that contract, not invent a second inspection API:

1. Accept an existing `AgentGuard` or `AgentGuardConfig` (create the guard with `createAgentGuard` when given config).
2. Map the host request into `AGRequest`: `method`, `path` (pathname), bounded `query`, `headers`, socket IP, and `body` only when the host has already parsed it. Do not consume the request stream. Do not trust forwarded headers unless the operator supplies a `clientIp` callback. Leave over-long URLs intact so the core cannot match a truncated decoy path; see `toRequest` in the Node adapter.
3. Call `guard.inspect(request)`. Inspection or hook failures must fail open to the host.
4. If `action === 'respond'` and the events do **not** include `crawler_bypass`, send `decision.response` status, headers, and body, then stop the routing chain.
5. Otherwise continue to the host, including verified-crawler bypass, so the host's native missing-route response is preserved.
6. Optional robots/HTML/`llms.txt` transforms must match the existing adapters: only opted-in paths, only successful uncompressed responses, at most 1 MiB buffered. Ordinary streams pass through.
7. Export a subpath such as `@imwyvern/agent-guard/fastify` or `@imwyvern/agent-guard/koa`. The framework may be an optional peer. Add no runtime dependencies.
8. Run the shared acceptance suite used by Express, Node, and Hono: ordinary human traffic does not alert; canary replay alerts; verified crawlers never enter decoys.

The following is a **sketch** of a Fastify plugin, not a shipped adapter. It is meant to show the hook and mapping, and it omits URL-length caps, lure transforms, and tests.

```ts
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { createAgentGuard } from '@imwyvern/agent-guard';
import type { AgentGuard, AgentGuardConfig, AGRequest } from '@imwyvern/agent-guard';

function isGuard(value: AgentGuard | AgentGuardConfig): value is AgentGuard {
  return 'inspect' in value;
}

function toRequest(req: FastifyRequest): AGRequest {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  const query = Object.create(null) as AGRequest['query'];
  for (const [key, value] of Object.entries((req.query ?? {}) as Record<string, string | string[]>)) {
    query[key] = value;
  }
  return {
    method: req.method,
    path,
    query,
    headers: req.headers as AGRequest['headers'],
    ip: req.socket.remoteAddress ?? '',
    body: req.body,
  };
}

export function agentGuardFastify(configOrGuard: AgentGuardConfig | AgentGuard): FastifyPluginAsync {
  const guard = isGuard(configOrGuard) ? configOrGuard : createAgentGuard(configOrGuard);
  const plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    // preHandler runs after the host body parser. The guard never reads the stream.
    app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
      let decision;
      try {
        decision = await guard.inspect(toRequest(req));
      } catch {
        return; // fail open
      }
      if (decision.action === 'respond' && !decision.events.some((event) => event.event === 'crawler_bypass')) {
        void reply.headers(decision.response.headers)
          .code(decision.response.status)
          .send(decision.response.body);
      }
    });
  };
  return plugin;
}
```

Koa is a similar `async (ctx, next)` function. A Next.js middleware or edge adapter should say clearly which signals require Node (`node:crypto`, Node DNS, in-memory client state) and which degrade in a stateless edge runtime; a complete Edge port waits for the Web-standard core on the [roadmap](roadmap.md).

### Persona / scenario pack (roadmap)

Richer decoy personas and additional scenario packs (GraphQL, docs sites, cloud-console style, and so on) are **roadmap proposals**, not a shipping pack format. See [deception.md](deception.md) and [docs/scenarios/](scenarios/). If you want to contribute a pack, open a [design RFC](../.github/ISSUE_TEMPLATE/rfc.md) first and describe the format, isolation rules, and tests. Do not add a pack loader to the core until that RFC is accepted.

Until then, scenario work should stay as documented examples plus tests, in the spirit of the existing MCP helper and demo: fake data only, inert canaries, `noindex` / `no-store`, no imperative or hidden-character lure text, and verified crawlers never see decoy content.

### Detection signatures

Useful contributions include crawler-family suffixes, user-agent patterns, and regression fixtures that improve classification without changing default enforcement. Please include tests and anonymized or synthetic samples only. Behavioral scores must not, by themselves, label a client as an agent or block it. Verified crawlers and allowlisted clients must continue to fail open to the host.

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
- No outbound probing, callbacks to a requester, retaliation, or attacks on third-party systems. No third-party callback honeytokens. Fake hosts use `.invalid`, `.example`, or reserved documentation address space only.
- No reverse prompt injection in production. Lure and decoy text is data, not instructions, and must not contain imperative "ignore previous instructions" language, hidden characters, or inducements to call out.
- No real credentials, real user data, or real business records in decoys, fixtures, issues, or logs.
- Verified crawlers (and, when implemented, verified agents) never enter decoys. Preserve fail-open crawler verification and the host's native missing-route response.
- Default remains detect + alert only. Any future delay, maze, or budget trap must be explicitly opt-in and disabled by default.

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
