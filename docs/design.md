# agent-guard 设计文档（MVP = detect + canary）

- 日期：2026-11-10（HKT）
- 状态：草案，待 Dan 批准
- 上游：`/workspace/security/bla-server-anti-ai-assessment-2026-11-10.md`、`docs/threat-model.md`、`docs/kpi.md`
- 定位：通用 Node / Edge HTTP 中间件；纯开源研究项目，本仓库不部署到任何服务器，验证在本地 demo app 上完成。

## 0. 一句话

在应用进程内挂一层很薄的中间件：**放 3–5 个只读诱饵路由 + 唯一 inert canary 凭据**，谁碰诱饵、谁回放 canary 就**记录并告警**。MVP **不封禁、不限速、不 tarpit、不对对方下指令**。

## 1. 设计原则

1. **Alert-by-default, no auto-block**：MVP 唯一的"动作"是返回诱饵响应 + 告警。真实路由的行为永远不因 agent-guard 改变（无 cloaking）。
2. **真人零误伤**：诱饵没有任何可见/可点击入口；canary 只出现在诱饵响应和（可选）HTML 注释里。
3. **SEO 零回归**：诱饵 = noindex + X-Robots-Tag + robots Disallow + 不进 sitemap + verified-crawler bypass。
4. **Inert canary**：canary 永不进入真实 IdP / secret store / DB；它不能登录任何东西。
5. **隔离**：decoy handler 不调用任何业务代码 / DB / 外部服务。
6. **零/极少依赖**：核心零运行时依赖；只用 Node 内置 `crypto`、`dns`（Edge 用 WebCrypto + DoH 可选）。
7. **借概念不借代码**：概念来自 BLA（Poison / Exhaust / Canary）、Snare（inert 凭据位）、Drosera（Lure/Detect/Trap/Canary 分层）、Beelzebub/Sundew/Oubliette（Agent 行为指纹）。**不复制任何代码**（Beelzebub 为 GPL-3.0，尤其不得复制）。

## 2. 架构

```
request ──► [agent-guard core]
              ├─ 1. allowlist?（监控探针/自家 Bot）──► pass（仅 debug 日志）
              ├─ 2. canary scan（header / query / 小 body）──► 命中 → event=canary_replay → alert；请求继续交给 app（不改变行为）
              ├─ 3. path match decoy?
              │      ├─ UA 声称是主流搜索爬虫 → verifyCrawler(ip)（rDNS + 正向确认，带缓存）
              │      │     ├─ verified / 校验超时（fail-safe）→ 返回 404（与不存在路径一致），event=crawler_bypass(debug)
              │      │     └─ 不通过 → 视为伪装（signal: ua_spoof_crawler），继续
              │      └─ 返回诱饵响应，event=decoy_hit → alert
              ├─ 4. probe path?（/wp-admin、/.git/config 等）→ 仅记录 event=probe（不告警，计入分数），交给 app
              └─ 5. pass → app
```

核心是框架无关的纯函数式 API：`core.inspect(AGRequest) → Promise<AGDecision>`，各运行时 adapter 只做请求/响应转换。告警投递异步、不阻塞响应。

## 3. MVP 诱饵路由（固定 5 条）

所有诱饵响应**统一**带：

- `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`
- `Cache-Control: no-store`
- HTML 响应额外带 `<meta name="robots" content="noindex,nofollow,noarchive">`
- 不设置任何 cookie，不读取/改变真实 session
- 响应体内的假数据由 `projectSeed` 确定性生成（同一项目每次一致，不同项目不同 → 避免全网同指纹）
- 响应体大小上限 8 KB（MVP 不做 Exhaust/maze）
- 路径前缀可配置；下表为默认值

