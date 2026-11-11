# Codex 合同：v0.4b（Web 标准核心 + Edge 适配器）

- 依据：Dan 2026-11-11 批准按 [plan-v0.5-v0.7.md](plan-v0.5-v0.7.md) 顺序推进，v0.4b 为第一项。关联：[roadmap.md](roadmap.md) §4.1、Issue #4（Next.js）。
- 约束：Node ≥20，TS strict，**运行时依赖仍为 0**（devDependencies 可新增，用于测试）；不加 CI，不打 tag，不发 npm，不改包名，不 force-push；**不改变 Node 适配器的现有行为**。
- **硬性回归**：现有 692+ 项测试不得减少，现有验收断言不得改动；默认配置下 Express / Node / Hono / Fastify / Koa 的响应和事件与 v0.4a 字节一致。

## 1. 目标

让同一套检测逻辑在 Cloudflare Workers、Vercel Edge / Next.js middleware、Deno、Bun 上运行，同时保证和 Node 版结论一致。

## 2. 架构要求

### 2.1 Web 标准核心（`src/web/`）
- 入口 `createWebGuard(config)`：返回 `{ handle(request: Request, ctx?): Promise<Response | null>, inspect(request): Promise<Decision>, prometheusText(), setTrapEnabled(), close() }`。`handle` 返回 `null` 表示放行给宿主。
- 核心只使用 Web 标准：`Request`/`Response`/`Headers`/`URL`、`crypto.subtle`（HMAC-SHA256）、`crypto.getRandomValues`、`TextEncoder`、`fetch`、`setTimeout`/`AbortSignal.timeout`。**不得 import 任何 `node:*`**，也不得间接引入（`src/web/**` 及其依赖闭包）。
- 抽取与运行时无关的纯逻辑，供 Node 和 Web 共用：路径/UA 规则、decoy 匹配、decoy 响应生成、canary 解析与格式、incident、信号评分、maze 节点构造。凡需要 HMAC / 哈希 / 常量时间比较 / 随机数的地方，抽成 `CryptoProvider` 接口（Node 实现保持同步 `node:crypto`，Web 实现用 WebCrypto 异步）。
- **热路径不得无谓变 async**：Web 核心在请求既无 canary 候选、也未命中 decoy 路径时，不得做任何 HMAC。Node 核心保持同步，不引入性能回退。
- 常量时间比较：Web 端自行实现（先比长度再按位异或累积），有测试。

### 2.2 状态与降级
边缘函数没有持久内存。定义最小接口 `StateStore { get(key); set(key, value, ttlMs); delete(key) }`，内置 `memoryStore()`（有界 LRU，仅单个 isolate 内有效）。
- **无状态可用**：decoy 路由、canary 生成与回放检测、HMAC 无状态 maze 节点、告警、Prometheus（单实例视角）。
- **需要 StateStore 才启用**：incident 关联、rateLimit、block、timing 评分。未提供持久 store 时，这些功能必须**自动降级为关闭并在文档中说明**，而不是在 isolate 内存里给出误导性的「全局」结论；使用 `memoryStore()` 时文档标明"每个 isolate 独立"。
- 提供 Cloudflare KV / Durable Object / Vercel KV 的**示例代码**写在 docs，不作为依赖，不打包。
- `trap.delay` 在 edge 默认禁用（会占用 wall time 计费），显式开启时仍受 3000 ms 上限。

### 2.3 爬虫验证
边缘没有 `node:dns`。`crawler.verify` 新增选项：
- 默认 `'ua-bypass'`：UA 自称 Googlebot/Bingbot 等已知爬虫时，**永不进入 trap / maze / block**，事件标记 `crawler_verified: false`、不升级严重度（宁可放过，不得误伤搜索引擎）。
- `'custom'`：运营者提供 `async verify(ip, ua)`（例如查 Cloudflare 的 bot score 头、或自家验证服务）。
- guard 自己不做 DNS-over-HTTPS 外联。

