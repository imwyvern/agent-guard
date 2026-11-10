# Codex 实现合同：agent-guard v0.1（修订版 2026-11-10 17:10 HKT）

- 甲方（规格）：本目录文档；乙方（实现）：Codex CLI
- 权威规格：`docs/design.md`（行为）、`docs/kpi.md`（指标与验证方法）、`docs/threat-model.md`（边界）。冲突时以 design.md 为准，并在 `docs/implementation-notes.md` 中记录。
- 性质：**纯开源研究，不部署**。验证 = 本地 demo app + 自动化测试 + 模拟 benchmark。
- 包名（工作默认值，待 Dan 确认）：`@imwyvern/agent-guard`

## 1. 技术约束

| 项 | 要求 |
|---|---|
| 语言 | TypeScript 5.x，`strict: true`，`noUncheckedIndexedAccess: true` |
| 运行时 | Node ≥ 20（内置 `fetch`、`node:crypto`、`node:dns/promises`、`node:http`） |
| 运行时依赖 | **0 个**。`express` 仅作为 optional `peerDependencies` |
| 开发依赖 | 已预装，**不得新增**：`typescript`、`vitest`、`@vitest/coverage-v8`、`tsup`、`tsx`、`@types/node`、`express`、`@types/express`、`autocannon`、`@lhci/cli` |
| 模块 | ESM + CJS（tsup），`exports`：`.`、`./express`、`./node` |
| 测试 | 不访问网络；DNS 一律通过注入的 `resolver` mock；告警接收端一律是本地 `127.0.0.1` server |

## 2. 文件树

```
agent-guard/
├─ package.json  tsconfig.json  tsup.config.ts  vitest.config.ts
├─ README.md  CHANGELOG.md  LICENSE(Apache-2.0)  NOTICE
├─ docs/                         # 规格（不改语义）；新增 implementation-notes.md、bench-v0.1.md
├─ schema/event.v1.json          # design.md §7
├─ src/
│  ├─ index.ts  types.ts  config.ts  metrics.ts
│  ├─ core/{inspect,client-key,signals,lru,ulid}.ts
│  ├─ canary/{format,registry,scan}.ts
│  ├─ decoys/{index,fake-data,headers,d1-env,d2-admin,d3-ops-notes,d4-openapi,d5-login}.ts
│  ├─ lures/{robots,html-comment}.ts
│  ├─ crawler/{ua,verify}.ts
│  ├─ alerts/{dispatcher,webhook,console,format}.ts
│  ├─ log/sink.ts
│  ├─ adapters/{express,node}.ts
│  └─ cli/main.ts                # bin agent-guard: canary new|list|scan, report
├─ examples/
│  ├─ shared/site.ts             # demo 内容：/ /list /item/:id /login /pricing /robots.txt /sitemap.xml /static/*，原生 404
│  ├─ express-demo/server.ts     # AGENT_GUARD=on|off, PORT
│  └─ node-http-demo/server.ts   # 同上，原生 node:http
├─ bench/
│  ├─ simulate.ts                # kpi.md §1 场景 S1–S5 + 告警延迟
│  ├─ latency.ts                 # autocannon on/off
│  ├─ lighthouse.ts              # lhci on/off（无 Chrome 时 skipped）
│  └─ results/                   # gitignore
└─ test/{unit,integration,acceptance}/
```

## 3. 公共 API

