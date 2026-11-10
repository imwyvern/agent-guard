# agent-guard Roadmap（v0.2 → v0.4）

> 状态：草案，2026-11-11（HKT）。作者：agent-guard 维护者。
> 范围约束不变：**detect + alert only** 为默认；canary 永远 inert；decoy 永远 `noindex`；verified crawler 永远不进 decoy；任何 blocking / budget trap 只能 opt-in 且默认关闭；不做生产环境 reverse prompt injection、不做全站 tarpit、不攻击任何第三方系统；不 fork、不复制其他项目代码（尤其 GPL 的 Beelzebub，只借鉴思路）。

## 1. 现状扫描（Landscape，2026-11）

| 项目 / 机制 | 定位 | 对 agent-guard 的启发 | 我们不做的部分 |
| --- | --- | --- | --- |
| **Sundew**（sundew.sh） | 独立部署的 AI-agent honeypot；persona engine 让每个实例长得不一样；MCP traps、REST traps；五类行为信号（timing、path enumeration、header、prompt leakage、MCP behavior chain） | ① per-deployment 随机化（anti-fingerprinting）；② session 级行为评分；③ 通过 `robots.txt` / `ai-plugin.json` / OpenAPI / MCP 广告吸引 agent | 我们是**嵌入真实站点的 middleware**，不是独立蜜罐主机；不用 LLM 生成内容 |
| **Beelzebub**（GPL-3.0） | Go 写的通用 deception 框架，SSH/HTTP/TCP/MCP，可接 LLM 动态回复 | MCP decoy tool 的思路（"高权限看起来很香的工具"） | **零代码复用**（Apache-2.0 与 GPL 不兼容）；不做 LLM 动态交互 |
| **Oubliette Trap** | honeypot MCP server，15+ honey tools 组成相互引用的假环境；STIX 2.1 / CEF 导出 | ① decoy 之间的 shared state 抗指纹；② 结构化威胁情报导出格式 | 不做 active probe 型 instruction trap |
| **Drosera** | 用"理解力"判断 LLM agency：页面里放一段只有 LLM 会读懂并执行的说明，HMAC 签名 ticket；把 automation / LLM agency / hostility 三轴分开 | ① **三轴分离**：行为信号最多判到 `automation`，不能单靠流量形状判 `agent`；② lure 文本过 guardrail，只能让 agent "做更少" | 不在生产做 reverse prompt injection；我们的 lure 只放 inert 文本 |
| **Snare**（snare.sh, Apache-2.0） | 在开发机上放 inert 凭据（awsproc、ssh、kubeconfig、npm scope…），"use-based" 检测：只在凭据被**使用**时报警 | **use > read** 的高精度原则，与我们 canary replay 一致；分 precision tier | 不碰客户端/开发机，只做服务端 |
| **agent-canary / decoy-tripwire / mcp-canary / Agent Tripwire** | 面向 agent runtime 的 tripwire：decoy MCP tools、honeytoken 写进 tool description、per-run marker | ① `P(touch(C) | compliant) ≈ 0` 作为 canary 设计判据；② benign trip rate、time-to-trip 等指标；③ MCP decoy tool 返回 "plausible permission error" | 我们只做 HTTP 侧，不做 agent-side broker / fail-closed |
| **Cloudflare AI Labyrinth** | 对不守 no-crawl 的 crawler 注入隐形 `nofollow` 链接，进入 AI 生成的迷宫；只记录不拦截 | 隐形链接 + `nofollow` + `noindex` + "Served vs Crawls" 比率指标 | **不做无限迷宫 / 全站 tarpit**；最多 opt-in 的有限深度 maze |
| **Web Bot Auth**（IETF `webbotauth` WG，`draft-ietf-webbotauth-httpsig-protocol-01`，基于 RFC 9421 HTTP Message Signatures） | agent 用 Ed25519 对 `@authority` 等组件签名；`Signature-Agent` 指向 `/.well-known/http-message-signatures-directory` JWKS；`tag="web-bot-auth"` | 可以**正向验证**自报身份的 agent，比 UA + rDNS 更强；verified agent 同样不进 decoy | 注意：新草案 `Signature-Agent` 是 Dictionary，Cloudflare 生产仍是旧 bare-string 形式，两者都要兼容 |
| **robots.txt / AIPREF / ai.txt / llms.txt** | IETF AIPREF：`Content-Usage` 写进 robots.txt 和 HTTP header（`train-ai=n` 等）；`/.well-known/ai.txt`、`llms.txt` 为社区约定 | decoy 路径在 robots.txt `Disallow` → 守规矩的 crawler 永远不会碰；可选输出 `Content-Usage` header；`llms.txt` 是新的 agent 入口（可作为 opt-in lure 位置，但 lure 必须 inert） | 偏好不是强制，不把"违反偏好"本身当攻击 |
| **MCP / LLM tool endpoint 攻击面**（OWASP MCP Top 10、OWASP MCP Cheat Sheet） | tool poisoning、rug pull、tool shadowing、confused deputy、token 泄露（MCP01）、缺审计（MCP08）、shadow MCP server（MCP09） | 暴露在 HTTP 上的 MCP（Streamable HTTP, JSON-RPC）同样会被扫描：`/mcp`、`/sse`、`tools/list`、`tools/call` 枚举；decoy tool 被调用 = 高置信信号 | decoy tool description **不能含 imperative / 隐藏字符**（否则我们自己就成了 tool poisoning）；不回传诱导文本 |