| # | 路由（默认） | 方法 | 诱饵行为（精确） | 内含 canary | 事件 |
|---|---|---|---|---|---|
| D1 | `/.env`（同时匹配 `/.env.local`、`/.env.production`、`/.env.bak`） | GET/HEAD | `200`，`Content-Type: text/plain; charset=utf-8`；约 15 行看似真实的 dotenv：`DATABASE_URL=postgres://ag_ro:<canary>@db-internal.invalid:5432/app`、`ADMIN_API_TOKEN=<canary>`、`STRIPE_SECRET_KEY=<canary>`，其余为无害配置项（`NODE_ENV=production` 等）。主机名一律用 `.invalid` TLD（RFC 2606，不可解析）。 | 3 个（db 密码、admin token、payment key） | `decoy_hit`（severity=high） |
| D2 | `/api/internal/admin`（含其下任意子路径） | 任意 | 不带 `Authorization` → `401` JSON `{"error":"missing internal token","hint":"see /api/internal/openapi.json"}`；带任意 Bearer → 若是 canary 则 `403 {"error":"token expired"}`（并产生 `canary_replay`），否则同样 `403`。**永远不返回"成功"**，不暴露任何真实数据。 | 无（作为 canary 的"使用面"） | `decoy_hit`（medium）；带 canary 时另记 `canary_replay`（critical） |
| D3 | `/internal/ops-notes`（假"泄漏凭据页"） | GET | `200` HTML，标题"Ops notes (internal, do not share)"；一段看似内部 wiki 的文本，含一组假管理员账号 `ops-admin@<site>` / 密码 `<canary>`、一个假 SSH 跳板 `bastion.internal.invalid`。页面无任何外链、无脚本。 | 2 个（密码、API key） | `decoy_hit`（high） |
| D4 | `/api/internal/openapi.json`（假 OpenAPI / debug 文档） | GET | `200` JSON，OpenAPI 3.1；描述 6–8 个假的内部端点，全部位于 `/api/internal/admin/*`（即 D2 的范围）；`components.securitySchemes` 的示例 Bearer 为 canary；`servers[0].url` 为同源相对路径（不指向第三方）。 | 1 个（示例 bearer） | `decoy_hit`（medium） |
| D5 | `/api/internal/auth/login`（假内部登录） | POST（GET → 405） | 接收 JSON 或 form：固定 `401 {"error":"invalid credentials"}`，固定延迟 300–600 ms（模拟真实登录，不做 tarpit）。若 body 中出现 canary → `canary_replay`。**不论输入，从不返回成功。** | 无（作为使用面） | `decoy_hit`（medium）；带 canary → `canary_replay`（critical） |

**Lure（让 Agent 找得到诱饵，但真人找不到）**：

- **robots.txt**（默认开启）：追加 `Disallow: /.env`、`Disallow: /internal/`、`Disallow: /api/internal/`。合规爬虫不会去，Agent/扫描器常把 Disallow 当"藏宝图"。提供两种模式：`robots: "append"`（中间件拦截 `/robots.txt`，在 app 原响应后追加，保留原内容）或 `robots: "manual"`（用 `guard.robotsLines()` 自己写入）。
- **HTML 注释 lure**（默认关闭，opt-in 指定页面）：如 `<!-- TODO(ops): remove before launch, see /internal/ops-notes -->`。≤ 120 B/页，不可见、不影响渲染。
- **llms.txt**（默认关闭）：若站点已有 `llms.txt`，可追加一行指向 D4。
- 真实页面中**不放**任何可见链接、隐藏 `<a>`、`display:none` 元素（避免无障碍工具误触、避免 Google 视为隐藏链接）。

**真实登录接口的 canary 检测**：在 `canaryScan.bodyPaths`（默认 `["/login", "/api/auth/*"]`）上扫描已解析的 body（≤ 16 KB）。命中 canary 只告警，真实登录逻辑照常执行（canary 本来就不是有效凭据，必然失败）。

## 4. Canary 格式

### 4.1 规范形态（canonical）

```
<PREFIX><ID>-<CHECKSUM>
AG-CANARY-7K3M9QX2TB4P-H8Q2ZC          # 默认 prefix
ACME-CANARY-7K3M9QX2TB4P-H8Q2ZC        # 自定义 prefix = "ACME-CANARY-"（通用可配项）
```