```ts
export function createAgentGuard(config: AgentGuardConfig): AgentGuard;
export interface AgentGuard {
  inspect(req: AGRequest): Promise<AGDecision>;
  robotsLines(): string[];
  htmlCommentFor(path: string): string | null;
  metrics(): AgentGuardMetrics;
  close(): Promise<void>;               // flush 告警队列
}
export interface AGRequest { method: string; path: string; query: Record<string, string | string[]>;
  headers: Record<string, string | string[] | undefined>; ip: string; body?: unknown; }
export type AGDecision =
  | { action: "pass"; events: AgentGuardEvent[] }
  | { action: "respond"; response: { status: number; headers: Record<string, string>; body: string }; events: AgentGuardEvent[] };

export function generateCanary(o: { prefix?: string; secret: string }): { id: string; token: string };
export function verifyCanary(token: string, o: { prefix?: string; secret: string }): { valid: boolean; id?: string };
export function webhookAdapter(o: { url: string; secret: string; timeoutMs?: number }): AlertAdapter;
export function consoleAdapter(o?: { stream?: NodeJS.WritableStream }): AlertAdapter;
export function verifyWebhookSignature(o: { body: string; timestamp: string; signature: string; secret: string; toleranceSec?: number }): boolean;

// @imwyvern/agent-guard/express
export function agentGuard(configOrGuard: AgentGuardConfig | AgentGuard): import("express").RequestHandler;
// @imwyvern/agent-guard/node
export function agentGuardNode(configOrGuard): (req, res, next: () => void) => void;
export function wrap(guard, handler: http.RequestListener): http.RequestListener;
```

`AgentGuardConfig` 照 design.md §9（含 `crawler.resolver` 注入），每个字段写 JSDoc 默认值。默认 prefix `AG-CANARY-`，可配置。v0.1 只有 `webhook` 与 `console` 告警 adapter；Slack/Telegram/飞书/email 不实现。

## 4. 测试计划

| 层 | 内容 |
|---|---|
| Unit | canary 生成/校验（篡改 1 字符失败、错误 prefix、自定义 prefix）；registry；UA 分类（≥ 30 条 UA 表驱动）；LRU/TTL；去重/限速；fake-data 确定性；HMAC 签名/验签/过期 |
| Crawler | mock resolver：verified / 后缀不符 / 正向不含原 IP / 超时 fail-open / 缓存 |
| Alerts | 本地 http server 接收 webhook，验签；5xx 重试；挂起不阻塞；console adapter 输出单行 JSON |
| Integration | Express demo 与 node-http demo 各跑同一请求矩阵 |
| Acceptance | §5 全部 AC（`test/acceptance/*.test.ts`，对两个 demo 都跑） |
| Bench | `npm run bench` = simulate + latency（+ lighthouse），写 `docs/bench-v0.1.md`，Gate 不过非零退出 |

覆盖率：`src/` 行覆盖 ≥ 90%；`src/canary`、`src/crawler` 分支 100%。

## 5. 验收用例（AC-1…AC-15，两种 demo 都要过）

