# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed
- 2026-11-11 (HKT)，v0.4a（unreleased）：同步 README 与五语译本的「What it is NOT」、路线图、设计、威胁模型与社区说明；补全 trap 操作指南及 Exhaust 状态，区分已实现的 opt-in 能力、实验性迷宫和仍不做的功能。默认仍为 `mode: 'detect'`，trap 各项开关默认关闭；Edge / Web-standard core 留待 v0.4b。
- 2026-11-10 17:10 (HKT)：范围调整为纯开源研究（不部署）。移除特定站点集成内容；验证改为本地 Express / 原生 http demo + 自动化测试 + 流量模拟 benchmark；MVP 告警仅 webhook(HMAC) + console，Slack/Telegram/飞书/email 当时改为 future（已由 v0.4a 的 opt-in adapters 取代）；Fastify/Hono adapter 当时推迟（Hono 已于 v0.2 完成；Fastify/Koa 已于 v0.3a / unreleased 完成）；仓库提案写入工作默认值（imwyvern/agent-guard、@imwyvern/agent-guard、Apache-2.0、个人账号，pending Dan confirmation）；Codex 合同同步修订。

### Added
- 2026-11-11 (HKT)，v0.4a（unreleased）：Slack、Telegram、飞书和 SMTP/email 告警 adapters，全部显式 opt-in，零新增运行时依赖；沿用有界异步投递、去重、限流和关闭刷新。
- 2026-11-11 (HKT)，v0.4a（unreleased）：`guard.prometheusText()` / `prometheusHandler(guard)` 文本导出器，不默认挂载、无路径 label；机械节奏 `automation_score` 只作观测，不提升严重级别，不单独触发 block / maze。
- 2026-11-11 (HKT)，v0.4a（unreleased）：opt-in `mode: 'trap'`，独立的 delay / rateLimit / block 开关，确认闸门、TTL/LRU、运行时关闭开关和自保断路器；verified crawler / allowlist 永不被 trap。
- 2026-11-11 (HKT)，v0.4a（unreleased）：实验性有界 maze、自托管 callback canary 与显式挂载的 `callbackHandler`，以及可选的精确 lint 主机放行。guard 不主动请求 callback URL，不使用第三方 honeytoken 服务；v0.3b 字节比 1:1，迷宫须经运营者自己的真实 agent 测量后再考虑启用。
- v0.3a (unreleased): Fastify (`./fastify`) and Koa (`./koa`) adapters with optional peers, body-parser ordering, native crawler 404s, opt-in lure transforms, shared acceptance coverage, and `demo:fastify` / `demo:koa`.
- GraphQL schema metadata and bounded request inspection helpers, inert `FORBIDDEN` responses, additive `GQL` decoy schema/metrics, and `demo:graphql`; real resolvers and queries retain host behavior.
- Optional `incident` fields on existing events: configurable fixed 15-minute correlation, ordered recent 32-step sequence, stable incident ID/timestamps, monotonic low/medium/high confidence, and compact 50k-client LRU state with a ≤10,000,000-byte memory test. No new event enum or enforcement behavior.
- Optional canary propagation fields (`leaked_at`, `replayed_at`, `dwell_ms`, `client_keys_seen`), first-body-delivery tracking in a process-local 50k-record / 24h LRU, and distinct replaying client counts capped at 8. Unknown issuance after restart/eviction omits dwell time; existing canary provenance remains intact.
- Placement safety linter and `agent-guard lint <path>` CLI, shared deception benchmark rules, API-only placement/false-positive guide, and synchronized English/five-language README, community adapter guide, and roadmap completion status. At v0.3a, Edge runtimes and Exhaust/trap remained roadmap work and `mode` accepted only `detect` (trap superseded by v0.4a; Edge remains v0.4b work).
- Community guide, RFC and good-first-issue templates, and a Contributor Covenant 2.1 code of conduct that points to the existing SECURITY.md reporting channel; README tagline, Why section, and what-it-is / is-not pointer, synced to all five translations (2026-11-11, HKT).
- Local `bench:exhaust-sim` and `bench:deception-lint` commands for the v0.3b bounded-maze cost simulation, deterministic persona prototype and deception safety scan; offline evaluation only, with no runtime change.
- Docs: multilingual README (zh-CN, zh-TW, ja, ko, es)
- µs-resolution AC-10 latency runner (`bench:latency:hr`): isolated keep-alive clients/servers, interleaved 100/10-connection measurements, core inspect ns/op, raw JSON and Chinese v0.2 report; unchanged latency/memory thresholds and preserved autocannon secondary results.
- Hono middleware subpath (`@imwyvern/agent-guard/hono`) for Node ≥20, optional Hono peer, bounded cloned-body scanning, shared catalog demo (`demo:hono`) and the full Express/Node acceptance matrix on Hono.
- Minimal JSON-RPC MCP HTTP demo (`demo:mcp`) with harmless real tools and a neutral decoy tool, reusable MCP inspection/description-lint helpers, existing alert/canary/crawler pipeline integration, `MCP` decoy id in the v1 event schema and metrics, and Chinese scenario/safety documentation.
- Implemented v0.1 detect-only core, five inert decoys, canonical HMAC canaries and registry/CI scanner, crawler identity verification/cache, bounded state/metrics, signed asynchronous webhook and console alerts, and Express/native HTTP adapters.
- Added shared local demos, AC-1–AC-15 for each adapter, unit/integration/coverage gates, S1–S5 simulation and latency/Lighthouse runners, JSON event schema, CLI report, Apache-2.0 LICENSE and NOTICE.
- Added benchmark and implementation reports documenting this sandbox's denied loopback sockets and Chrome startup, with TCP latency partial and Lighthouse skipped.

- 2026-11-10 (HKT)：初始规格文档（P0，尚无代码）
  - `docs/threat-model.md`：攻击者分类、资产、入口点、out-of-scope
  - `docs/kpi.md`：KPI 与验证方法
  - `docs/design.md`：MVP（detect + canary）、5 条诱饵路由、canary 格式、verified-crawler bypass、日志 schema、告警通道、配置面、adapter、非目标
  - `docs/codex-contract.md`：Codex v0.1 实现合同与验收用例 AC-1…AC-15
  - `docs/repo-proposal.md`：仓库名/org/许可证/README 定位/v0.1 范围提案（待批准）
