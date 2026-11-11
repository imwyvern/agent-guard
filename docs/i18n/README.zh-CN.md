# agent-guard

An AI-agent honeypot middleware for Node and the edge.

（面向 Node 与边缘运行时的 AI agent 蜜罐中间件。）

[English](../../README.md) | [简体中文](../i18n/README.zh-CN.md) | [繁體中文](../i18n/README.zh-TW.md) | [日本語](../i18n/README.ja.md) | [한국어](../i18n/README.ko.md) | [Español](../i18n/README.es.md)

## 为什么需要它

攻击者现在用 AI agent 探测服务器、读取配置，并重放它们找到的密钥。agent-guard 在应用的 HTTP/API 层埋入隔离的假配置、假密钥和假端点——无法解锁任何真实权限的惰性金丝雀。当攻击者的 AI 触碰到它们时，你会得到一条高置信度的早期告警，以及一段可以响应的时间窗口：轮换密钥、收紧访问，或将主机下线。

这是服务器层面的最后一道行程绊线与早期预警 / 延迟层。它不能替代补丁、WAF 或最小权限。默认模式仅检测并告警。可选且默认关闭的 trap 模式可以拖慢或限流已确认的客户端；它并不声称能阻断攻击。

**今天交付了什么，什么还没有。**

- **今天**覆盖的是 HTTP/API 层：五条隔离的诱饵路由、MCP 与 GraphQL 诱饵，以及惰性金丝雀凭证（`AG-CANARY-…`）。零运行时依赖；在 Node ≥20 上提供 Express、Node `http`、Hono、Fastify 与 Koa 适配器，以及 v0.4b 的 Web / Edge 适配器（尚未发布）。
- **主机层 honeyfile**（磁盘上的假 `.env`、云凭证、SSH 密钥或 kubeconfig，并在被访问时告警）是**规划中**的能力，尚未交付。未来的 `agent-guard seed` 命令见[路线图](../roadmap.md)。
- **「假成功」欺骗**——一套可能让攻击者的 AI 误以为已入侵成功的仿真环境——是**规划中**的能力（必须 opt-in，并先做安全评估），尚未交付。见 [deception.md](../deception.md)。
- **消耗攻击者的 token** 目前**尚未得到验证**。实验性迷宫在模拟中的字节比为 1:1，低于 3:1 下限；时间比数字来自 25 ms/request 模型，不是对真实 LLM agent 的测量。在完成这项测量之前，不要指望启用迷宫就能消耗对方 token。见 [exhaust.md](../exhaust.md) 和 [trap-mode.md](../trap-mode.md)。
- 金丝雀始终 inert。本项目从不使用真实凭证，从不做反向提示注入，也从不主动出站探测。它不会反击。

