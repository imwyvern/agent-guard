# Positioning

This page states what agent-guard is for, what it ships today, and what it does not claim. It is the honest companion to the README.

Status: 2026-11-11 (HKT). Author: agent-guard maintainers.

## The pitch

Dan's own summary, written for colleagues (unedited):

> 弄了一套 AI 安全蜜罐系统，现在黑客都用 AI 入侵，我弄了一套可以诱骗 AI 误以为他入侵成功服务器，提供假的对应的服务环境配置和相关 key 之类的一套仿真环境，这样 AI 攻击到我们虚假的，就会陷入死循环，消耗他的 token，同时我们会知道被入侵了，可以有一个时间给我们操作对应安全措施。可以算是服务器层面的一个最后一道抵御外部的安全防线这样。

In English, as the project's narrative spine:

Attackers now use AI agents to probe servers, read configuration, and replay whatever keys they find. agent-guard plants isolated fake configs, keys, and endpoints — inert canaries that unlock nothing — so that when an attacker's AI touches them, the operator gets an early, high-confidence alert and a window of time to respond. Optional, default-off trap mode can slow or rate-limit a confirmed client.

This is a **last-line tripwire and early-warning / delay layer at the server**. It is not a replacement for patching, a WAF, or least privilege.

The tagline stays: *an AI-agent honeypot middleware for Node and the edge*.

Parts of that pitch are the direction of travel, not present-tense capability. The table below separates shipped behavior from planned work and from claims we will not make until there is evidence.

## Scope today

- Coverage is the **HTTP/API layer** of a Node ≥20 application: five isolated decoy routes (D1–D5), MCP and GraphQL decoys, and inert canary credentials in the `AG-CANARY-<id>-<hmac>` format.
- Adapters ship for Express, Node `http`, Hono, Fastify, and Koa. Zero runtime dependencies. Default `mode: 'detect'` is alert-only.
- Opt-in, default-off `mode: 'trap'` can delay, rate-limit, or block a confirmed client, and offers an experimental bounded maze. Verified crawlers and allowlists are never trapped. See [trap-mode.md](trap-mode.md).
- Canaries are always inert. The library never uses real vendor credentials, never performs reverse prompt injection or counter-injection (E4), and never probes outbound. Operator-configured alert adapters are the only outbound notification exception.

## Scope boundaries

- Not a WAF, DDoS defense, authentication system, or general bot blocker.
- Not a substitute for patching, least privilege, or secret hygiene.
- Not host-level coverage today: fake `.env` files, cloud credentials, SSH keys, or kubeconfig planted on disk are **planned**, not shipped.
- Not a finished "fake success" simulation: a decoy environment that makes the attacker's AI believe it has breached the server is **planned** (opt-in, safety-assessed first), not shipped. See [deception.md](deception.md).
- Not a demonstrated token-drain weapon: "burn the attacker's tokens" is a hypothesis. The [v0.3b simulation](bench-v0.3b.md) recorded a **1:1 byte ratio**, below the 3:1 floor; time-ratio figures used a 25 ms/request model against scripted agents, not real LLM agents. See [exhaust.md](exhaust.md).
- Not an attack tool: no hacking back, no outbound probing, no real credentials, no third-party honeytoken services.
- Edge runtimes (Cloudflare Workers, Next.js middleware, Deno, Bun, Vercel Edge) and a Web-standard core are **v0.4b**, not this release. Hono already runs on Node ≥20.

## Honest claims

| Claim | Status | Evidence |
| --- | --- | --- |
| Isolated HTTP/API decoy routes and inert canaries detect exploratory scanning and credential replay | Shipped | Built-in D1–D5, MCP and GraphQL decoys; canary format and registry; local acceptance tests and demos |
| Default mode is detect-and-alert only; it does not block, throttle, or retaliate unless the operator opts in | Shipped | `mode: 'detect'` default; trap flags default off; [trap-mode.md](trap-mode.md) |
| A canary replay or isolated decoy hit yields a high-confidence early alert, giving the operator time to respond | Shipped (alert and dwell observation); response actions are the operator's | Async alerts; optional incident correlation; `dwell_ms` on known issuance; no built-in key-rotation or block-script runner |
| Opt-in trap mode can delay, rate-limit, or block a confirmed client | Shipped, default off | Independent flags, confirmation gates, kill switch, circuit breaker; crawler and allowlist immunity |
| Experimental maze burns the attacker's tokens / traps them in a dead loop | **Not demonstrated** — do not claim this | [v0.3b](bench-v0.3b.md): byte ratio 1:1 (below the 3:1 floor); time ratio is a 25 ms/request model on scripted agents, not real LLM agents |
| "Fake success": the attacker's AI believes it has breached the server and receives a simulated environment | **Planned**, not shipped | Design only, in [deception.md](deception.md); must be opt-in and safety-assessed first |
| Host-level honeyfiles (`agent-guard seed`) plant fake `.env`, cloud creds, SSH keys, kubeconfig on disk and alert on access | **Planned**, not shipped | Listed on the [roadmap](roadmap.md) |
| Incident timeline with dwell-time metric and hooks to the operator's own key-rotation / block scripts | Partial: `dwell_ms` and incident fields shipped; operator-facing timeline and hooks planned | v0.3a process-local tracing; hooks are roadmap work |
| Isolated decoy host, separate from the production application process | **Planned**, not shipped | Related discussion in [distribution.md](distribution.md) |
| Edge adapters (Workers, Next.js, Deno, Bun) and a Web-standard core | **Planned** as v0.4b, not shipped | [roadmap](roadmap.md); Next.js is also tracked as issue #4 |
| Real-agent token-cost evaluation before anyone should enable the maze | **Planned**, not shipped | Required by [exhaust.md](exhaust.md) and [trap-mode.md](trap-mode.md) |
| Blocks attacks / replaces a WAF, patching, or least privilege | **Will not claim** | Out of scope; last-line tripwire only |
| Reverse prompt injection, outbound probing, or use of real credentials | **Will not do** | Charter / non-goals in [roadmap.md](roadmap.md#6-明确不做non-goals延续-charter) |

## Where this is heading

The short list in the README, expanded in [roadmap.md](roadmap.md):

1. Host honeyfiles (`agent-guard seed`)
2. Fake-success environment (opt-in, safety-assessed first)
3. Response time window / incident timeline, with dwell-time metric and hooks to the operator's own scripts
4. Isolated decoy host
5. Real-agent token-cost evaluation
6. Edge adapters (v0.4b)

## Related documents

- [README](../README.md)
- [Roadmap](roadmap.md)
- [Exhaust](exhaust.md), [Deception](deception.md), [Trap mode](trap-mode.md)
- [Threat model](threat-model.md), [Community](community.md), [Distribution](distribution.md)
