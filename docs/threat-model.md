# agent-guard 威胁模型（MVP 背景与 v0.5c 边界）

- 日期：初稿 2026-11-10；v0.5c unreleased 更新 2026-11-23（HKT, UTC+8）
- 来源：`/workspace/security/bla-server-anti-ai-assessment-2026-11-10.md`（权威起点）
- 范围：HTTP/API 运行时（Node 与 Web / Edge）及 v0.5a 可选主机 honeyfiles；读取告警仅解析运营者提供的 Linux auditd/inotifywait 日志，guard 不能自行看见读取。v0.5c 另增默认关闭的 Web Bot Auth 与 Workers 本地源码模板，仍为 unreleased 代码树，未发 npm、未打 tag、无 Worker 部署或发布。**不是** WAF、不是 DDoS 防护、不是客户端反逆向（那是 BLA 的本职）。
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

- agent-guard 运行在应用进程内，**只读** 请求；detect 默认只写诱饵响应和日志/告警。v0.4a 显式 trap 可增加诱饵延迟/429、maze 响应及同一 client key 的 403（包括真实路由），不调用业务服务。
- 诱饵响应与真实业务数据完全隔离：decoy handler 不调用任何业务 service / DB。
- canary 只存在于：agent-guard 配置/registry、诱饵响应与运营者显式生成的 inert honeyfiles。**永不** 进入真实 IdP、secret manager、DB 用户表。

## 5. Out-of-scope 与 v0.4a 显式 opt-in 边界

- 国家级/专职人工渗透；经典 CVE 利用（交给 WAF / 补丁）；DDoS / 流量清洗。
- 客户端 bundle 反逆向（BLA 的领域，独立评估）。
- 默认仍为 MVP 的 detect + alert only。v0.4a 已实现独立 opt-in 的 trap delay / rateLimit / block 与实验性有界 maze；全站 tarpit、无限迷宫和通用 bot 阻断仍不做。
- E4 reverse prompt injection / counter-injection 永不进入产品（对第三方 Agent 下指令、诱其外泄 system prompt）。
- 对任何第三方系统的反击、出站探测、主动回连或 "hack back"。运营者配置的告警 adapters 是唯一出站通知例外，Node 的爬虫 DNS 身份验证不变；Web 无 DNS / DoH，使用 `ua-bypass` 或 `custom`。
- 真实厂商凭证与第三方 honeytoken 服务（Canarytokens 等）。自托管 callback 只接收入站：`canary.callback.baseUrl` 要求 HTTPS（显式 loopback 可 HTTP），`callbackHandler` 不默认挂载，guard 永不 fetch baseUrl，token 仍为 inert HMAC。
- 假 MCP server / 假 LLM API 独立蜜罐机（Phase 2 再议）。

trap 的准入与自保：verified crawler / allowlist 永不被 trap；单次 `/.env` 命中不够。canary replay 或 high incident 可确认；已有前次检测信号且检测分 ≥ 阈值可进入 delay/rateLimit/maze，但不能单凭检测分 block。机械 `automation_score` 只观测、不提升严重级别、不单独触发 block/maze。block 使用固定 TTL（默认 15 min，上限 24 h）和有界 LRU（默认 8192、上限 50k），每次 403 记录日志，不扩大到 CIDR。client key 本身是网络前缀 + UA，可能合并多人，不能当作身份凭据。

Node 的 `AGENT_GUARD_TRAP=off` 与 `guard.setTrapEnabled(false)` 可运行时关闭；inspect p99 / 事件循环延迟超阈值时断路器发 `trap_circuit_open` 并回到检测。迷宫每会话/全局预算有界，耗尽返回普通 404；HTML 页面带 noindex/nofollow/no-store、无 cookie/外部 URL。v0.3b 在 25 ms/request 模型下时间比数百比一，字节比却为 1:1，低于 3:1 下限；运营者未做自己的真实 agent 测量前不应启用实验性迷宫。配置和风险见 [trap-mode.md](trap-mode.md) 与 [exhaust.md](exhaust.md)。