- `PREFIX`：默认 `AG-CANARY-`，可配置，正则 `^[A-Z][A-Z0-9]{1,15}-CANARY-$`（强制含 `CANARY` → 人一眼知道是假的，CI 也好扫）。
- `ID`：12 位 Crockford Base32 随机（60 bit），`crypto.randomBytes`。不编码任何含义；环境、投放位置记在 registry 里。
- `CHECKSUM`：`base32(HMAC-SHA256(canarySecret, PREFIX + ID))[0:6]`。作用：① 离线快速判真伪，丢弃形似但伪造的串；② 证明这是本项目签发的。
- `canarySecret`：项目级 32 字节随机，存在**真实** secret store（它本身是真秘密，不是 canary）；丢失只会导致旧 canary 无法验 checksum，可用 registry 精确匹配兜底。

### 4.2 Registry

`agent-guard.canaries.json`（可提交到仓库，不含秘密）：

```json
{ "version": 1, "prefix": "AG-CANARY-", "canaries": [
  { "id": "7K3M9QX2TB4P", "token": "AG-CANARY-7K3M9QX2TB4P-H8Q2ZC", "env": "demo",
    "placement": "D1:/.env#ADMIN_API_TOKEN", "createdAt": "2026-11-10T09:00:00Z" } ] }
```

CLI：`agent-guard canary new --env demo --placement "D3:password"`、`agent-guard canary list`、`agent-guard canary scan <path>`（扫描目录/文件，发现 canary 前缀出现在非白名单文件中即非零退出 → 用于 CI 防止 canary 混进真实配置）。

### 4.3 Shaped 变体（opt-in，默认关闭）

有些投放位需要"像真的"（如 `sk_live_…`）。`shape: "stripe" | "jwt" | "hex32"` 时生成形似字符串，**完整字符串**写入 registry，检测走精确匹配。代价：CI 无法仅凭前缀识别 → 必须用 `canary scan --registry`。MVP 默认只用 canonical。

### 4.4 Inert 规则（硬性）

1. canary 不得写入任何真实 IdP、用户表、secret manager、云厂商 key 列表、CI secrets。
2. D1 中的连接串主机名必须是 `.invalid`。
3. 不使用任何会"回拨"第三方的 canary（如真实云 key 型 honeytoken 服务）——检测只发生在我们自己的服务器上。
4. `agent-guard canary scan` 应加入采用方 CI（文档给出 GitHub Actions 片段）。

## 5. Verified-crawler bypass

目的：**Googlebot 等合规爬虫永远进不了任何诱饵/maze**。

- 触发条件：请求命中 decoy 路由，且 UA 匹配已知爬虫（Googlebot、Google-InspectionTool、GoogleOther、Bingbot、Applebot、DuckDuckBot、YandexBot、Baiduspider）。只在这个窄路径上做 DNS，**普通流量零 DNS 开销**。
- 校验：`dns.reverse(ip)` → 主机名后缀必须在白名单（`googlebot.com`、`google.com`、`googleusercontent.com`、`search.msn.com`、`applebot.apple.com`、`yandex.ru/.net/.com`、`baidu.com/.jp` 等，可配置）→ 再 `dns.resolve4/6(hostname)` 必须包含原 IP。
- 缓存：LRU（默认 10k 条），通过 24 h，不通过 1 h。
- 超时：300 ms；**超时/DNS 错误 → fail-safe 视为 verified**（宁可放过一个伪装者，也不让真 Googlebot 看到诱饵）。
- 已验证爬虫命中诱饵 → 返回 `404`（与 app 不存在路径的默认 404 形态一致），不告警，仅 debug 日志。
- UA 声称是爬虫但校验失败 → `signal: ua_spoof_crawler`，正常走诱饵逻辑。
- 可选：用户提供本地 IP 段文件（如 Google 公布的 googlebot.json 的离线副本）加速；agent-guard **不会**自己去下载。
- 声明身份的 AI 爬虫（GPTBot、ClaudeBot、PerplexityBot…）不做 bypass，但 `ua_class=declared_ai_crawler` 单独统计，告警降级为 `info`。

## 6. 检测信号（MVP 只打分不处置）