**定位总结**：其他项目大多是"独立蜜罐"或"agent 侧 tripwire"。agent-guard 的差异点是 **嵌入任何 Node/Edge 应用的零依赖 middleware**，强调 **零误报（verified crawler / 真人 bypass）+ inert canary + 可观测**，而不是诱捕和对抗。

## 2. 优先级原则

1. **先加固自身，再扩面**：middleware 跑在每个请求的 hot path 上，它自己的 bug（ReDoS、header injection、内存无界）比漏报更致命。
2. **Web-standard core 优先**：把 core 收敛到 `Request`/`Response` + WebCrypto，可一次性覆盖 Hono / Workers / Vercel Edge / Deno / Bun。
3. **高精度信号优先于启发式**：canary replay、decoy hit、Web Bot Auth 验签是确定性信号；行为评分只作为辅助、且永远不单独判定 `agent`。
4. **每项都有可自动化的验收**，进 CI。

## 3. v0.2 —— 加固 + 仓库卫生 + 第二个 runtime（本轮实施）

| # | 项目 | Rationale | Risk | Acceptance criteria |
| --- | --- | --- | --- | --- |
| 2.1 | **Timing-safe compare** 覆盖所有 HMAC / canary checksum / webhook signature 比较 | 防 timing oracle 伪造 canary 或 webhook 签名 | 长度不等时的处理泄露长度 → 先比长度再 `timingSafeEqual` | 全部比较点走统一 helper；单测覆盖等长/不等长/空 |
| 2.2 | **Input size caps**（URL、header 数/字节、body 扫描字节、canary 候选数、query 参数数） | 防资源耗尽；攻击者可以故意发巨大请求 | cap 太小会漏报 → 默认值宽松且可配置，超限计 metric | 超限请求不 throw、不阻断、耗时有上界；README "Limits" 列出默认值 |
| 2.3 | **ReDoS audit** | UA / path / canary 正则全在 hot path | 改写正则改变匹配语义 → 回归测试 | `docs/security-review.md` 列出每个 RegExp 的风险与处理；100k 字符对抗输入 < 50 ms |
| 2.4 | **Header / log injection 安全** | path、UA、canary id 会进日志、告警和响应头 | 过度清洗影响取证 → 只去控制字符 + 截断，原值长度记录 | CR/LF/控制字符被剥离；单测 |
| 2.5 | **Property / fuzz tests**（canary parser、request inspector、sanitizer） | 覆盖手写用例想不到的输入 | 测试时间变长 → 固定 seed、限制迭代数 | 永不 throw、round-trip、篡改必拒、时间有上界 |
| 2.6 | **Repo hygiene**：`SECURITY.md`、`CONTRIBUTING.md`、issue/PR templates、GitHub Actions CI（build/lint/test，Node 20/22）、CodeQL、Dependabot（npm + actions） | 公开仓库的基本盘；OpenSSF Scorecard 的前置条件 | Actions 权限过大 → `permissions: contents: read`，actions 固定 SHA | main 上 CI 绿；CodeQL 有结果；Dependabot 配置生效 |
| 2.7 | **Hono adapter**（Node 上验证，`@imwyvern/agent-guard/hono`） | Hono 基于 Web 标准，是走向 Workers / Bun / Deno 的跳板 | core 仍依赖 `node:crypto` → v0.2 先限定 Node runtime，v0.3 再做 WebCrypto core | AC 主要用例（真人不触发、curl replay 必告警、Googlebot 不进 decoy）在 Hono 上通过 |
| 2.8 | **MCP / LLM tool endpoint decoy 示例** | MCP over HTTP 是 2026 年 agent 扫描的新热点 | decoy tool description 自身成为 tool poisoning → description 必须是中性描述、无 imperative、无隐藏字符，并有测试守护 | 示例 app 暴露一个 JSON-RPC `/mcp`：`tools/list` 含 decoy tool，调用即告警，返回 plausible permission error；canary inert；verified crawler 不进入 |
| 2.9 | **AC-10 测量修正** | autocannon 只给整数毫秒 percentile，p50 ≤ 0.2 ms 的门槛无法被它判定 | 换测量方法可能被视为"放水" → 原 autocannon 数据照常记录，新方法另列，诚实写清 | 新增 `process.hrtime.bigint()` 级别的高分辨率测量（in-process 和 loopback 两种），报告 µs 级 p50/p99 增量并写入 `docs/bench-v0.2.md` |