## 6. 主要风险（防御方自伤）

| 风险 | 缓解 |
|---|---|
| 误伤真人 | 诱饵无可见入口；trap 默认关且受确认闸门、allowlist/crawler 免疫、TTL/LRU 约束；共享 key 仍可能误伤 |
| 伤 SEO | noindex + X-Robots-Tag + robots disallow + 不进 sitemap + verified-crawler bypass |
| 误把 canary 当真密钥用 | 固定前缀 + checksum；CI 扫描禁止 canary 前缀进入 secret store |
| 告警风暴 | 同一 (canary_id, src_ip) 去重窗口 + 速率上限 |
| 自我资源耗尽 | delay 并发上限、maze 字节/页数/时长预算、断路器与运行时关闭；成本收益须自测 |
| Edge 状态降级 / 伪全局保证 | 无 StateStore 时 incident、rateLimit、block、timing、maze 会话准入自动关闭并警告一次；`memoryStore()` 仅单 isolate，不能当全局限流/封禁。持久 store 也需跨 isolate 更新协调 |
| IP 头伪造 | 未配置的转发头不受信任；配置 `ipHeader` 后必须由可信入口覆盖/清洗。否则攻击者可伪造客户端 key、绕过状态或使无关客户端合并 |
| UA 绕过导致漏报 | Web 默认 `ua-bypass` 接受自称已知搜索爬虫者，`crawler.verified: false`；可能放过伪装 Googlebot，优先避免 SEO 自伤；可用可信 `custom` 验证替代 |
| 品牌尴尬 | 假数据不含可识别真人 PII，风格为"内部样例" |

## 7. v0.4b Web / Edge 信任边界

- **状态作用域**：无 StateStore 时仍有 decoy、canary 生成/回放、HMAC 无状态 maze 节点、fetch 告警和单 isolate Prometheus，但不接纳 maze 会话。`memoryStore()` 在扩缩容/重启/淘汰后丢失或分割状态。接口无原子 read-modify-write；即使用持久或强一致 KV，多个 guard 的并发更新仍可能丢失。运营者不得把缺 store 或每 isolate 的内存当成全局 rateLimit / block；全局预算需要协调整个 inspection（例如单个 Durable Object 内的 guard），不只是单次 get/set。
- **IP 信任**：Workers `fromEnv` 默认 `CF-Connecting-IP`；Next/Vercel 必须显式指定可信 `ipHeader`，如 `x-real-ip` 或 `x-forwarded-for`。后者取最右侧非空一跳，不自动证明该跳可信；必须确保入口覆盖/清洗且源站不可被带伪造头的请求绕过。配置的头缺失时为 `unknown`，会合并客户端观测。Deno/Bun 的直接连接地址也只代表该连接，代理后的真实用户需另行可信配置。
- **爬虫策略**：默认 `ua-bypass` 下，Googlebot/Bingbot 等已识别搜索爬虫声明者永不进入 trap / maze / block，事件未验证、不升级严重度。伪装 UA 因而可能漏报；这是宁可放过也避免 SEO 自伤的明确取舍，不能作为爬虫身份验证。`custom` 验证必须依赖运营者可信数据，不可相信用户自己发来的 bot 头；Web guard 不做 DNS / DoH。
- **执行与投递**：trap 默认关闭；edge `trap.delay` 占用 wall time，不建议启用，显式开启上限 3000 ms。Web 不读取 Node 环境关闭开关，应使用 `setTrapEnabled(false)`。告警仅 fetch webhook / Slack / Telegram / 飞书，无 SMTP；无宿主 `waitUntil` 时异步投递可能随请求生命周期终止。持久 store 不使告警去重或指标成为全局视图。

接入、仅文档的存储示例和故障排查见 [edge.md](edge.md)。这些限制不改变 WAF / 补丁 / 最小权限的职责，也不证明实验性 maze 的 token 成本收益。

## 8. v0.5a honeyfiles、日志与 hooks 信任边界

