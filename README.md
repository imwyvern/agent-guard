# agent-guard

> 🚧 Pre-alpha 开源研究项目，不部署到任何服务器。工作默认值：GitHub `imwyvern/agent-guard`、npm `@imwyvern/agent-guard`、Apache-2.0（pending Dan confirmation，见 `docs/repo-proposal.md`）。

**Lightweight HTTP/API runtime middleware that plants decoy routes and inert canary credentials, and alerts when autonomous AI agents or scanners take the bait.**

给 Node 服务加一层"诱饵 + 金丝雀"：AI Agent 或脚本跟着假凭据走，就告警。默认 **只告警、不封禁、不伤 SEO**。

## 特性（v0.1）

- 5 条只读诱饵路由（假 `/.env`、假内部 admin API、假运维笔记、假 OpenAPI、假内部登录），全部 `noindex` + `X-Robots-Tag`
- 项目级 inert canary：`AG-CANARY-<id>-<checksum>`（前缀可配置）
- Verified-crawler bypass：rDNS + 正向确认，Googlebot/Bingbot 永远进不了诱饵
- 告警：webhook（HMAC 签名）+ console；Slack / Telegram / 飞书 / email 为 future adapters
- 结构化 JSON 日志；零运行时依赖
- Adapter：Express、原生 Node `http`（Fastify / Hono / Edge 后续）

## 本地验证

Express demo、原生 http demo、自动化测试、流量模拟 benchmark（真人 / verified & spoofed 爬虫 / curl 回放 canary / LLM-agent 探测）。详见 [KPI](docs/kpi.md)。

## What it is NOT

不是 WAF、不是 bot 管理、不是客户端反逆向（见 [BLA](https://github.com/qybaihe/bla)）、不做 hack-back 或 reverse prompt injection。

## 文档

- [威胁模型](docs/threat-model.md) · [KPI](docs/kpi.md) · [设计](docs/design.md) · [Codex 实现合同](docs/codex-contract.md) · [仓库提案](docs/repo-proposal.md)

## Prior art

BLA、Sundew、Beelzebub、Drosera、Snare、Oubliette、agent-tripwire —— 借鉴概念，不复用代码。
