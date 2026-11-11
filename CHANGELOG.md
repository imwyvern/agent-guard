# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed
- 2026-11-10 17:10 (HKT)：范围调整为纯开源研究（不部署）。移除特定站点集成内容；验证改为本地 Express / 原生 http demo + 自动化测试 + 流量模拟 benchmark；MVP 告警仅 webhook(HMAC) + console，Slack/Telegram/飞书/email 改为 future；Fastify/Hono adapter 推迟到 v0.2；仓库提案写入工作默认值（imwyvern/agent-guard、@imwyvern/agent-guard、Apache-2.0、个人账号，pending Dan confirmation）；Codex 合同同步修订。

### Added
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