- **Seed 文件风险**：假配置可能被真人、备份或安全扫描器误读。仅在运营者选择的隔离目录生成，不替换真实配置。内容 deterministic、inert，不使用真实厂商凭据格式/前缀；SSH placeholder 明显无效。默认 dry-run；显式 `--write` 的文件 0600、新目录 0700，现有文件不覆盖、目标 symlink 跳过，祖先 symlink/路径穿越/不安全 metadata 拒绝，不跟随不安全路径。已有目录权限不改；目录须由运营者控制，检查不是防并发替换祖先的 sandbox。`--verify` 只读检查完整性/权限，修改发现不是读取告警。callback URL 只能运营者自托管，默认保留域名；seed 不请求 URL、不部署 listener，也不自动生成签名 callback URL。
- **Watch 信任来源**：仅 Linux、只读 auditd/inotifywait 日志 parser；不使用 `fs.watch` / atime 声称检测读取。auditd read 规则与 `inotifywait -e access` 由运营者配置/运行，来源可能需 root，guard 无需 root。攻击者能写日志就可能伪造/抹除告警；丢行、inotify 合并、配置错误、速率/行长上限可能漏报。解析有界、畸形行忽略、轮转/截断重置。`honeyfile_read` medium，不进入 trap/block，不把 uid/comm 当身份凭据，不把相邻日志误当跨进程 incident 关联。无出站探测。
- **日志与 timeline**：Node `log.file` 可选，sanitized metadata，0600，有界（默认 10 MiB，超过前截断）、拒绝 symlink/非普通/多硬链接文件。不得记录完整 canary、secret、body、Cookie/Authorization。路径/uid/进程名仍可能敏感，权限与留存由运营者管理。CLI ack 需写到同一 `log.file` 才能被进程观察；其他文件或无 file 时提醒仍有上限但看不到 ack。内存、文件与重启边界不提供持久 SOC 保证。Prometheus summaries 无 path/UA/IP labels。
- **Hooks 攻击面**：Node 子进程以 guard 的 OS 权限执行，不是 sandbox，Web/Edge 无 hooks。默认不配置/关闭，只允许运营者写死的绝对路径 executable 与固定 argv，`spawn` / `shell: false`，不把请求内容拼入参数。新 env 仅白名单 `AG_INCIDENT_ID`、`AG_EVENT_TYPE`、`AG_CLIENT_KEY_HASH`、`AG_CANARY_ID`、`AG_PLACEMENT`，不继承 secret/PATH/HOME，不传 UA、原始请求路径、headers/body。metadata 也只能作数据，脚本不得再交给 shell/eval。运营者须控制 executable/script 与目录，脚本可拥有比 guard 更危险的能力。
- **Hooks 自保**：SIGTERM 后 1000 ms SIGKILL 的超时、每小时上限、每 hook 并发与模块全局上限；无无界队列，stdout/stderr 丢弃。失败/超时/拒绝仅发 `hook_result`，不影响 inspect。直接子进程终止并不隔离所有后代。guard 不轮换密钥、不改防火墙；[示例](examples/hooks/README.md) 仅日志/打印，不调用网络、不做破坏性操作。

操作步骤见 [seed.md](seed.md) 与 [incident-response.md](incident-response.md)。假成功仍需安全评估与单独批准；独立诱饵主机仍规划为程序/模板且不替运营者部署。真实 agent 评测预算未设定，不能声称已消耗攻击者 token；E4 仍禁止，以上功能不替代 WAF、补丁或最小权限。


## 9. v0.5b proxy / init / HTTP-log 边界（2026-11-16 HKT，unreleased）

proxy 首次进入请求数据通路，零运行时依赖、固定 HTTP(S) origin、默认 detect / alert-only。库的默认行为不变；proxy / HTTP-log 入口使用未验证 UA bypass，不新增 DNS。日志模式只读、无 trap/block/hooks，不配置系统日志工具。用法见 [distribution.md](distribution.md)。

