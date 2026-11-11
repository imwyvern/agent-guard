# 仓库方案（PROPOSAL，待 Dan 批准）

- 日期：2026-11-10（HKT）
- **状态：仅提案。未创建任何 GitHub 仓库、未 push、未 npm publish。** 本地仓库 `/workspace/agent-guard` 无 remote。
- 性质：纯开源研究项目，不部署到任何服务器。

## 0. 工作默认值（pending Dan confirmation）

| 项 | 工作默认值 | 状态 |
|---|---|---|
| GitHub 仓库 | `imwyvern/agent-guard` | pending Dan confirmation |
| npm 包名 | `@imwyvern/agent-guard` | pending Dan confirmation |
| 许可证 | Apache-2.0（+ NOTICE + DCO） | pending Dan confirmation |
| 账号 | `imwyvern` 个人账号（暂不建 org） | pending Dan confirmation |

代码与文档已按以上默认值编写；若 Dan 改选，需要同步修改 package.json、README、LICENSE。
- 可用性检查时间：2026-11-10 ~16:57 HKT，通过 npm registry 与 GitHub 公共 API（结果会变，发布前需复查）。

## 1. 名称

### 1.1 可用性检查结果

| 候选 | npm | GitHub | 备注 |
|---|---|---|---|
| `agent-guard`（unscoped） | ❌ 已占用（v1.2.2，MIT，"AI cost protection / budget auto-kill"，最后更新 2025-07） | `imwyvern/agent-guard` ✅ 可用；但 GitHub 用户/组织 `Agent-Guard`、`agentguard`、`agentguard-dev` 均已存在 | 名字很拥挤：GitHub 名含 agent-guard 的仓库 ~3.4k，含 OWASP agent-memory-guard、WhitzardAgent/AgentGuard 等安全项目 |
| `agentguard` | ✅ 未占用 | org 已被占 | 与上面一堆 "AgentGuard" 品牌易混 |
| `@imwyvern/agent-guard` | ✅ 未占用（个人 scope，天然可用） | — | **推荐的 npm 包名** |
| `agentguard-http` | ✅ | — | 备选 |
| `agent-tripwire` | ❌ 已占用（"plant decoy secrets … when Cursor or Claude Code read them"）| — | ⚠️ **概念最接近的现存 npm 包**，README 里应说明差异（它防本地编码 Agent 读文件；我们防 HTTP 层入侵） |
| `agentsnare` | ✅ | ✅ | 与 `peg/snare`（Apache-2.0，同类 canary 项目）太像，不推荐 |
| `canarytrail` | ✅ | ✅（用户名也未占） | 独特、好搜索；缺点是不体现 "agent" |
| `decoynet` | ✅ | ✅ | 备选 |

### 1.2 推荐

- **GitHub：`imwyvern/agent-guard`**（与内部代号一致，文档已全部用此名）。
- **npm：`@imwyvern/agent-guard`**（unscoped 已被占，且 scoped 包对个人维护最省事）。
- README 首行明确定位"HTTP runtime deception & canary middleware for AI-agent intrusion"，用副标题区分同名项目。
- 若 Dan 希望更强辨识度：改名 `canarytrail`（npm/GitHub 均可用）。**需要在首次公开前定，之后改名成本高。**

## 2. 组织（Org）

| 选项 | 优点 | 缺点 |
|---|---|---|
| **A. `imwyvern` 个人账号（推荐）** | 零成本，立即可用；早期项目个人背书更真实；npm scope 已有 | 将来要转组织时需 transfer（GitHub 会自动重定向，npm 需发新 scope 并 deprecate 旧包） |
| B. 新建 org（如 `agent-guard-dev`、`canarytrail`） | 品牌独立、便于多人协作 | 现在没有协作者，空 org 显得单薄；需要先确认 org 名和 npm org 名都能拿到（`agent-guard`/`agentguard` 已被占） |

推荐 A；Stars > ~200 或有外部 maintainer 时再迁 org。

## 3. 许可证

### 3.1 参考项目许可（2026-11-10 GitHub API 查得）

| 项目 | 许可 | 与我们的关系 |
|---|---|---|
| BLA `qybaihe/bla` | MIT | 只借 Poison/Exhaust/Canary 概念 |
| Beelzebub `beelzebub-labs/beelzebub`（原 mariocandela/beelzebub；评估中写的 `zgsec/beelzebub` 现 404） | **GPL-3.0** | **严禁复制代码**，只借 Agent 评分思路 |
| Sundew `sundew-sh/sundew` | Apache-2.0 | 概念参考（persona、MCP 陷阱、行为指纹） |
| Drosera `rod-trent/Drosera` | Apache-2.0 | 概念参考（Lure/Detect/Trap/Canary 分层） |
| Snare `peg/snare` | Apache-2.0 | 概念参考（标准凭据位埋 inert 假 key） |
| Oubliette `oubliettesecurity/oubliette-trap` | Apache-2.0（LICENSE 文件；GitHub 显示 NOASSERTION） | 概念参考（假 MCP、指纹、STIX 导出） |