## 4. v0.3 —— 多 runtime + 多场景 + 深度检测

### 4.1 Runtimes
| 项目 | Rationale | Risk | Acceptance |
| --- | --- | --- | --- |
| **Web-standard core**（`Request`→decision，WebCrypto HMAC，无 `node:*` import） | 一份 core 跑所有 edge runtime | WebCrypto 是 async，hot path 变 async → 只在 canary 候选出现时才算 HMAC | core bundle 在 `--platform=neutral` 下构建成功、无 `node:` import |
| **Fastify plugin**、**Koa middleware** | Node 主流框架 | 各自生命周期（`onRequest` vs body 解析顺序） | 每个 adapter 跑通共享 AC 套件 |
| **Next.js middleware**、**Vercel Edge**、**Cloudflare Workers** | 大量站点在 edge | edge 无持久内存 → 状态需外置（KV / Durable Object）或降级为无状态 | Miniflare / `next dev` 下 AC 通过；无状态模式下文档说明哪些信号失效 |
| **Deno / Bun** | 覆盖新 runtime | 测试矩阵膨胀 | CI matrix 中有 smoke test |

### 4.2 Scenarios
| 场景 | 设计要点 | Acceptance |
| --- | --- | --- |
| **API-only backend** | 无 HTML lure；canary 放在 OpenAPI `example`、错误响应的 `docs_url`、假 `/.well-known/` 文件 | 示例 + AC：JSON 客户端不误报 |
| **MCP server / LLM tool endpoint**（v0.2 示例升级为一等公民 `mcpDecoys()`） | 支持 Streamable HTTP JSON-RPC；decoy tool 只返回 permission error；description 经 lint（无 imperative / 无 U+200B–200F, U+202A–202E, U+2060, U+FEFF） | tool-description linter 有测试；`tools/call` decoy 必告警 |
| **GraphQL** | decoy field / type（如 `internalAdminUsers`）只在 introspection 里出现，查询即告警；不影响真实 schema | introspection 正常；查询 decoy field 告警；不改变真实 resolver |
| **SPA + auth API** | canary 放在 source map / 构建产物注释中的 inert 假 key，`/api/auth` 旁的 decoy 路由 | Lighthouse 无回归；真人登录流程零告警 |
| **Docs site** | `llms.txt` / docs 页面里的 opt-in inert canary；decoy 页 `noindex` | 搜索引擎 crawler 零进入；`llms.txt` lure 默认关 |

