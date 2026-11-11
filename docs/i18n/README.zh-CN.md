# agent-guard

[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

面向 Node ≥20 的 HTTP 中间件：五条隔离的诱饵路由和惰性金丝雀凭证，用于检测凭证重放与探测式扫描。它记录事件并发送异步告警。零运行时依赖；Express 为可选 peer。Apache-2.0，版权 2026 Wesley Wang。

这是一个开源研究项目，尚未发布到 npm。请从源码安装，或使用 `npm pack` 生成本地 tarball。当前包名为 `@imwyvern/agent-guard`。

请参阅[安全策略](../../SECURITY.md)、[贡献指南](../../CONTRIBUTING.md)和[路线图](../roadmap.md)。

## 本地安装与验证

本工作区已安装开发工具。请勿在此安装额外依赖。

```sh
npm run build
npm run typecheck
npm run lint          # strict-compiler lint (tsc --noUnusedLocals --noUnusedParameters)
npm test
npm run test:coverage
npm run bench
npm pack --dry-run
```

若要在单独的本地消费端使用，用 `npm pack` 生成 tarball，并安装 `./imwyvern-agent-guard-0.1.0.tgz`。tarball 仅包含 `dist/`、`schema/`、readme/changelog 以及法律声明。`private: true` 可防止发布。

## Express

```ts
import express from 'express';
import { createAgentGuard, consoleAdapter } from '@imwyvern/agent-guard';
import { agentGuard } from '@imwyvern/agent-guard/express';

const guard = createAgentGuard({
  project: 'local-catalog', env: 'demo', mode: 'detect',
  projectSeed: 'stable-project-seed',
  canary: {
    secret: process.env.AG_CANARY_SECRET!, // operator-supplied HMAC secret
    registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] },
  },
  alerts: { adapters: [consoleAdapter()] },
  lures: { robots: 'append' },
});
const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(agentGuard(guard)); // body parsers must precede the guard
app.get('/', (_req, res) => res.send('<h1>Local catalog</h1>'));
app.use((_req, res) => res.status(404).send('Not Found\n'));
const server = app.listen(3000, '127.0.0.1');
// On shutdown: stop accepting requests, then await guard.close() to flush alerts.
```

若使用注册表文件名，请先用 CLI 准备该文件。空注册表会在内存中生成六个规范的诱饵金丝雀。若令牌必须在重启后保持稳定，请用 CLI 持久化注册表中的放置位置。种子只控制无害的假数据；金丝雀 ID 仍保持密码学随机。

## 原生 Node HTTP

```ts
import { createServer } from 'node:http';
import { agentGuardNode, wrap } from '@imwyvern/agent-guard/node';

// Reuse the guard configured above.
const middleware = agentGuardNode(guard);
const server = createServer((req, res) => {
  // If this host parses a body, attach the bounded parsed value as req.body
  // before calling middleware. The guard never consumes the request stream.
  middleware(req, res, () => {
    res.statusCode = 404;
    res.end('Not Found\n');
  });
});
// Equivalent for a host that already provides req.body:
const listener = wrap(guard, (_req, res) => res.end('Hello'));
```

`inspect(AGRequest)` 返回 `{ action: 'pass', events }` 或 `{ action: 'respond', response, events }`。直接调用核心的使用者需自行处理核心给出的普通 `404`。适配器会把已验证的爬虫交回宿主，以保留其原生的缺失路由响应。请预留诱饵路径：若某条诱饵与真实路由冲突，请禁用或覆盖该诱饵。

可选的 robots/HTML/llms 变换在选定路径上最多缓冲 1 MiB；普通流会直接穿过。请安装在压缩之前。变换仅作用于成功且未压缩的响应。只有登录页的 HTML 注释会在显式启用时改动真实 HTML 页面。

## Hono（Node 运行时）

v0.2 的 Hono 适配器以 `@imwyvern/agent-guard/hono` 提供，并带可选的 `hono` peer。它要求 Node ≥20：共享核心仍使用 `node:crypto` 和 Node DNS。Edge 运行时与 WebCrypto 核心属于路线图中的 v0.3 工作。

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { agentGuard } from '@imwyvern/agent-guard/hono';

// Reuse the guard configured in the Express example.
const app = new Hono();
app.use('*', agentGuard(guard));
app.post('/login', async c => c.json(await c.req.json()));
app.get('/', c => c.text('Local catalog'));
app.notFound(c => c.text('Not Found\n', 404));
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 3000 });
```

请在消费应用中安装 Hono 以及你的 Node 服务器集成。本仓库仅将二者作为开发依赖安装；适配器不增加运行时依赖。`agentGuard` 接受 guard 或 config，从克隆的请求中扫描符合条件的请求体，上限为配置的 body cap（默认 16 KiB），并让下游处理函数仍可使用原始请求体。支持 JSON 和表单请求体；格式错误或被截断的输入会按有界文本扫描。宿主仍负责传输大小限制和读 body 的截止时间。`@hono/node-server` 提供套接字 IP；转发头需要显式受信任的 `clientIp` 回调。

检测仍然仅为告警：金丝雀重放会继续到达宿主，诱饵带有 noindex/no-store 头，已验证的爬虫会到达宿主原生的缺失路由处理。可选的 robots/HTML/llms 变换保留现有的 1 MiB 缓冲上限。运行 `npm run demo:hono`（`PORT` 和 `AGENT_GUARD=off` 的用法与其他目录演示相同）。Hono 运行与 Express 和 Node 相同的共享验收套件。

## MCP / LLM 工具端点诱饵

```sh
npm run demo:mcp
curl -s http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"export_customer_records","arguments":{}}}'
```

本地 Node HTTP 示例在 `POST /mcp` 实现了最小的 JSON-RPC `initialize`、`tools/list` 和 `tools/call`。`echo` 和 `get_time` 是无害的真实工具。调用列出的 `export_customer_records` 诱饵会通过正常告警管道发出 `decoy_hit`（`decoy.id: "MCP"`），并返回 JSON-RPC 权限错误。它不执行任何业务操作，也不返回记录、密钥或金丝雀。真实工具调用仍然仅为告警，包括在工具参数中进行常规的惰性金丝雀重放检测。

根导出提供 `mcpDecoyTools`、`inspectMcpRequest(guard, request, toolName?)` 和 `lintMcpDecoyDescription`。在有界解析之后调用一次该辅助函数，仅在 `tools/call` 时传入工具名；将 `crawler_bypass` 按宿主原生 404 处理。该示例同样把这一点用于发现阶段，因此已验证的爬虫永远看不到诱饵工具。所有 MCP JSON 响应均为 noindex/no-store。内置描述是中性数据，测试会拒绝祈使语气、URL 和隐藏字符。本示例是有限的 HTTP 场景，不包含完整的 MCP Streamable HTTP、会话或 SSE 支持。OWASP MCP01/MCP08 威胁映射、schema 详情与集成边界见 [MCP 场景与安全规则（中文）](../scenarios/mcp.md)。

## 配置

每个公开字段的默认值记录在 [src/types.ts](../../src/types.ts)。必填字段：`project`、`env`、`mode: 'detect'`、`projectSeed`，以及 `canary.secret`/`canary.registry`。

| 选项 | 默认值 / 行为 |
| --- | --- |
| `canary.prefix` | `AG-CANARY-`；模式 `^[A-Z][A-Z0-9]{1,15}-CANARY-$` |
| `canary.registry` | 必填的 version-1 对象或 JSON 路径；其中不存储任何 secret |
| `decoys.enabled` | D1–D5；`/.env` 别名、admin 子树、ops notes、OpenAPI、假登录 |
| `decoys.basePath` | `/api/internal` |
| `decoys.paths` / `siteName` | 可选路径覆盖 / `.invalid` 邮箱域名 |
| `lures.robots` | `manual`；`append` 保留宿主的 robots 响应，`off` 禁用集成 |
| `lures.htmlComment` | `false`；`{ paths: ['/login'] }` 选择启用；每页 ≤120 bytes |
| `lures.llmsTxt` | `false`；仅向已有的成功响应追加一条引用 |
| `canaryScan.headers` / `query` | 均为 `true`；路径始终扫描 |
| `canaryScan.bodyPaths` / `maxBodyBytes` | `['/login', '/api/auth/*']` / 16384；D5 始终扫描 |
| `crawler.verify` / `timeoutMs` / `failOpen` | `true` / 300 / `true` |
| `crawler.resolver` | Node DNS；可注入 `{ reverse, resolve }` 以供离线使用 |
| `crawler.extraSuffixes` / `ipRangesFile` | 可选的爬虫家族后缀 / 离线 JSON `{ google: ['CIDR'] }` |
| `allowlist` | 可选的精确 `ips`、IPv4/IPv6 `cidrs`、`uaPatterns`、精确 `headerToken` |
| `alerts.adapters` | 无默认目的地；提供 `webhookAdapter()` 和 `consoleAdapter()` |
| `alerts.minSeverity` | 诱饵/重放为 `info`；显式取值还会启用 probe/discovery 升级 |
| `alerts.dedupeWindowSec` | 600；同一事件 + placement/ID + client key |
| `alerts.ratePerMinute` | 每通道 30；被抑制的计数会带到下一条告警摘要中 |
| `alerts.redactIp` | `true`；告警中使用粗糙的 IPv4/IPv6 网段 |
| `log.sink` / `level` / `keepIp` | stdout JSONL / `info` / `true` |
| `clientIp` | 套接字 IP；仅在校验受信任代理之后再覆盖 |
| `onEvent` | 可选观察者；观察者/sink 失败会被隔离 |

`guard.robotsLines()` 支持手动 robots 集成。`guard.htmlCommentFor(path)` 返回可选注释或 null。`guard.metrics()` 返回请求/事件/投递计数，以及有界的近期 inspect 时延分位数。分数是按实例的有界观测值，从不用于强制执行。客户端状态：50k 条目，30 分钟空闲 TTL；爬虫缓存：10k，阳性 24h / 阴性 1h。任何转发头都不会被自动信任。

D5 始终拒绝登录，并带有确定性的 300–600ms 延迟。所有诱饵均为 `noindex`、`no-store`，≤8KiB，只使用 `.invalid` 主机名，且从不创建 cookie、进行认证或调用业务服务。已声明的 AI 爬虫诱饵命中严重级别为 `info`。搜索爬虫的 DNS 检查仅发生在诱饵路由上。错误/超时会失败开放到原生 404。

## 告警与签名

```ts
import { webhookAdapter, verifyWebhookSignature } from '@imwyvern/agent-guard';
const adapter = webhookAdapter({
  url: 'http://127.0.0.1:4000/events', secret: process.env.AG_WEBHOOK_SECRET!,
  timeoutMs: 5000,
});
// Receiver: verify the ORIGINAL body string before parsing JSON.
const valid = verifyWebhookSignature({
  body: rawBody, timestamp: timestampHeader, signature: signatureHeader,
  secret: process.env.AG_WEBHOOK_SECRET!, toleranceSec: 300,
});
```

HMAC 输入为 `timestamp + '.' + body`；请求头为 `X-AgentGuard-Timestamp` 和 `X-AgentGuard-Signature: sha256=<hex>`。重定向会被拒绝。接收方还应额外对事件 ID 去重，以拒绝时间戳窗口内的重复投递。投递以异步方式运行，使用八个 worker、有界队列、5s 尝试截止时间和两次重试；`close()` 会刷出待投递项。Webhook 专用截止时间可以更短。告警记录只包含请求元数据和金丝雀 ID/来源，从不包含 body 或 Cookie/Authorization 的值。摘要计数表示被抑制的通知，并随下一条被接纳的告警发出，而不是由后台定时器发出。探测/发现流量默认只记录日志，不告警。

## 金丝雀 CLI

```sh
# Set AG_CANARY_SECRET in your environment; never commit it.
node dist/cli/main.js canary new --env demo --placement 'D1:/.env#ADMIN_API_TOKEN'
node dist/cli/main.js canary list
node dist/cli/main.js canary scan ./config
node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
node dist/cli/main.js report --since 7d ./events.jsonl
```

创建注册表时，`canary new` 也接受 `--prefix ACME-CANARY-` 以及 `--registry <file>`。当规范前缀或注册表令牌出现在注册表/`src/decoys/*.ts` 白名单之外时，扫描以退出码 1 退出并输出 `file:line`；用法错误以退出码 2 退出。符号链接以及 `.git`、`node_modules`、`dist`、`coverage` 会被跳过。请扫描目标配置目录，以避免命中文档/测试中有意放置的示例。注册表精确匹配允许密钥轮换后仍识别旧令牌。`report` 汇总观察到的事件/投递延迟；误报率/检测率需要带标注的模拟会话。

采用方项目的 CI 步骤示例（仅使用已构建的 CLI）：

```yaml
- name: Prevent canaries in real configuration
  run: node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
```

## 演示与基准测试

```sh
npm run demo:express
PORT=3001 npm run demo:node
AGENT_GUARD=off npm run demo:express
npm run bench:simulate
npm run bench:latency
npm run bench:latency:hr
npm run lhci
npm run bench
```

演示默认使用 `PORT=3000`、`AGENT_GUARD=on`、控制台告警，以及离线注入的 DNS。可选的 `AG_WEBHOOK_URL` 会启用带签名的 webhook；`AG_WEBHOOK_SECRET` 和 `AG_CANARY_SECRET` 可覆盖本地演示密钥。这些演示默认值仅用于本地研究。

两个演示共享 `/`、`/list`、`/item/:id`、`/login`、`/logout`、`/pricing`、robots/sitemap/静态内容，以及原生 404。演示登录使用 `demo@example.invalid` / `demo-password`。基准测试在两个演示上以指定会话数和固定种子运行 S1–S5，校验带签名告警的到达，执行延迟预热 + 三次运行的中位数，并检查 50k 客户端内存。在 TCP 可用时，每次运行会用 autocannon 跑 30 seconds / 100 connections。Lighthouse 使用本地 Chrome、`--headless --no-sandbox`、两种形态因子、五个 URL，以及每个 URL/mode/demo 五次运行。

对正在运行的演示做快速手动检查（第二个终端）：

```sh
PORT=3000 npm run demo:express          # or: npm run demo:node
curl -s -A 'Mozilla/5.0 Chrome/130' http://127.0.0.1:3000/   # real page, no event
TOKEN=$(curl -s http://127.0.0.1:3000/.env | sed -n 's/^ADMIN_API_TOKEN=//p')   # decoy_hit (high)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/internal/admin/users   # canary_replay (critical)
```

演示终端会打印单行 JSON 事件和控制台告警。所有令牌都是惰性的 `AG-CANARY-` 字符串，不能解锁任何内容。

自 v0.2 起，`npm run bench:latency:hr` 是 Express、Node 和 Hono 的主要 AC-10 测量方式：隔离的 keep-alive 客户端/服务器、微秒级计时、在 100/10 connections 下交错三次运行，以及核心 inspect 的 ns/op（约 3 分钟）。阈值仍为 Δp50 ≤200 µs、Δp99 ≤1000 µs，以及 50k-client heap ≤10 MB；只有 100-connection 那一行决定延迟是否通过。见 [v0.2 结果与配置](../bench-v0.2.md)；原始 JSON 为 `bench/results/latency-hr.json`，其中包含历史 autocannon 的次要证据。原来的 `bench` 命令仍保留其 v0.1 的 autocannon 门禁。

测量门禁失败会使基准测试以非零退出码退出。`bench:latency` 在各自的子进程中运行每个演示服务器，并用 autocannon 驱动（100 connections，30 s，3 次运行的中位数）；它还会记录一次非门禁的固定速率运行，以及由吞吐量推导的每请求开销估计。完整矩阵的 Lighthouse 大约需要 35 分钟。若沙箱禁止本地套接字，研究工具会在内存 Duplex 流上使用实际的 HTTP 请求/响应对象；TCP 延迟仍为 **未验证**。Chrome 启动失败会被 **跳过**，而不是记为通过。确切的环境限制见 [基准测试报告](../bench-v0.1.md) 和 [实现说明](../implementation-notes.md)。本库不包含该测试工具。

## 它不是什么

它不是 WAF、DDoS 防护、认证系统、机器人拦截器、生产部署，也不保证搜索引擎行为。没有自动阻断、流量限流、trap 模式、迷宫、反向提示注入、出站探测、真实厂商凭证，或第三方回调 honeytoken。Slack/Telegram/Feishu/email 以及 Edge/Fastify/Hono 适配器仍属后续工作。机械计时和 Prometheus 端点是可选的设计想法，在 v0.1 中未启用。

请参阅[设计](../design.md)、[合同](../codex-contract.md)、[KPI](../kpi.md)和[威胁模型](../threat-model.md)。先前工作仅用于启发概念；未复制任何第三方项目代码。