| 新攻击面 | 缓解与边界 |
| --- | --- |
| 开放代理 / SSRF / CONNECT 隧道 | 只从运营者 --upstream 选择目标；拒绝非 HTTP(S)、credentials/path/query/fragment；Host、绝对 URI、query 不改变连接目标；不跟随响应重定向；CONNECT/Upgrade 405 |
| 头部走私 / 不一致分帧 | 使用 Node 严格 HTTP parser；双向移除 hop-by-hop 与 Connection 点名头；重新分帧、保留端到端重复头；不做原始 TCP 隧道。运营者仍须让入口与上游采用一致协议/解析策略 |
| 请求体缓冲 / 慢上传耗尽 | 只保存 16 KiB 检查窗口，窗口最多等 50 ms；其余流式转发/背压；上游总 deadline，客户端中断销毁上游；超出窗口会漏检，不能代替宿主大小/连接/速率限制 |
| 公开绑定 / 源站绕过 | 默认 127.0.0.1；非回环必须 --allow-public-bind 并 stderr 警告；仅接受 IP literal；运营者限制 ingress 与源站访问 |
| 伪造转发 IP | 默认 socket IP，只有显式 --trusted-proxy CIDR 才从右向左遍历 XFF，到不可信 hop 停止；Forwarded 不参与选择 |
| 检查故障吞掉业务 / 上游故障 | 检查抛错或超时 fail-open 并记录固定 alert_failed 错误；D5 既有故意延迟另计。上游失败 502、deadline 504；已发送响应头后中断流；停机最多等待 5 s |
| init 覆写项目 / 执行不可信代码 | 只读 package.json / tsconfig 元数据；默认 diff，--write 独占创建 0644；固定目录内目标，拒绝穿越/符号链接；不改源文件/hooks，不安装、不执行项目代码 |
| 初次密钥泄漏 | 配置只有环境引用；显式 --init-secrets 且配置不存在时才创建 0600 .env，不覆盖、不打印 secret；不执行 dotenv shell 内容 |
| HTTP 日志伪造 / 过量输入 / 可见性不足 | 行长/每 tick 字节/事件速率有界；轮转/截断/畸形行安全处理；事件 source: access_log；日志不等于可信身份或实时检测，头/body/Bearer 不可见、UA 未验证，无 DNS |

代理仅向固定的运营者上游发送业务请求。默认 proxy 与 HTTP-log 入口的其他出站仅限显式配置的告警 adapter；v0.5c 的库验签路径另有下述显式 key fetch 边界。诱饵始终 inert、noindex/no-store，不认证、不调用业务服务。Docker / Workers 已有本地源码模板（unreleased，无部署/发布），Helm 仍 planned，真实 agent 评测 #11 尚未运行、预算待定。

## 10. v0.5c Web Bot Auth 与 Workers 模板（2026-11-23 HKT，unreleased）

Web Bot Auth 基于 `draft-ietf-webbotauth-httpsig-protocol-01` / RFC 9421，兼容 Dictionary 与 legacy bare-string `Signature-Agent`。这是正向验签路径，不证明 agent 良性，也不替代宿主认证。`webBotAuth.enabled` 默认 false，关闭时不解析签名、不做密码运算或 key discovery；默认使用每个可信 agent 的静态 public JWKS，无出站请求。仅 WebCrypto Ed25519；缺失运行时支持、解析错误、无效/过期签名均不给信任，不独立升级严重级别或阻断宿主。

