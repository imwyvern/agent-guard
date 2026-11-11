# Positioning

This page states what agent-guard is for, what it ships today, and what it does not claim. It is the honest companion to the README.

Status: 2026-11-11 (HKT), v0.5a unreleased source tree; no npm publication or version tag. Author: agent-guard maintainers.

## The pitch

Dan's own summary, written for colleagues (unedited):

> 弄了一套 AI 安全蜜罐系统，现在黑客都用 AI 入侵，我弄了一套可以诱骗 AI 误以为他入侵成功服务器，提供假的对应的服务环境配置和相关 key 之类的一套仿真环境，这样 AI 攻击到我们虚假的，就会陷入死循环，消耗他的 token，同时我们会知道被入侵了，可以有一个时间给我们操作对应安全措施。可以算是服务器层面的一个最后一道抵御外部的安全防线这样。

In English, as the project's narrative spine:

Attackers now use AI agents to probe servers, read configuration, and replay whatever keys they find. agent-guard plants isolated fake configs, keys, and endpoints — inert canaries that unlock nothing — so that when an attacker's AI touches them, the operator gets an early, high-confidence alert and a window of time to respond. Optional, default-off trap mode can slow or rate-limit a confirmed client.

This is a **last-line tripwire and early-warning / delay layer at the server**. It is not a replacement for patching, a WAF, or least privilege.

The tagline stays: *an AI-agent honeypot middleware for Node and the edge*.

Parts of that pitch are the direction of travel, not present-tense capability. The table below separates shipped behavior from planned work and from claims we will not make until there is evidence.

## Scope today

- HTTP coverage is the **HTTP/API layer** of a Node ≥20 or Web / Edge application: five isolated decoy routes (D1–D5), MCP and GraphQL decoys, and inert canary credentials in the `AG-CANARY-<id>-<hmac>` format.
- Adapters ship for Express, Node `http`, Hono, Fastify, and Koa on Node; v0.4b adds `/web`, Workers, Next.js middleware / Vercel Edge, Deno, Bun, and Hono-web in the unreleased tree. Zero runtime dependencies; not published to npm. Default `mode: 'detect'` is alert-only.
- v0.5a adds optional inert host honeyfiles (`seed`) and a Linux-only, read-only parser of operator-provided auditd/inotifywait access logs (`watch`); the guard cannot observe reads itself. It also ships the incident CLI/timeline, Node file log and summaries, plus default-off Node escalation/reminders and response hooks. See [seed.md](seed.md) and [incident-response.md](incident-response.md).
- Opt-in, default-off `mode: 'trap'` can delay, rate-limit, or block a confirmed client, and offers an experimental bounded maze. Verified crawlers and allowlists are never trapped. See [trap-mode.md](trap-mode.md).
- Canaries are always inert. The library never uses real vendor credentials, never performs reverse prompt injection or counter-injection (E4), and never probes outbound. Operator-configured alert adapters are the only outbound notification exception.

## Scope boundaries

- Not a WAF, DDoS defense, authentication system, or general bot blocker.
- Not a substitute for patching, least privilege, or secret hygiene.
- Host coverage is limited to the shipped optional `seed` honeyfiles and Linux-only `watch` access-log parser. Operators supply auditd / `inotifywait -e access` logs; the guard cannot see file reads itself. Source setup may require root; the parser does not. This is not complete host monitoring. See [seed.md](seed.md).
- Not a finished "fake success" simulation: a decoy environment that makes the attacker's AI believe it has breached the server is **planned** (opt-in, safety-assessed first), not shipped. See [deception.md](deception.md).
- Not a demonstrated token-drain weapon: "burn the attacker's tokens" is a hypothesis. The [v0.3b simulation](bench-v0.3b.md) recorded a **1:1 byte ratio**, below the 3:1 floor; time-ratio figures used a 25 ms/request model against scripted agents, not real LLM agents. See [exhaust.md](exhaust.md).
- Not an attack tool: no hacking back, no outbound probing, no real credentials, no third-party honeytoken services.
- Edge runtimes and the Web-standard core are **implemented in v0.4b (unreleased)**. Without a StateStore, incident correlation, rateLimit, block, timing and maze session admission are off with one warning. `memoryStore()` is per isolate; persistent stores and coordination are operator-provided. Web uses unverified `ua-bypass` by default, no DNS/DoH, no SMTP; trap remains default-off and delay is discouraged on edge, capped at 3000 ms when explicitly enabled. `./hono` stays Node-only; use `./hono-web` for Web hosts. See [edge.md](edge.md).

## Honest claims