| 信号 | 权重 | 说明 |
|---|---|---|
| `decoy_path` | +50 | 命中 D1–D5 |
| `canary_replay` | +100 | 任意位置出现有效 canary（终局信号） |
| `ai_discovery_path` | +10 | 访问 `/llms.txt`、`/.well-known/mcp.json`、`/.well-known/ai-plugin.json`、`/openapi.json` 等 |
| `probe_path` | +15 | `/wp-admin`、`/.git/config`、`/phpinfo.php`、`/actuator/*` 等扫描指纹 |
| `ua_spoof_crawler` | +30 | 声称爬虫但 rDNS 失败 |
| `ua_automation` | +10 | `curl/`、`python-requests`、`node-fetch`、`axios/`、`Go-http-client`、`HeadlessChrome`、空 UA |
| `robots_then_disallowed` | +20 | 同一 client_key 读 robots.txt 后 60 s 内访问 Disallow 路径 |
| `mechanical_timing` | +10 | 同一 client_key 10 个请求间隔方差极低（v0.1 可选，默认关） |

- `client_key = sha256(ip/24 或 ipv6/48 + UA)[0:16]`，不存原始 IP 到告警（日志可配置是否保留原 IP，默认保留在本地日志、告警中打码）。
- 状态存内存 LRU（默认 50k client_key，TTL 30 min）；多实例部署时分数是 per-instance 近似值，MVP 接受此限制（不引入 Redis）。

v0.3a / unreleased 新增的关联层独立于上述分数：同一 `client_key` 在默认固定 15 min 窗口内附加可选 `incident`（id、最近 32 项有序 sequence、first_seen/last_seen、low/medium/high confidence）。`incident.windowMs` 可配置，0 关闭；50k 客户端 LRU，序列以四位编码存储。置信度只升不降，不影响严重级别、HTTP 响应、诱饵选择或爬虫绕过。robots 只增加内部序列标记，不新增事件类型。共享网络下 client_key 不代表真实用户或登录会话。

Canary propagation 只在返回的内置诱饵响应体中确实包含令牌时记录首次下发，HEAD / crawler bypass 不计。进程内 50k 记录 LRU、24h TTL，最多保留 8 个不同重放 client_key；重放附加 leaked_at、replayed_at、可选 dwell_ms 与 client_keys_seen。未知下发时间（重启、淘汰或宿主自定义响应）必须省略 dwell_ms，不使用 registry.createdAt 替代。完整可选字段以 [event.v1.json](../schema/event.v1.json) 与 [类型定义](../src/types.ts) 为准。

## 7. 结构化日志（JSON schema）