| 攻击面 | 缓解与剩余边界 |
| --- | --- |
| 自签 agent / keyid 混淆 | 请求声明的 Signature-Agent URL 本身不可信。密钥查找绑定 **(完整规范化 agent URL, key)**，再比较 SHA-256 JWK thumbprint 与 keyid，绝不按 keyid 跨 agent 搜索。只有签名有效且 URL 列入运营者 `trustedAgents` 才获 trust；可抓取的 host 不等于可信 agent。有效但 untrusted / 自签请求在决策上与未签名请求一致 |
| JWKS fetch SSRF | 默认无 fetcher、无出站，也不在启动时抓取。只有显式注入 `fetchKeys.fetcher` 且精确、不区分大小写匹配 `allowHosts` 才抓取；无通配符或子域匹配，空表不抓取。URL 最长 2048 字符，仅 HTTPS、无凭据/fragment/空白/反斜线/非默认端口；不做 well-known 路径发现。可抓取的未信任 URL 同样可能触发 I/O，故 allowHosts 必须最小化 |
| 重定向 / 恶意响应 | fetcher 接收 `redirect: 'manual'`，只接受 200，拒绝 3xx、redirected 或最终 URL 不匹配。仅接受三种 JSON/JWKS 媒体类型及直接 public JWKS（1–64 keys，无私钥字段）；不递归跟目录。Content-Length 与流式读取都检查大小，默认 64 KiB、最大 256 KiB；无效 UTF-8/JSON/JWKS 不获信任 |
| DNS rebinding / 私网目的地 | 精确 host / HTTPS 检查不解析或钉住 IP，不自动排除私网/回环地址。运营者 fetcher / DNS / 出站网络策略必须限制实际目标、遵守 manual redirect 与 AbortSignal。任意注入代码可以忽略约束；它属于可信配置，不能被 JavaScript 安全抢占 |
| 抓取与缓存资源耗尽 / 缓存投毒 | 默认 2 s、最大 5 s 的 deadline 包含外部 cache 读取、fetch 与 body；每个 verifier 的本地 LRU 最多 256 个完整 URL、最多 32 个 pending lookup，同 URL 并发合并。正结果尊重 Cache-Control / Age、TTL 最长 24 h；负结果 30 s。可选 StateStore 仍检验期限/JWKS，容量/访问控制/完整性由运营者保证；能篡改可信 agent 缓存者可替换验证 key。超时仅限制等待，无法强制终止忽略取消的 fetcher |
| 签名重放 / 组件覆盖不足 | 要求 created / expires / tag / keyid，覆盖 @authority 与对应 signature-agent 成员（legacy 覆盖整个字段）；默认 clock skew 60 s、最大年龄/签名有效跨度 24 h。**无 nonce store**，重放边界仅为 **expires（含 skew）+ 覆盖组件**，不是单次使用。最低覆盖不绑定 method/path/query/body；未覆盖的内容仍可替换，应用与签名方须明确额外覆盖与内容完整性验证 |
| 解析成本 / 观测泄漏 | RFC 8941 有限状态解析与 RFC 9421 signature base 构造均有边界；重复字典 key/参数/组件拒绝，unsupported transformation 不获 trust。guard 先做有界请求快照；独立 verifier 调用者仍须限制原始输入。事件只附 web_bot_auth 的 agent_url/keyid/verified/trusted/reason，不记录签名字节；URL/keyid 仍可能是敏感标识，避免在 agent URL 中存放 secret |

验签成功且 trusted 的请求获得 `crawler_bypass` / `ua_class: verified_crawler`，绕过 decoy、maze 与全部 trap；保留 crawler 路由缺失响应语义，普通请求进入宿主。未信任或无效签名在决策上与未签名请求完全相同，仅现有事件可附观测元数据；独立的既有 UA/DNS/custom crawler 或 allowlist 仍可生效。`acceptSignatureHeader` 仅为显式辅助函数，不自动出现在普通或诱饵响应中。配置见 [edge.md](edge.md#web-bot-auth-configuration)。

[Workers 模板](../deploy/workers/README.md) 仅随 git 提供，不在 npm 包内；本仓库未部署或发布 Worker。模板固定 detect-only，guard 在 isolate 内惰性复用，无默认 StateStore/告警目的地；无 store 的功能降级不代表全局防护。`CF-Connecting-IP` 仅在可信 ingress 覆盖该头时可信，本地直连可伪造。秘密值由本地 ignored `.dev.vars` 或运营者 `wrangler secret put` 注入，不写入 `[vars]`。canary inert、诱饵 noindex/no-store 的边界不变。