### 2.4 告警
- 新增基于 `fetch` 的传输层：webhook（含 HMAC 签名，WebCrypto）、Slack、Telegram、飞书可用；**SMTP 不进 Web 核心**（需要 TCP，文档写明改用 webhook / 其他 adapter）。
- 复用 v0.4a 的消息格式化、去重、限流与「只发元数据与 canary ID」规则；Node 传输层保持不变。
- 异步发送通过 `ctx.waitUntil(promise)`（Workers / Next `event.waitUntil`），不阻塞响应；无 `ctx` 时 fire-and-forget 并吞掉错误。

## 3. 适配器（各自独立导出子路径，零依赖）

| 导出 | 形态 |
| --- | --- |
| `@imwyvern/agent-guard/web` | `createWebGuard`（核心） |
| `@imwyvern/agent-guard/workers` | `withAgentGuard(guard, handler)`：包装 `{ fetch(request, env, ctx) }`；并提供 `fromEnv(env)` 读取 secrets（`AG_CANARY_SECRET` 等），**secret 缺失时拒绝启动并抛清晰错误，不使用默认值** |
| `@imwyvern/agent-guard/next` | `agentGuardMiddleware(guard)`：返回 Next middleware 函数，命中返回标准 `Response`，放行返回 `undefined`；不 import `next` 包（避免依赖），类型以结构化最小接口声明；README 给出 `middleware.ts` 与 `matcher` 示例（排除 `_next/static` 等） |
| `@imwyvern/agent-guard/deno` | `denoHandler(guard, next)`：包装 `Deno.serve` 的 handler |
| `@imwyvern/agent-guard/bun` | `bunHandler(guard, next)`：包装 `Bun.serve` 的 `fetch` |
| Hono | 现有 Hono 适配器保持不变；文档说明 Hono 在 Workers / Bun / Deno 上使用 `./hono`（Node 核心）还是 `./web`，并补一个基于 Web 核心的 `honoWeb` 变体 |

- 客户端 IP 取值：Workers 用 `CF-Connecting-IP`，Vercel 用 `x-real-ip` / `x-forwarded-for` 的**最右可信**，通过配置显式指定 `ipHeader`；**不信任未配置的转发头**。
- 所有适配器：只对 decoy 路径与带 canary 的请求处理；其余请求原样放行，不读取 body（沿用有界检查窗口），不改写响应。
- 环境检测：不要用 `typeof process` 之类做运行时分支；适配器各自显式。

## 4. 构建与包

- `tsup` 为 `web/workers/next/deno/bun` 增加 `platform: 'neutral'` 构建，ESM（可附 CJS），`sideEffects: false`，更新 `exports` 与 `typesVersions`。
- **中立性检查脚本**（`scripts/check-neutral.ts`，进 `npm test` 或 `npm run check:neutral`）：对上述构建产物逐个断言不含 `node:` 引用、`require(`、`process.`、`Buffer`；失败则测试失败。
- 产物体积预算：`web` 核心 gzip ≤ 40 KB（如超出需在报告中说明原因，不得偷偷放宽）。
- `npm pack --dry-run` 仍只含 `dist`、`schema`、文档与许可证文件。

## 5. 测试与验收

### 5.1 一致性（差分）测试（最重要）
- **Golden vectors**：相同 `secret` 和输入下，Node 核心与 Web 核心生成的 canary、maze 节点 MAC、webhook 签名**逐字节一致**，并互相验证通过；篡改一位必拒。
- **差分请求集**：一组固定的请求夹具（真人浏览器、curl 访问 `/.env`、带假密码回放、Googlebot UA、MCP/GraphQL decoy、超大 header、畸形 URL 等 ≥ 40 条），分别送入 Node 核心与 Web 核心，断言决策、事件关键字段（type、severity、canary、decoy id）一致。
- 共享验收套件（沿用 AC-1…AC-24 中与无状态相关的用例：真人零告警、curl 回放必告警、Googlebot 不进 maze、迷宫 noindex/no-store/无 cookie/无外部 URL、MAC 伪造 404）在 Web 核心上全部通过；依赖状态的用例在提供 `memoryStore()` 时通过，无 store 时断言**已降级且给出一次警告**。