| ID | 场景 | 断言 |
|---|---|---|
| AC-1 真人不触发 | 浏览器 UA 会话：首页→列表→详情→登录（正确/错误密码）→登出，含 robots/sitemap/静态资源，≥ 50 请求 | 0 个 `decoy_hit`/`canary_replay`；0 告警；所有响应与 guard=off 逐字节一致（`lures.robots="off"`、HTML 注释 lure 关闭时） |
| AC-2 curl 回放必告警 | 取 D1 的 `ADMIN_API_TOKEN`，`Authorization: Bearer` 打 `/api/internal/admin/users`；把 D3 假密码 POST 到真实 `/login` 和 D5 | 每次 `canary_replay`（critical），`canary.id/placement/found_in` 正确；本地 webhook ≤ 1 s 收到且验签通过；真实 `/login` 响应与 off 一致 |
| AC-3 任意位置 | canary 放 query / 自定义 header / JSON 嵌套 / form 字段；自定义 prefix 配置下同样有效 | 全部检出；checksum 被篡改的形似串不告警 |
| AC-4 verified Googlebot | Googlebot UA + mock rDNS `crawl-66-249-66-1.googlebot.com` 正向含原 IP，访问 D1–D5 | 全部 404，正文与 demo 原生 404 一致；0 告警 |
| AC-5 伪装 Googlebot | Googlebot UA + rDNS 失败 | 进入诱饵，signals 含 `ua_spoof_crawler`，告警 |
| AC-6 DNS 超时 | Googlebot UA + resolver 挂起 | 300 ms 后按 verified 处理返回 404；总耗时 < 400 ms |
| AC-7 诱饵 noindex | D1–D5 | `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`、`Cache-Control: no-store`；HTML 带 robots meta；无 `Set-Cookie` |
| AC-8 robots/sitemap | append 模式 | 原内容保留 + 全部 decoy Disallow；sitemap 与 decoy 交集为空；真实页面不在 Disallow |
| AC-9 SEO/Lighthouse | 无 cloaking：真实页面浏览器 UA vs Googlebot（verified/spoofed）逐字节一致；Lighthouse on/off（kpi.md §3） | 一致；分数差 ≤ 2（无 Chrome 则标 skipped，并在 notes 说明） |
| AC-10 延迟预算 | `bench/latency.ts`，demo 首页；v0.2 起以 `bench/latency-hr.ts`（µs-resolution hrtime）为 primary，autocannon 保留为 secondary | p99 增量 ≤ 1 ms，p50 ≤ 0.2 ms；50k client_key 时内存增量 ≤ 10 MB |
| AC-11 无副作用 | 全部测试期间 stub `globalThis.fetch` 与 `node:dns` | 除本地 webhook 与注入 resolver 外 0 出站 |
| AC-12 mode 校验 | `mode` ≠ `"detect"` | 抛 `AgentGuardConfigError` |
| AC-13 告警不阻塞 | webhook 接收端挂起 30 s | 诱饵响应 < 50 ms；记录 `alert_failed` |
| AC-14 去重/限速 | 同一 client 1 分钟打 D1 100 次 | 告警 ≤ 1 条（+ 摘要计数正确） |
| AC-15 CLI canary scan | 含 canary 的临时目录 | 非零退出并列出 文件:行号；白名单（registry、decoy 模板）不报 |
| **Bench Gate**（kpi.md §2） | `npm run bench` | FP(human)=0、FP(verified crawler)=0、检测率 100%、canary 回放检测 100%、告警延迟 p95 ≤ 250 ms |

## 6. Done 定义

1. `npm run build && npm run typecheck && npm test` 全绿，AC-1…AC-15 通过；`npm run bench` Gate 通过并生成 `docs/bench-v0.1.md`。
2. `npm run demo:express` / `npm run demo:node` 可启动（默认 `PORT=3000`，`AGENT_GUARD=on`，告警走 console adapter；设置 `AG_WEBHOOK_URL` 时加 webhook）。
3. `npm pack --dry-run` 只含 `dist/`、`schema/`、README、CHANGELOG、LICENSE、NOTICE。
4. `package.json` 无运行时 `dependencies`。
5. README：安装、Express / 原生 http 示例、配置表、canary CLI、demo 与 bench 运行方式、What it is NOT。
6. CHANGELOG `Unreleased` 更新。
7. 偏差与未决问题写入 `docs/implementation-notes.md`。
8. 不需要 Codex 提交 git（由甲方审查后提交）。

## 7. 禁止事项

- ❌ 任何出站网络请求（包括 npm install、下载 IP 段、遥测）；依赖已预装。告警只发往配置的 URL（测试里是本地 server）。
- ❌ 自动封禁 / 限速 / tarpit / 修改真实路由响应（robots append 与 opt-in HTML 注释除外）。
- ❌ 实现 `mode: "trap"`、maze、budget trap、reverse prompt injection；诱饵中不得出现针对 Agent 的指令性文本。
- ❌ 复制 BLA / Beelzebub（GPL-3.0）/ Sundew / Drosera / Snare / Oubliette 代码。
- ❌ 使用可解析的真实主机名（只用 `.invalid`）或真实厂商 key 格式。
- ❌ 记录 Cookie / Authorization 原值（canary id 除外）或完整 body。
- ❌ 新增依赖；`git remote add`、`git push`、`npm publish`、创建 GitHub 仓库；连接任何真实站点或服务器。
- ❌ 改 `docs/` 中规格的语义（问题写入 implementation-notes.md）。