**它是什么 / 不是什么。** agent-guard 用于检测、诱捕并观察针对你的 API 的敌对或探测性 AI agent 流量。它不会反击或攻击任何人。非目标、可选功能与实验性限制见[它不是什么](#它不是什么)。

这是一个开源研究项目，尚未发布到 npm。请从源码安装，或使用 `npm pack` 生成本地 tarball。当前包名为 `@imwyvern/agent-guard`。Apache-2.0，版权 2026 Wesley Wang。

请参阅[安全策略](../../SECURITY.md)、[贡献指南](../../CONTRIBUTING.md)、[定位说明](../positioning.md)和[路线图](../roadmap.md)。

## 路线图：接下来往哪里走

除另有说明外，下列事项均为规划中，尚未交付：

- **主机层 honeyfile** — `agent-guard seed` 在磁盘上放置惰性的假 `.env`、云凭证、SSH 密钥和 kubeconfig，并在被访问时告警。
- **假成功仿真环境** — 必须 opt-in，并先做安全评估：一套可能让攻击者的 AI 把假数据当成真数据的仿真服务面。见 [deception.md](../deception.md)。
- **响应时间窗口** — 面向运营者的 incident 时间线、dwell-time 指标，以及挂钩到运营者自己的密钥轮换 / 阻断脚本。进程内 incident 关联和 `dwell_ms` 已经交付；面向运营者的时间线与挂钩尚未交付。
- **隔离诱饵主机** — 与生产应用进程分离的独立诱饵环境。
- **真实 agent 的 token 成本评估** — 在任何人启用实验性迷宫之前，先测量它是否真的消耗真实 AI agent 的 token。当前 1:1 的字节比只是假设。
- **Edge 适配器（v0.4b）** — **已交付（尚未发布）**：Web-standard core、Cloudflare Workers、Next.js middleware / Vercel Edge、Deno、Bun 和 Hono-web。

详细计划见 [docs/roadmap.md](../roadmap.md)。范围边界与诚实声明见 [docs/positioning.md](../positioning.md)。

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

v0.2 的 Hono 适配器以 `@imwyvern/agent-guard/hono` 提供，并带可选的 `hono` peer。它要求 Node ≥20：Node 核心使用 `node:crypto` 和 Node DNS。在 Workers/Bun/Deno 上，请使用 `@imwyvern/agent-guard/hono-web` 和 `@imwyvern/agent-guard/web` 的 `createWebGuard`（v0.4b，尚未发布）。

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

默认 `mode: 'detect'` 下仍仅检测并告警：金丝雀重放会继续到达宿主，诱饵带有 noindex/no-store 头，已验证的爬虫会到达宿主原生的缺失路由处理。可选的 robots/HTML/llms 变换保留现有的 1 MiB 缓冲上限。运行 `npm run demo:hono`（`PORT` 和 `AGENT_GUARD=off` 的用法与其他目录演示相同）。Hono 运行与 Express 和 Node 相同的共享验收套件。

## Fastify 与 Koa（Node 运行时）

v0.3a（未发布）新增 `@imwyvern/agent-guard/fastify` 与 `@imwyvern/agent-guard/koa` 的 `agentGuard`，接受相同的 guard 或 config。在路由之前通过 `await app.register(agentGuard(guard))` 注册 Fastify 插件；检查在请求体解析后的 `preHandler` 中执行。Koa 使用 `app.use(agentGuard(guard))`，放在有界请求体解析器之后。两个适配器均不消费请求流，并保留宿主原生的爬虫 404、detect 模式下仅告警的重放检测和可选 lure 变换；框架为可选 peer，核心不增加运行时依赖。见 [Fastify 演示](../../examples/fastify-demo/server.ts)、[Koa 演示](../../examples/koa-demo/server.ts)和[适配器指南](../community.md)。

## Edge / Web runtimes

v0.4b 已在此**尚未发布的代码树**中实现，零运行时依赖。请从 git/源码或本地 `npm pack` tarball 安装；包尚未发布到 npm。Web 入口使用 WebCrypto 和宿主的结构化类型；适配器不导入 `next` 或 `hono`。

`createWebGuard(config)` 返回 Web guard；`await guard.handle(request, ctx?)` 在拦截时得到 `Response`，放行给宿主时得到 `null`。

| 运行时 | `@imwyvern/agent-guard` 后的导入后缀 | 客户端 IP |
| --- | --- | --- |
| Web 标准宿主 | `/web`（`createWebGuard`） | 宿主 `ctx.clientIp` 或显式 `ipHeader`；否则为 `unknown` |
| Cloudflare Workers | `/workers`（`fromEnv`、`withAgentGuard`） | `fromEnv` 默认使用 `CF-Connecting-IP` |
| Next.js middleware / Vercel Edge | `/next`（`agentGuardMiddleware`） | 运营者必须设置 `ipHeader` |
| Deno | `/deno`（`denoHandler`） | `remoteAddr.hostname` |
| Bun | `/bun`（`bunHandler`） | `server.requestIP(request)` |
| 边缘上的 Hono | `/hono-web`（`honoWeb`）+ `/web` | 在 Web guard 上显式设置 `ipHeader` |
| Node ≥20 上的 Hono | `/hono`（`agentGuard`）+ 根入口的 Node 核心 | 套接字 IP；受信任的 `clientIp` 覆盖 |

下表适用于 `/web` 和上面的五个 Web 适配器，包括 Bun/Deno 上的 Hono。`/hono` 保留 Node 核心（`node:crypto` / Node DNS）。

| 功能 | Web 核心 / Workers / Next / Deno / Bun / Hono-web | Node 上的 Hono（`/hono`） |
| --- | --- | --- |
| 无状态功能 | 诱饵路由、金丝雀生成/重放检测、HMAC 无状态迷宫**节点**、fetch 告警、Prometheus（单 isolate 视角） | 可用；指标按进程统计 |
| incident 关联、rateLimit、block、节奏分数、迷宫会话准入 | 需要 `StateStore`；无 store → 自动关闭，每个 guard 给出一次控制台警告。`memoryStore()` 仅限单 isolate，从不代表全局 | 有界的进程内状态 |
| 爬虫策略 | 默认 `ua-bypass`：自称 Googlebot/Bingbot 等已识别搜索爬虫的客户端永不进入 trap/maze/block；`crawler.verified: false`。允许 `custom` 验证器。不做 DNS / DoH | Node DNS 验证或配置的策略 |
| `trap.delay` | 默认关闭；边缘按墙钟时间计费，不建议启用；显式开启时上限 3000 ms | 默认关闭，须主动启用 |
| 转发头 | 未配置的头不受信任；显式配置 `x-forwarded-for` 时取最右侧非空一跳，需要可信代理 | 显式受信任的 `clientIp` 回调 |
| SMTP | 不可用；改用基于 fetch 的 webhook / Slack / Telegram / 飞书 | 仅 Node 提供 SMTP |

所有运行时的 trap 均默认关闭。没有 store 时，签名迷宫节点不会授予会话准入；迷宫仍为实验性功能（模拟字节比 1:1）。持久 store 由运营者提供。StateStore 示例、完整降级表与故障排查见 [Edge 运营指南](../edge.md)。本 README 后续的配置和告警示例描述的是 Node API。

**Workers** — 通过环境绑定提供 `AG_CANARY_SECRET` 和 `AG_PROJECT_SEED`；`fromEnv(env)` 会拒绝缺失/空值，没有默认密钥。此最小示例没有 StateStore。

```ts
import { fromEnv, withAgentGuard } from '@imwyvern/agent-guard/workers';
import type { WebContext, WebGuard } from '@imwyvern/agent-guard/web';

let guard: WebGuard | undefined;
export default {
  fetch(request: Request, env: Record<string, unknown>, ctx: WebContext) {
    // Bind AG_CANARY_SECRET and AG_PROJECT_SEED in the host environment.
    guard ??= fromEnv(env);
    return withAgentGuard(guard, {
      fetch: () => new Response('Hello'),
    }).fetch(request, env, ctx);
  },
};
```

**Next.js / Vercel Edge** — `middleware.ts`；配置可信入口代理会覆盖的头。适配器拦截时返回 `Response`，放行时返回 `undefined`，不导入 `next`。

```ts
import { createWebGuard } from '@imwyvern/agent-guard/web';
import { agentGuardMiddleware } from '@imwyvern/agent-guard/next';

const secret = process.env.AG_CANARY_SECRET;
const projectSeed = process.env.AG_PROJECT_SEED;
if (!secret || !projectSeed) throw new Error('Set AG_CANARY_SECRET and AG_PROJECT_SEED');
const guard = createWebGuard({
  project: 'catalog', env: 'production', mode: 'detect', projectSeed,
  ipHeader: 'x-real-ip', // Only trust a header overwritten by your ingress.
  canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
});
export const middleware = agentGuardMiddleware(guard);
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|assets/).*)'],
};
```

**Deno** — 在本地消费端安装 tarball，并使用 Deno 2 的 `nodeModulesDir: "manual"`；允许读取这两个环境绑定及服务器网络访问。

```ts
import { createWebGuard } from '@imwyvern/agent-guard/web';
import { denoHandler } from '@imwyvern/agent-guard/deno';

const secret = Deno.env.get('AG_CANARY_SECRET');
const projectSeed = Deno.env.get('AG_PROJECT_SEED');
if (!secret || !projectSeed) throw new Error('Set AG_CANARY_SECRET and AG_PROJECT_SEED');
const guard = createWebGuard({
  project: 'catalog', env: 'production', mode: 'detect', projectSeed,
  canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
});
Deno.serve(denoHandler(guard, () => new Response('Hello')));
```

**Bun** — 适配器从服务器取得连接 IP。

```ts
import { createWebGuard } from '@imwyvern/agent-guard/web';
import { bunHandler } from '@imwyvern/agent-guard/bun';

const secret = Bun.env.AG_CANARY_SECRET;
const projectSeed = Bun.env.AG_PROJECT_SEED;
if (!secret || !projectSeed) throw new Error('Set AG_CANARY_SECRET and AG_PROJECT_SEED');
const guard = createWebGuard({
  project: 'catalog', env: 'production', mode: 'detect', projectSeed,
  canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
});
Bun.serve({ fetch: bunHandler(guard, () => new Response('Hello')) });
```

**边缘上的 Hono** — 此 Workers 示例使用相同的必填绑定。在 Bun/Deno 上用 `createWebGuard` 创建 Web guard，并按宿主配置可信的 `ipHeader`。请在消费应用中安装 Hono。

```ts
import { Hono } from 'hono';
import { fromEnv } from '@imwyvern/agent-guard/workers';
import { honoWeb } from '@imwyvern/agent-guard/hono-web';
import type { WebGuard } from '@imwyvern/agent-guard/web';

let guard: WebGuard | undefined;
const app = new Hono<{ Bindings: Record<string, unknown> }>();
app.use('*', (c, next) => honoWeb(guard ??= fromEnv(c.env))(c, next));
app.get('/', c => c.text('Hello'));
export default app;
```

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

## GraphQL 与纯 API 场景

v0.3a 导出 `graphqlDecoys()` 与 `inspectGraphqlRequest(guard, request)`。将返回的字段/类型元数据加入宿主 schema，让 introspection 列出 `internalAdminUsers`；在有界请求体解析之后、执行之前检查一次。选中诱饵会发出 `decoy_hit`（`decoy.id: "GQL"`），并返回带 noindex/no-store 的标准 GraphQL `FORBIDDEN` 错误；该请求不会执行真实 resolver。诱饵本身也应配置惰性的错误 resolver。真实查询继续交给宿主；格式错误或超限的查询交给宿主验证器。已验证爬虫到达宿主原生 404。见 [GraphQL 演示](../../examples/graphql-demo/server.ts)，运行 `npm run demo:graphql`。

没有 HTML 的 API 请参阅[纯 API 指南](../scenarios/api-only.md)：将惰性金丝雀放在 OpenAPI `example`、诱饵错误的 `docs_url` 和隔离的 `/.well-known/` 文件中，并说明 SDK 与文档客户端的误报边界。

## 配置

每个公开字段的默认值记录在 [src/types.ts](../../src/types.ts)。必填字段：`project`、`env`、`mode: 'detect'`、`projectSeed`，以及 `canary.secret`/`canary.registry`。

| 选项 | 默认值 / 行为 |
| --- | --- |
| `canary.prefix` | `AG-CANARY-`；模式 `^[A-Z][A-Z0-9]{1,15}-CANARY-$` |
| `canary.registry` | 必填的 version-1 对象或 JSON 路径；其中不存储任何 secret |
| `incident.windowMs` | 900000；固定 15 分钟关联窗口，0 关闭；仅附加元数据 |
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
| `alerts.adapters` | 无默认目的地；提供 webhook、console、Slack、Telegram、飞书与 SMTP/email adapters |
| `alerts.minSeverity` | 诱饵/重放为 `info`；显式取值还会启用 probe/discovery 升级 |
| `alerts.dedupeWindowSec` | 600；同一事件 + placement/ID + client key |
| `alerts.ratePerMinute` | 每通道 30；被抑制的计数会带到下一条告警摘要中 |
| `alerts.redactIp` | `true`；告警中使用粗糙的 IPv4/IPv6 网段 |
| `log.sink` / `level` / `keepIp` | stdout JSONL / `info` / `true` |
| `clientIp` | 套接字 IP；仅在校验受信任代理之后再覆盖 |
| `onEvent` | 可选观察者；观察者/sink 失败会被隔离 |

`guard.robotsLines()` 支持手动 robots 集成。`guard.htmlCommentFor(path)` 返回可选注释或 null。`guard.metrics()` 返回请求/事件/投递计数，以及有界的近期 inspect 时延分位数。节奏分数只作按实例的有界观测；检测分可用于 opt-in trap 闸门。客户端状态：50k 条目，30 分钟空闲 TTL；爬虫缓存：10k，阳性 24h / 阴性 1h。任何转发头都不会被自动信任。

detect 模式下，D5 始终拒绝登录，并带有确定性的 300–600ms 延迟。所有诱饵均为 `noindex`、`no-store`，≤8KiB，默认使用 `.invalid` 假主机名（显式配置的自托管 callback URL 除外），且从不创建 cookie、进行认证或调用业务服务。已声明的 AI 爬虫诱饵命中严重级别为 `info`。detect 下搜索爬虫 DNS 检查在诱饵路由上进行；opt-in trap 和 callback handler 扩展验证范围以保持爬虫免疫。错误/超时会失败开放到原生 404。

## 事件关联与金丝雀传播追踪

v0.3a 为同一 `client_key` 的既有事件附加可选 `incident`：`id`、有序 `sequence`（例如 `robots → D1 → D2`）、`first_seen`、`last_seen` 和 `confidence`。`incident.windowMs` 默认为 900000（从首次观察起固定 15 分钟）；0 关闭关联。状态使用 50k 客户端 LRU，保留最近 32 次观察。重复的孤立命中置信度为 low；不同诱饵或发现加诱饵升为 medium；`canary_replay` 升为 high。同一窗口内置信度不会降低。robots 访问仅作内部标记，不增加事件类型。共享网络可能合并客户端；关联不提升严重级别；默认 detect 下保留 HTTP 响应和诱饵决策，v0.4a opt-in trap 可将 high confidence 用于闸门。verified crawler 与 allowlist 始终免疫。见 [trap 模式](../trap-mode.md)。

重放告警保留 `canary.id`、`placement`、`env`、`found_in`、`field`，新增 `leaked_at`（放置位置）、`replayed_at`（路径）、`dwell_ms`（首次诱饵下发至重放的时间）和 `client_keys_seen`（不同重放客户端键的数量，上限 8）。仅当返回的诱饵响应体包含令牌时记录下发；HEAD 与爬虫绕过不计。追踪仅存在于进程内，使用 50k 条目 LRU 和 24 小时 TTL。淘汰、重启或内置诱饵之外的下发会使时间未知，因此省略 `dwell_ms`。这些观察不能证明身份或恶意意图。

## 告警与签名

除 webhook 与 console 外，现已提供 `slackAdapter`、`telegramAdapter`、`feishuAdapter` 与 `smtpAdapter`。目的地与凭据必须显式配置，默认均不开启，零新增运行时依赖。新增 HTTP adapters 除 loopback 外要求 HTTPS，拒绝重定向；SMTP 支持 465 隐式 TLS、587 STARTTLS 与 AUTH PLAIN/LOGIN。它们共用下述队列、去重、限流与 `close()` 刷新。

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
node dist/cli/main.js lint ./config
```

`agent-guard lint <path>`（或上面的已构建 CLI）检查内置诱饵/lure 输出与放置文件中的祈使语句、隐藏字符、非保留 URL 主机名和真实厂商密钥前缀。发现问题退出 1；用法错误退出 2。它检查放置安全性；令牌意外泄漏另用 `canary scan` 检查。

创建注册表时，`canary new` 也接受 `--prefix ACME-CANARY-` 以及 `--registry <file>`。当规范前缀或注册表令牌出现在注册表/`src/decoys/*.ts` 白名单之外时，扫描以退出码 1 退出并输出 `file:line`；用法错误以退出码 2 退出。符号链接以及 `.git`、`node_modules`、`dist`、`coverage` 会被跳过。请扫描目标配置目录，以避免命中文档/测试中有意放置的示例。注册表精确匹配允许密钥轮换后仍识别旧令牌。`report` 汇总观察到的事件/投递延迟；误报率/检测率需要带标注的模拟会话。

采用方项目的 CI 步骤示例（仅使用已构建的 CLI）：

```yaml
- name: Prevent canaries in real configuration
  run: node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
```

## 演示与基准测试

```sh
npm run demo:express
npm run demo:hono
npm run demo:fastify
npm run demo:koa
npm run demo:graphql
npm run demo:mcp
PORT=3001 npm run demo:node
AGENT_GUARD=off npm run demo:express
npm run bench:simulate
npm run bench:exhaust-sim
npm run bench:deception-lint
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

自 v0.3b 起，`npm run bench:exhaust-sim` 在内存中用脚本化的贪婪 agent 对有界迷宫做成本比模拟，`npm run bench:deception-lint` 则对现有诱饵输出和确定性人设原型做安全扫描。这两条命令不会开启 trap；v0.4a 已另行实现 opt-in trap 与实验性迷宫。见 [v0.3b 离线评估](../bench-v0.3b.md)。

## 它不是什么

它不是 WAF、DDoS 防护、认证系统或通用机器人拦截器。它不能替代补丁、最小权限或密钥卫生。本研究项目不提供生产部署，也不保证搜索引擎行为。

主机层 honeyfile 与「假成功」欺骗是规划中的能力，尚未交付。消耗攻击者的 token 尚未得到验证。见[定位说明](../positioning.md)和上文的[路线图列表](#路线图接下来往哪里走)。

反向提示注入 / counter-injection（E4）永不进入产品。不做出站探测，也不由 guard 主动向第三方回连；运营者配置的告警 adapters 是唯一的出站通知例外，既有爬虫身份 DNS 校验不变。金丝雀始终是 inert HMAC 令牌，不是真实厂商凭证。不使用第三方 honeytoken 服务（Canarytokens 等）；callback canary 仅由运营者自托管。

Edge / Web 运行时**已在尚未发布的 v0.4b 代码树中支持**。持久状态须由运营者提供 store：没有 `StateStore` 时，incident 关联、rateLimit、block、节奏分数和迷宫会话准入均关闭，并给出一次警告；`memoryStore()` 仅限单 isolate。爬虫默认使用未经验证的 `ua-bypass`（无 DNS / DoH）；SMTP 仅限 Node；`trap.delay` 默认关闭，边缘不建议启用，显式开启时上限 3000 ms。见 [Edge 运营指南](../edge.md)。

v0.4a 已实现以下**显式 opt-in、默认关闭**的集成与控制；默认仍为 `mode: 'detect'`：

- Slack、Telegram、飞书和 SMTP/email 告警 adapters，零新增运行时依赖、无默认目的地。
- `guard.prometheusText()` / `prometheusHandler(guard)` 文本导出器，不默认挂载端点、无路径 label。
- `mode: 'trap'`，`delay`、`rateLimit`、`block` 与**实验性** `maze` 独立开关；verified crawler 与 allowlist 永不被 trap。
- `canary.callback.baseUrl` + `callbackHandler(guard)` 自托管回调金丝雀。handler 必须显式挂载，guard 永不 fetch `baseUrl`。

机械节奏 `automation_score` 也已实现，但仅用于观测：不提升严重级别，不单独触发 block/maze。当前代码在样本足够后自动产生分数，没有独立启用开关。

**实验性迷宫**应在运营者完成自己的真实 agent 测量后才考虑启用。[v0.3b 离线模拟](../bench-v0.3b.md) 中，脚本 agent 在 **25 ms/request** 模型下的时间比为数百比一，但**字节比为 1:1，低于 3:1 下限**，不能证明真实 agent 的成本收益。配置与风险见 [trap-mode.md](../trap-mode.md) 和 [Exhaust](../exhaust.md)。

## 路线图与设计文档

- [定位说明](../positioning.md) — 项目叙事、范围边界，以及诚实声明表（声明 / 状态 / 证据）。
- [社区参与](../community.md) — 如何贡献适配器、检测特征、译本和 RFC。
- [路线图](../roadmap.md) — 前进方向、v0.4a/v0.4b 完成项（尚未发布）与 v0.5+ 计划；persona/deception 扩展仍属设计。
- [Edge 运营指南](../edge.md) — 运行时接入、StateStore 示例、降级与故障排查。
- [Exhaust](../exhaust.md) — 已实现的 opt-in 延迟与实验性迷宫；上下文消耗（E3）尚未实现；消耗 token 尚未得到验证。
- [Deception](../deception.md) — 提高诱饵数据的可信度，让攻击者的 agent 可能把它当成真实数据；「假成功」是规划中的能力，尚未交付。
- [设计](../design.md)、[合同](../codex-contract.md)、[KPI](../kpi.md)和[威胁模型](../threat-model.md)。先前工作仅用于启发概念；未复制任何第三方项目代码。