| Claim | Status | Evidence |
| --- | --- | --- |
| Isolated HTTP/API decoy routes and inert canaries detect exploratory scanning and credential replay | Shipped | Built-in D1–D5, MCP and GraphQL decoys; canary format and registry; local acceptance tests and demos |
| Default mode is detect-and-alert only; it does not block, throttle, or retaliate unless the operator opts in | Shipped | `mode: 'detect'` default; trap flags default off; [trap-mode.md](trap-mode.md) |
| Replay and decoy observations support early alerting and a response window | Shipped, unreleased; signal confidence varies, response actions are the operator's | Async alerts; timeline and two distinct dwell clocks; optional Node script runner with inert examples, no built-in key rotation/firewall changes; [incident response](incident-response.md) |
| Opt-in trap mode can delay, rate-limit, or block a confirmed client | Shipped, default off | Independent flags, confirmation gates, kill switch, circuit breaker; crawler and allowlist immunity |
| Experimental maze burns the attacker's tokens / traps them in a dead loop | **Not demonstrated** — do not claim this | [v0.3b](bench-v0.3b.md): byte ratio 1:1 (below the 3:1 floor); time ratio is a 25 ms/request model on scripted agents, not real LLM agents |
| "Fake success": the attacker's AI believes it has breached the server and receives a simulated environment | **Planned**, not shipped | Design only, in [deception.md](deception.md); needs safety assessment and separate approval before opt-in implementation |
| Host honeyfiles with optional read alerts | **Shipped in this unreleased v0.5a tree**, with Linux-log caveat | [seed implementation](../src/seed/plan.ts), [safe paths](../src/seed/paths.ts), [watch parser](../src/watch/parser.ts), [operator guide](seed.md): dry-run default; explicit 0600 writes/no overwrite; deterministic inert values, no real vendor formats/prefixes; operator-hosted endpoints only; read-only Linux logs, no direct read sensor, no trap/block on `honeyfile_read` |
| Incident timeline, bounded log, summaries, incident CLI, escalation/reminders and response hooks | **Shipped in this unreleased v0.5a tree**; file log/escalation/hooks are Node-only, opt-in | [incident CLI](../src/cli/incident.ts), [log](../src/log/file.ts), [escalation](../src/incident/escalation.ts), [hooks](../src/hooks/runner.ts), [guide](incident-response.md): first touch/first successful alert/event dwell, no path/UA/IP labels, same-file ack visibility, capped reminders; no shell, fresh five-key env, execution caps, failures isolated from inspect |
| Isolated decoy host, separate from the production application process | **Planned**, not shipped | Programs/templates only are planned; operators deploy; [distribution.md](distribution.md) |
| Edge adapters (Workers, Next.js / Vercel Edge, Deno, Bun, Hono-web) and a Web-standard core | **Implemented, unreleased v0.4b**; state/crawler/transport degradation applies | [Operator guide](edge.md); golden vectors, 63 differentials, Web AC, and local smoke scripts (`smoke:workers`, `smoke:bun`, `smoke:deno`; skipped when a runtime binary is absent) |
| Real-agent token-cost evaluation before anyone should enable the maze | **Planned**, not shipped | No model budget set; required by [exhaust.md](exhaust.md) and [trap-mode.md](trap-mode.md) |
| Blocks attacks / replaces a WAF, patching, or least privilege | **Will not claim** | Out of scope; last-line tripwire only |
| Reverse prompt injection, outbound probing, or use of real credentials | **Will not do** | Charter / non-goals in [roadmap.md](roadmap.md#6-明确不做non-goals延续-charter) |

## Where this is heading

The short list in the README, expanded in [roadmap.md](roadmap.md):

1. Host honeyfiles (`seed` / optional Linux-log `watch`) — shipped, unreleased v0.5a
2. Fake-success environment — planned; safety assessment and separate approval required
3. Response time window / timeline, metrics, incident CLI and optional Node hooks — shipped, unreleased v0.5a
4. Isolated decoy host — planned programs/templates, no deployment by this project
5. Real-agent token-cost evaluation — planned, budget unset; token drain not demonstrated
6. Edge adapters (v0.4b) — implemented, unreleased; future work follows the [v0.5–v0.7 plan](plan-v0.5-v0.7.md)

## Related documents

- [README](../README.md)
- [Roadmap](roadmap.md), [Edge operator guide](edge.md), [Seed and watch](seed.md), [Incident response](incident-response.md)
- [Exhaust](exhaust.md), [Deception](deception.md), [Trap mode](trap-mode.md)
- [Threat model](threat-model.md), [Community](community.md), [Distribution](distribution.md)