### 5.2 运行时冒烟
- Workers：用 `miniflare`（devDependency）在 workerd 下跑冒烟：decoy 命中、canary 回放告警（接本地假 webhook）、正常请求放行、`ctx.waitUntil` 被调用。
- Deno / Bun：若 box 上有对应二进制则跑 smoke；没有则**如实标注 skipped 并说明原因，不得伪造通过**，同时提供可在本地一键运行的脚本。
- Next.js：用结构化最小 Request 对象测试 `agentGuardMiddleware` 的返回语义（Response / undefined）；不要求安装 `next`。若安装 `next` 作为 devDependency 做真实冒烟较重，可选，如做请在报告里说明。

### 5.3 性能
- 新增 `bench:latency:web`：Web 核心 `inspect` 对「普通请求（无候选、无 decoy）」的开销，Δp50 ≤ 200 µs、Δp99 ≤ 1000 µs（与 Node 同门槛，用 `hrtime`，多次取中位数）；canary 回放路径单独报告，不设硬门槛。
- 重跑 `bench:latency:hr`：Node 路径不得相对 v0.4a 回退（Δp50 ≤ 200 µs、Δp99 ≤ 1000 µs、50k 客户端堆 ≤ 10 MB）。p99 若再次在门槛附近抖动，**多次取中位数并如实报告**，不要改门槛让它变绿。
- 内存：memoryStore 有界（默认 50k 条目，LRU），有测试。

## 6. 文档与多语言（硬性要求）

更新 README.md 与 `docs/i18n/README.*.md` 五个译本（zh-CN、zh-TW、ja、ko、es；代码块逐字一致，相对链接可解析）：新增 "Edge / Web runtimes" 一节（支持矩阵：每个 runtime 可用 / 降级的功能；Workers、Next、Deno、Bun 的最小接入示例），"What it is NOT" 中把 Edge 标记为已支持并写明降级条款；更新 CHANGELOG、`docs/roadmap.md`（v0.4b 标完成，v0.5 起指向规划文档）、`docs/design.md`（core 分层图加入 CryptoProvider、StateStore）、`docs/threat-model.md`（edge 状态降级、IP 头信任、爬虫验证降级的风险）、`docs/community.md`（适配器贡献指南）；新增 `docs/edge.md`（接入、StateStore 示例、降级表、故障排查）。更新 `docs/distribution.md` 中 E-5 的依赖说明。Issue #4 完成后评论并关闭。

## 7. 明确不做

- 不新增运行时依赖；不引入 `next`、`hono` 到 dependencies。
- 不做 DNS-over-HTTPS 外联、不做任何出站探测、不做反向提示注入。
- 不在 edge 默认启用任何 trap；trap 与 v0.4a 一致，opt-in 默认关闭。
- 不做 SMTP 的 Web 版本；不做 npm 发布、tag、release。

## 8. 交付物清单（Codex 需自检）

1. `src/web/**`、共享纯逻辑拆分、`CryptoProvider`、`StateStore`；
2. `workers` / `next` / `deno` / `bun` 适配器与 `honoWeb`；
3. 构建配置、`exports`、中立性检查脚本；
4. 差分测试、golden vectors、共享验收套件、miniflare 冒烟、`bench:latency:web`；
5. 文档与六语言 README、CHANGELOG；
6. 报告：测试总数、体积、两套 benchmark 数字（含多次运行）、skipped 项及原因、偏离合同之处。

## 9. 验收（我方独立复核）

构建 / 类型 / lint / 测试全绿且总数不减；`check:neutral` 通过；差分与 golden 测试通过；Workers 冒烟通过；Node 适配器默认行为与 v0.4a 一致；两个基准如实记录；`npm audit --omit=dev` 0；对已排除的外部品牌名做全仓扫描，结果为 0（扫描词不要写进仓库文件，避免自匹配）；六份 README 代码块一致、相对链接无失效；`git status` 干净并正常推送 main。