我们不复制任何代码，所以任何许可都不受传染；仍在 README 的 "Prior art" 一节致谢并链接。

### 3.2 推荐：**Apache-2.0**

| | MIT | Apache-2.0 |
|---|---|---|
| 简洁度 | 最简 | 较长 |
| 专利授权/报复条款 | 无 | **有**（安全/检测类技术容易有专利风险，对使用方和贡献者都更安心） |
| 企业采用 | 都友好 | 都友好，部分大厂法务更偏好 Apache |
| 与同类生态一致性 | 同 BLA | 同 Sundew/Drosera/Snare/Oubliette |
| 贡献者 | 需另设 DCO | 自带贡献条款（§5），再加 DCO sign-off 即可 |

结论：Apache-2.0（+ `NOTICE` 文件 + DCO）。若 Dan 更看重"最短最随意"，MIT 也完全可行。

## 4. README 定位

- **一句话**：*Lightweight HTTP/API runtime middleware that plants decoy routes and inert canary credentials, and alerts when autonomous AI agents or scanners take the bait.*
- 中文：给 Node / Edge 服务加一层"诱饵 + 金丝雀"，AI Agent 或脚本跟着假凭据走就告警；默认只告警、不封禁、不伤 SEO。
- **通用中间件**：Express / 原生 Node 先行，Fastify / Hono 其次，Cloudflare Workers / Vercel Edge 随后。不绑定任何具体站点；仓库自带 Express 与原生 http demo 作为参考集成。
- **What it is NOT**：不是 WAF、不是 bot 管理、不是客户端反逆向（那是 BLA）、不做 hack-back / reverse prompt injection。
- **Prior art** 一节：BLA、Sundew、Beelzebub、Drosera、Snare、Oubliette、agent-tripwire，说明差异（我们 = HTTP 运行时 + 零依赖 + SEO 安全默认值）。

## 5. 目录结构（v0.1）

```
agent-guard/
├─ src/{core,canary,decoys,lures,crawler,alerts,log,adapters,cli}/
├─ schema/event.v1.json
├─ test/{unit,integration,acceptance,fixtures,bench}/
├─ examples/{express-basic,fastify-basic,hono-basic}/
├─ docs/{threat-model,kpi,design,codex-contract,repo-proposal}.md
├─ README.md  CHANGELOG.md  LICENSE  NOTICE  SECURITY.md  CONTRIBUTING.md
└─ package.json  tsconfig.json  tsup.config.ts  vitest.config.ts
```

详见 `codex-contract.md` §2。

## 6. v0.1 范围

**包含**：detect 模式；5 条诱饵路由（D1–D5）；canonical canary（生成/校验/registry/CLI scan）；verified-crawler bypass；robots/HTML 注释 lure；webhook（HMAC）+ console 告警（Slack/Telegram/飞书/email 为 future adapters）；结构化 JSON 日志 + schema；metrics；`report` CLI；Express + 原生 Node http adapter；Express / node-http demo；模拟 benchmark；AC-1…AC-15。

**不包含**（≥ v0.2）：Slack/Telegram/飞书/email adapter；Fastify/Hono adapter；trap/budget trap/maze；Edge adapter；shaped canary 默认开启；分布式状态（Redis）；假 MCP 端点；STIX/SIEM 导出；dashboard。

## 7. 首次公开 push 检查清单（需 Dan 逐项确认）

- [ ] Dan 批准：仓库名、org、npm 包名、许可证
- [ ] 复查名称可用性（npm + GitHub），必要时预留 npm 包（发 `0.0.0` 占位需 Dan 同意）
- [ ] `git log -p` 全量扫描：无真实密钥、无真实 canary secret、无任何真实站点的内部域名/IP/路径/人员信息
- [ ] `agent-guard canary scan .` 只命中白名单（示例 registry、测试 fixture）
- [ ] 跑一次 secret 扫描（gitleaks / trufflehog，本地运行）
- [ ] examples / fixtures 里的 canary 是演示专用，与任何真实部署的 canary 不同
- [ ] LICENSE + NOTICE + SECURITY.md（漏洞报告邮箱由 Dan 定）+ CONTRIBUTING（DCO）
- [ ] README 含 "What it is NOT"、Prior art、负责任使用声明（只用于自有系统）
- [ ] CI 绿；`npm pack --dry-run` 内容正确
- [ ] 设置：默认分支保护、启用 private vulnerability reporting、关闭 wiki
- [ ] 决定首发是 public repo 还是先 private → public
- [ ] Dan 明确说"可以 push"后才执行