每个事件一行 JSON（默认 stdout，可自定义 sink）。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "agent-guard/event.v1.json",
  "type": "object",
  "required": ["v","ts","event_id","event","severity","project","env","req"],
  "properties": {
    "v": { "const": 1 },
    "ts": { "type": "string", "format": "date-time", "description": "UTC ISO-8601" },
    "event_id": { "type": "string", "description": "ULID" },
    "event": { "enum": ["decoy_hit","canary_replay","probe","ai_discovery","crawler_bypass","alert_sent","alert_failed"] },
    "severity": { "enum": ["debug","info","medium","high","critical"] },
    "project": { "type": "string" },
    "env": { "type": "string" },
    "req": {
      "type": "object",
      "required": ["method","path","client_key"],
      "properties": {
        "method": { "type": "string" },
        "path": { "type": "string", "description": "不含 query" },
        "query_keys": { "type": "array", "items": { "type": "string" } },
        "ip": { "type": "string", "description": "可配置是否记录" },
        "client_key": { "type": "string" },
        "ua": { "type": "string", "maxLength": 512 },
        "ua_class": { "enum": ["browser","automation","verified_crawler","spoofed_crawler","declared_ai_crawler","unknown"] },
        "referer": { "type": "string" },
        "has_session": { "type": "boolean", "description": "是否带真实 session cookie（仅判断存在，不记录值）" },
        "country": { "type": "string", "description": "可选，由调用方 clientMeta 提供，可空" }
      }
    },
    "decoy": { "type": "object", "properties": { "id": { "enum": ["D1","D2","D3","D4","D5"] }, "status": { "type": "integer" } } },
    "canary": { "type": "object", "properties": {
      "id": { "type": "string" }, "placement": { "type": "string" }, "env": { "type": "string" },
      "found_in": { "enum": ["header","query","body","path"] }, "field": { "type": "string" } } },
    "score": { "type": "integer" },
    "signals": { "type": "array", "items": { "type": "string" } },
    "crawler": { "type": "object", "properties": { "claimed": { "type": "string" }, "verified": { "type": "boolean" }, "rdns": { "type": "string" }, "cache": { "type": "boolean" } } },
    "alert": { "type": "object", "properties": { "channel": { "type": "string" }, "latency_ms": { "type": "integer" }, "status": { "type": "integer" }, "deduped": { "type": "boolean" } } }
  }
}
```

日志**不得**记录：完整请求 body、Cookie/Authorization 的值（canary 除外：记录 canary id，不记录原文以外的其他 header 值）。

## 8. 告警通道（pluggable）

接口：

```ts
interface AlertAdapter {
  name: string;
  send(alert: AlertPayload, signal: AbortSignal): Promise<{ ok: boolean; status?: number }>;
}
```

v0.1（MVP）只内置两个（零依赖）：

| Adapter | 说明 |
|---|---|
| `webhook` | 通用 JSON POST（Node 内置 `fetch`）；`X-AgentGuard-Signature: sha256=<hex HMAC-SHA256(timestamp + "." + body, webhookSecret)>`；`X-AgentGuard-Timestamp`（Unix 秒）防重放；附导出 `verifyWebhookSignature()` 供接收端使用 |
| `console` | 把告警以单行 JSON 写到 stderr（或注入的 stream），用于本地 demo / 开发 |

**Future adapters（v0.2+，不在 MVP）**：`slack`（Incoming Webhook）、`telegram`（Bot API）、`feishu`（飞书/Lark 机器人）、`email`（注入 send 函数）。在此之前可用 `webhook` + 用户自建转发实现，或自行实现 `AlertAdapter` 接口。

规则：

- 默认告警：`canary_replay`（critical）、`decoy_hit`（high/medium）。`probe`/`ai_discovery` 只记日志，可配置升级。
- 去重：同一 `(event, decoy.id|canary.id, client_key)` 10 min 内只发一次，计数累加到下一条摘要。
- 全局限速：默认 30 条/分钟/通道，超出合并为一条摘要。
- 投递：超时 5 s，指数退避重试 2 次；失败记 `alert_failed`，**绝不阻塞或影响请求响应**。
- 告警内容 IP 默认打码（`1.2.3.x`），日志里保留完整 IP。
- 除配置的告警 URL 外，agent-guard 不发起任何出站网络请求（DNS 校验爬虫除外）。

## 9. 配置面（Config surface）

```ts
export interface AgentGuardConfig {
  project: string;                       // "acme-demo"
  env: string;                           // "demo"
  mode: "detect";                        // MVP 仅此值；"trap" 预留，v0.1 传入即抛错
  projectSeed: string;                   // 决定假数据与默认诱饵内容
  canary: {
    prefix?: string;                     // 默认 "AG-CANARY-"
    secret: string;                      // HMAC key，来自真实 secret store
    registry: CanaryRegistry | string;   // 对象或 json 路径
  };
  decoys?: {
    enabled?: Array<"D1"|"D2"|"D3"|"D4"|"D5">;  // 默认全开
    basePath?: string;                   // 默认 "/api/internal"
    paths?: Partial<Record<"D1"|"D2"|"D3"|"D4"|"D5", string | string[]>>;
    siteName?: string;                   // 生成假邮箱域名用
  };
  lures?: {
    robots?: "append" | "manual" | "off";      // 默认 "manual"
    htmlComment?: { paths: string[] } | false; // 默认 false
    llmsTxt?: boolean;                         // 默认 false
  };
  canaryScan?: {
    headers?: boolean;                   // 默认 true
    query?: boolean;                     // 默认 true
    bodyPaths?: string[];                // 默认 ["/login", "/api/auth/*"]
    maxBodyBytes?: number;               // 默认 16384
  };
  crawler?: {
    verify?: boolean;                    // 默认 true
    timeoutMs?: number;                  // 默认 300
    failOpen?: boolean;                  // 默认 true（超时视为 verified）
    extraSuffixes?: Record<string, string[]>;
    ipRangesFile?: string;
    resolver?: { reverse(ip: string): Promise<string[]>; resolve(host: string): Promise<string[]> }; // 可注入（测试 / demo 模拟爬虫用），默认 node:dns/promises
  };
  allowlist?: { ips?: string[]; cidrs?: string[]; uaPatterns?: RegExp[]; headerToken?: { name: string; value: string } };
  alerts?: { adapters: AlertAdapter[];   // v0.1: webhookAdapter / consoleAdapter
              minSeverity?: Severity; dedupeWindowSec?: number; ratePerMinute?: number; redactIp?: boolean };
  log?: { sink?: (e: AgentGuardEvent) => void; level?: Severity; keepIp?: boolean };
  clientIp?: (req: AGRequest) => string; // 默认读 x-forwarded-for 第一个可信跳 / cf-connecting-ip，需配置 trustProxy
}
```

## 10. 运行时 adapter

> 包名待定：npm 上 `agent-guard` 已被无关项目占用，建议发布为 `@imwyvern/agent-guard`（见 repo-proposal.md）。下表的 `agent-guard/*` 指该包的 subpath export。

| 阶段 | Adapter | 说明 |
|---|---|---|
| v0.1 | `agent-guard/express` | `app.use(agentGuard(config))`；body 扫描需放在 `express.json()`/`urlencoded()` 之后（文档给出顺序） |
| v0.1 | `agent-guard/node`（原生 `http`） | `(req, res, next)` 兼容层 + `wrap(handler)`，供原生 http / Next.js custom server / Koa 等 |
| v0.2（已完成） | `agent-guard/hono` | Node ≥20；有界克隆请求体扫描；edge 仍未实现 |
| v0.3a / unreleased（已完成） | `agent-guard/fastify`、`agent-guard/koa` | Fastify preHandler / Koa 宿主解析后检查；共享验收、原生 crawler 404 与可选 lure 变换 |
| v0.3+ | `agent-guard/cloudflare`、`agent-guard/vercel-edge` | 用 WebCrypto；rDNS 改为 DoH（需显式配置 DoH 端点，否则 Edge 上 crawler 校验依赖平台 `cf.verifiedBot` 等字段） |

## 11. 可观测性

- `guard.metrics()` 返回内存计数器：`requests_inspected`、`decoy_hits{decoy}`、`canary_replays`、`crawler_bypass`、`alerts_sent/failed`、`inspect_ns_p50/p99`。
- 可选 `/__agent-guard/metrics`（Prometheus text），**默认关闭**，开启需 headerToken。
- `npx agent-guard report --since 7d <log.jsonl>`：生成 KPI 表（见 kpi.md）。
- 不内置 OpenTelemetry 依赖；提供 `onEvent` hook 供接入。

## 12. Phase gates

| Phase | 内容 | 进入条件 |
|---|---|---|
| **P0 文档**（当前） | 威胁模型 / KPI / 设计 / Codex 合同 / repo 方案 | Dan 批准 |
| **P1 实现 v0.1** | Codex 按 `codex-contract.md` 实现；本地全部验收用例通过 | P0 批准 |
| **P2 本地验证** | Express demo + 原生 http demo；自动化测试；`bench/simulate.ts` 模拟真人 / verified & spoofed 爬虫 / curl 回放 canary / LLM-agent 探测；产出 FP、检测率、告警延迟、p99 开销；demo 上跑 Lighthouse/SEO 检查 | P1 done |
| **P3 研究复盘** | 按 kpi.md Gate 判断；再决定是否研究 v0.2（更多告警 adapter、Fastify/Hono、Edge、budget trap 的离线模拟） | Dan 拍板 |

本项目不部署到任何服务器；任何真实环境接入都不在本仓库范围内。

## 13. 明确非目标（Non-goals）

- ❌ Fork BLA 或把 BLA 当服务端方案（BLA 是客户端构建产物加固；只借 Poison/Exhaust/Canary 概念）。
- ❌ 生产环境 reverse prompt injection（在响应里对第三方 Agent 下指令、诱其外泄 system prompt 等）。
- ❌ 全站 tarpit / 无限 maze / 对所有爬虫拖延。
- ❌ 自动封禁、限速、改变真实路由行为（MVP）。
- ❌ 任何针对第三方系统的攻击、探测、反击或 exploit；agent-guard 不主动连接请求方。
- ❌ 替代 WAF / DDoS 防护 / 认证系统。