### 4.3 Deeper detection
| 项目 | Rationale | Risk | Acceptance |
| --- | --- | --- | --- |
| **Per-session correlation**：同一 `client_key` 的 decoy-hit 序列（robots → `.env` → admin API）合成一个 incident | 单点 hit 有噪声，序列才是 agent 的典型 kill chain | client_key 在 NAT / 代理下合并多人 → incident 只升级置信度，不阻断 | incident 事件 schema；序列模拟测试 |
| **Canary propagation tracing**：每个 canary 绑定 placement（哪个页面/文件/字段），replay 时报告"在 A 处泄露、在 B 处被回放、间隔多久、跨了几个 client_key" | 回答"agent 从哪里拿到的" | registry 体积增长 → placement 有上限 | 告警含 `leaked_at` / `replayed_at` / `dwell_ms` |
| **Header/TLS-agnostic behavioral signals**：请求间隔规律性、无静态资源加载、跳过 robots 直接 decoy、HEAD/OPTIONS 枚举 | 不依赖易伪造的 UA，也不依赖 TLS 指纹（middleware 拿不到） | 误伤自动化测试/监控 → 只输出 `automation` 轴分数，永不单独判 `agent`（借鉴 Drosera 三轴） | 真人 / 爬虫模拟流量误报 0 |
| **Web Bot Auth verification** | 正向验证自报身份 agent；verified agent 同 verified crawler 一样 bypass decoy | 草案在演进（Dictionary vs bare string）；key directory 抓取本身是 SSRF 面 → 目录 URL 只允许 https、allowlist、超时、缓存、大小上限 | RFC 9421 测试向量通过；两种 `Signature-Agent` 形式都能解析；过期/篡改签名拒绝 |
| **Prompt-injection-safe canary placement**（HTML / JSON / OpenAPI） | canary 文本可能被 agent 读进上下文 → 文本必须是数据，不是指令 | 自己变成 injection 源 → placement linter：禁止 imperative、禁止隐藏字符、禁止 URL 外呼诱导 | linter 测试 + 文档；所有内置 lure 通过 lint |

## 5. v0.4 —— 可观测 + 供应链 + 社区

| 项目 | Rationale | Risk | Acceptance |
| --- | --- | --- | --- |
| **OpenTelemetry**（span event + attributes，可选 peer） | 接入现有 tracing | 引入依赖 → 仅 optional peer，core 零依赖 | 示例里在 OTel collector 看到 `agent_guard.decoy_hit` |
| **Prometheus metrics**（`/metrics` 文本格式导出器，不默认挂载） | 运维习惯 | 指标泄露 decoy 路径 → 默认不暴露路径 label | 格式通过 promtool check |
| **Structured log sinks**：JSONL、syslog、CEF / STIX 2.1 导出（借鉴 Oubliette 的思路，自写） | SOC 集成 | 字段膨胀 → 遵守现有 event schema 版本化 | schema 测试；CLI `report` 支持导出 |
| **Supply chain**：npm provenance、CycloneDX SBOM、signed tags、OpenSSF Scorecard workflow | 安全工具自身必须可信 | 需要 Dan 批准 npm publish 才有意义 | Scorecard ≥ 7；SBOM 随 release 附带 |
| **Opt-in 有限 maze / budget trap** | 对已确认的 decoy 命中者消耗其预算（借鉴 AI Labyrinth，但**有限深度、默认关、noindex、verified crawler 不进**） | 法律/道德与 SEO 风险 → 默认关、深度上限、只对已命中 canary 的 session | 默认配置下完全不生效；开启后 Googlebot 模拟零进入 |
| **Community**：docs site（静态站，GitHub Pages）、贡献指南扩展、good-first-issue 标签、威胁模型公开讨论 | 长期维护 | 维护负担 | docs site 构建进 CI |

## 6. 明确不做（Non-goals，延续 charter）

- 不 fork BLA，不复制任何第三方代码（Beelzebub GPL 尤其不碰）。
- 不在生产做 reverse prompt injection；不做全站 tarpit；不对任何第三方发起探测、反制或利用。
- canary 不可被用于真实认证；decoy 不返回真实数据；verified crawler / verified agent 永不进入 decoy。
- 默认 alert-only。

## 7. 参考

- Sundew: https://sundew.sh/ · Oubliette: https://github.com/oubliettesecurity/oubliette-trap · Drosera: https://droseraproject.org/ · Snare: https://snare.sh/
- Beelzebub（GPL-3.0，仅参考思路）: https://github.com/mariocandela/beelzebub
- Agent Tripwire: https://8759s.github.io/research-posts/agent-tripwire/ · agent-canary: https://github.com/SamsonCyber/agent-canary
- Cloudflare AI Labyrinth: https://developers.cloudflare.com/bots/additional-configurations/ai-labyrinth/
- Web Bot Auth: https://datatracker.ietf.org/doc/html/draft-ietf-webbotauth-httpsig-protocol-01 · https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/ · RFC 9421
- IETF AIPREF: https://datatracker.ietf.org/doc/html/draft-ietf-aipref-attach
- OWASP MCP Top 10: https://owasp.org/projects/mcp-top-10 · OWASP MCP Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html
