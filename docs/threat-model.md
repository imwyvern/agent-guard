# agent-guard 威胁模型（v0.1 草案）

- 日期：2026-11-10（HKT, UTC+8）
- 来源：`/workspace/security/bla-server-anti-ai-assessment-2026-11-10.md`（权威起点）
- 范围：HTTP/API 运行时（Node 中间件优先，Edge 后续）。**不是** WAF、不是 DDoS 防护、不是客户端反逆向（那是 BLA 的本职）。
- 性质：纯开源研究项目，本仓库不部署到任何服务器；验证全部在本地 demo app 上进行。

## 1. 资产（Assets）

| 资产 | 例子（以典型 SaaS 站点为例） | 被打后的后果 |
|---|---|---|
| 用户会话 / 账号 | 登录态、session cookie、JWT | 账号接管 |
| 付费内容 / 题库 | 笔试题、解析、付费状态 | 内容被批量扒取、商业损失 |
| 管理后台 | `/admin`、运营接口 | 横向移动、数据篡改 |
| 内部 API | 未公开的 `/api/*` | 越权调用、成本被刷 |
| 模型 / 提示词配置 | system prompt、模型 key（服务端） | 成本盗用、竞品抄袭 |
| 密钥 / 凭据 | `.env`、云厂商 key、DB 连接串 | 全面失陷 |
| SEO 资产 | 搜索排名、索引质量 | **防御方自伤**：诱饵被收录、正规爬虫被误伤 |

## 2. 攻击者分类（Attacker classes）

| # | 类别 | 典型行为 | 我们的对策（MVP） | 误伤风险 |
|---|---|---|---|---|
| A1 | **自主 LLM Agent**（Cursor/Claude Code/自研 agentic scanner 等，带工具链） | 读 `robots.txt`/`llms.txt`/`.well-known/*`、按语义追 HTML 注释和 OpenAPI、"顺手"试登录假账号 | decoy routes + 注释/响应里的 canary；行为信号打分；**只告警** | 低：真人不会访问 robots-disallowed 且无链接入口的路径 |
| A2 | **脚本化扫描器跟随泄漏凭据** | 从公开仓库/粘贴站/抓到的页面里摘 key，curl 回放 | canary 唯一 ID → 任意位置出现即告警（header/body/query/form） | 极低：canary 只存在于诱饵里 |
| A3 | **Agent 驱动的撞库 / 凭证试探** | 对 `/login`、`/api/auth/*` 批量试，混入从诱饵里拿到的假账号 | 假账号（canary username/password）在登录接口出现 → 告警；不改变真实登录逻辑 | 低 |
| B1 | **良性爬虫**（Googlebot、Bingbot、Applebot、DuckDuckBot 等） | 遵守 robots；偶尔访问未链接路径 | **verified-crawler bypass**：反向 DNS + 正向确认，命中则永不进入任何 decoy/maze；decoy 页带 `noindex` + `X-Robots-Tag` + robots disallow + 不进 sitemap | 设计目标：0 |
| B2 | **AI 训练/检索爬虫**（GPTBot、ClaudeBot、PerplexityBot 等声明身份者） | 抓公开页 | MVP **只记录**（`ua_class=declared_ai_crawler`），不陷害；是否 block 由站点 robots 策略决定，不归 agent-guard | 低 |
| B3 | **监控 / 无障碍 / 自家 Bot** | uptime 探针、屏幕阅读器、自家客服 Bot | allowlist（IP/UA/header token）；无障碍工具不会访问隐藏 decoy | 需 allowlist 配置 |
| C | **真实用户** | 正常浏览、登录、付费 | 默认不触发：decoy 无可见/可点击入口；canary 不会出现在真人可复制的 UI 中（只在注释、诱饵响应里） | 目标 **0 误报** |

## 3. 入口点（Entry points）

1. **AI-discovery 路径**：`/robots.txt`、`/llms.txt`、`/.well-known/mcp.json`、`/.well-known/ai-plugin.json`、`/openapi.json`、`/swagger*`。
2. **经典敏感路径扫描**：`/.env`、`/.git/config`、`/admin`、`/debug`、`/actuator/*`、`/phpinfo.php`。
3. **HTML 内容**：注释、`<meta>`、隐藏元素（A1 会读，真人看不到）。
4. **认证接口**：`/login`、`/api/auth/*`（canary 账号回放）。
5. **任意请求的 header/body/query**：canary token 回放（A2）。
6. 前端 bundle / sourcemap —— **out of scope**，另案评估 BLA。

## 4. 信任边界

- agent-guard 运行在应用进程内，**只读** 请求、**只写** 诱饵响应和日志/告警。
- 诱饵响应与真实业务数据完全隔离：decoy handler 不调用任何业务 service / DB。
- canary 只存在于：agent-guard 配置 + 诱饵响应。**永不** 进入真实 IdP、secret manager、DB 用户表。

## 5. Out-of-scope（MVP 明确不管）

- 国家级/专职人工渗透；经典 CVE 利用（交给 WAF / 补丁）；DDoS / 流量清洗。
- 客户端 bundle 反逆向（BLA 的领域，独立评估）。
- 自动封禁 / 限速 / tarpit（MVP 只告警）。
- 生产环境 reverse prompt injection（对第三方 Agent 下指令、诱其外泄 system prompt）。
- 对任何第三方系统的反击、探测、"hack back"。
- 假 MCP server / 假 LLM API 独立蜜罐机（Phase 2 再议）。

## 6. 主要风险（防御方自伤）

| 风险 | 缓解 |
|---|---|
| 误伤真人 | 诱饵无可见入口；trap 类动作（Phase 2）需双信号 |
| 伤 SEO | noindex + X-Robots-Tag + robots disallow + 不进 sitemap + verified-crawler bypass |
| 误把 canary 当真密钥用 | 固定前缀 + checksum；CI 扫描禁止 canary 前缀进入 secret store |
| 告警风暴 | 同一 (canary_id, src_ip) 去重窗口 + 速率上限 |
| 品牌尴尬 | 假数据不含可识别真人 PII，风格为"内部样例" |
