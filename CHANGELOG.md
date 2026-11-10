# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed
- 2026-11-10 17:10 (HKT)：范围调整为纯开源研究（不部署）。移除特定站点集成内容；验证改为本地 Express / 原生 http demo + 自动化测试 + 流量模拟 benchmark；MVP 告警仅 webhook(HMAC) + console，Slack/Telegram/飞书/email 改为 future；Fastify/Hono adapter 推迟到 v0.2；仓库提案写入工作默认值（imwyvern/agent-guard、@imwyvern/agent-guard、Apache-2.0、个人账号，pending Dan confirmation）；Codex 合同同步修订。

### Added
- Implemented v0.1 detect-only core, five inert decoys, canonical HMAC canaries and registry/CI scanner, crawler identity verification/cache, bounded state/metrics, signed asynchronous webhook and console alerts, and Express/native HTTP adapters.
- Added shared local demos, AC-1–AC-15 for each adapter, unit/integration/coverage gates, S1–S5 simulation and latency/Lighthouse runners, JSON event schema, CLI report, Apache-2.0 LICENSE and NOTICE.
- Added benchmark and implementation reports documenting this sandbox's denied loopback sockets and Chrome startup, with TCP latency partial and Lighthouse skipped.

- 2026-11-10 (HKT)：初始规格文档（P0，尚无代码）
  - `docs/threat-model.md`：攻击者分类、资产、入口点、out-of-scope
  - `docs/kpi.md`：KPI 与验证方法
  - `docs/design.md`：MVP（detect + canary）、5 条诱饵路由、canary 格式、verified-crawler bypass、日志 schema、告警通道、配置面、adapter、非目标
  - `docs/codex-contract.md`：Codex v0.1 实现合同与验收用例 AC-1…AC-15
  - `docs/repo-proposal.md`：仓库名/org/许可证/README 定位/v0.1 范围提案（待批准）
