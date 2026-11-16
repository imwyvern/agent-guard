# 零代码入口：面向防护者与运维者

> 状态：2026-11-16（HKT），v0.5b 第一批 E-1 / E-3 / E-4 已实现，**unreleased**。E-2 Docker 与 E-5 Workers 模板 / Helm 仍未实现。零运行时依赖，Node ≥20。
> 从源码构建后使用 `node dist/cli/main.js`（或 `npx tsx src/cli/main.ts`）。只有 npm 发布后才可使用 `npx @imwyvern/agent-guard`；发布仍需 Dan 单独批准，当前没有 npm 发布或 tag。

## 1. 入口与状态

| 入口 | 状态 | 用途与边界 |
| --- | --- | --- |
| **E-1 proxy 反向代理 / 边车** | 已实现 / unreleased | 单一固定 HTTP(S) 上游；检测异常 fail-open；默认只监听回环；detect / alert-only |
| **E-2 Docker 镜像及配置片段** | planned / 未实现 | 镜像、Compose、nginx、Caddy、Traefik 片段留待下一批，DI-8 尚未验收 |
| **E-3 init 接入向导** | 已实现 / unreleased | 检测 Express/Fastify/Koa/Hono/Next；无匹配时使用 Node HTTP；默认只打印补丁 |
| **E-4 HTTP access-log watch** | 已实现 / unreleased | 只读 combined/common/JSON，检测已注册诱饵路径及路径/查询里的 canary；与 Linux 读取日志模式互斥 |
| **E-5 Workers 模板 / Helm** | planned / 未实现 | 已有 Web core / Edge adapters 与 [接入文档](edge.md)，不代表模板与 chart 已交付 |

真实 AI agent 评测也仍 planned，模型预算未设定，迷宫模拟字节比仍为 1:1。见 [实施规划](plan-v0.5-v0.7.md)。

## 2. proxy：固定上游、默认回环、fail-open

```sh
node dist/cli/main.js proxy --upstream http://127.0.0.1:3000 --init-secrets
node dist/cli/main.js proxy --upstream https://origin.example --config ./agent-guard.config.json --listen 127.0.0.1:8080 --timeout-ms 30000
```

- `--upstream` 只接受 HTTP(S) **origin**，不接受用户名、密码、路径、query 或 fragment。只有此固定目标会收到代理流量；请求 Host、绝对 URI、`//` 路径、query 参数不能改变连接目标。上游响应的重定向作为普通响应回传，不主动跟随。`CONNECT` 与协议 Upgrade 返回 405，不提供隧道。
- 方法、路径、查询、二进制 body、状态、端到端头及响应 body 原样转发。RFC 9110 §7.6.1 的 hop-by-hop 头（含 Connection 点名的字段）被移除；重复 Set-Cookie 保留。Node HTTP 负责重新分帧；**不追加 Via**，不自动改写 Host，不追加转发 IP 头，不做上游响应/robots/llms 的内容变换。
- 复用 Node `toRequest`、core inspect 与原有 D1–D5 响应。`/mcp` 的 JSON `tools/call` 使用已注册 decoy tool；`/graphql` 通过既有 GraphQL helper 识别 decoy field。真实工具/查询继续转发；不会把所有 MCP/GraphQL 请求当作诱饵。非默认场景端点仍由宿主适配器接入。
- 检查错误或超时 **fail-open**，默认计算预算 50 ms；通过现有 `alert_failed` 错误事件通道向 stderr 发一条固定诊断：`alert.channel: "proxy"`、`signals: ["proxy_inspect_error"]`。不包含错误堆栈、请求 body 或 secret。已有 D5 的 300–600 ms 故意登录延迟独立于计算预算，D5 最大等待为 650 ms；迟到的 inspect 结果不再写响应。
- 上游连接失败返回 **502**，恢复后继续服务；`--timeout-ms` 为整个上游请求/响应的 deadline，默认 30000 ms，超时返回 **504**。已发出响应头后的上游中断/超时只能断开流。代理不是高可用流量路由器；失败不会尝试其他目的地。
- 默认 `127.0.0.1:8080`。`--listen 0.0.0.0:8080`、`--listen '[::]:8080'` 或其他非回环 IP 必须同时带 `--allow-public-bind`，并向 stderr 打印警告。监听地址必须是 IP literal，避免主机名解析意外公开服务。IPv6 回环 `--listen '[::1]:8080'` 不需要公开绑定开关。
- 不信任 `X-Forwarded-For` / `Forwarded`。可重复 `--trusted-proxy 127.0.0.0/8 --trusted-proxy 10.0.0.0/8`：从 socket 向左遍历 XFF，遇首个不可信 hop 停止；无效 hop 停止。`Forwarded` 不参与客户端 IP 选择。入口必须清洗自己管理的头并禁止绕过。
- 检查只保留前 **16 KiB**，等待上传窗口最多 50 ms；后续 body 流式转发并使用背压，不整体缓冲。慢速/截断 JSON 按有界文本检查；这可能漏掉后续字段、canary 或场景选择。与库相同，普通 body 检查限于配置的 `canaryScan.bodyPaths`；D5 与场景 helper 始终检查有界 body。
- `AGENT_GUARD=off` 纯透传，不 inspect。CLI 不接受 `--mode`，配置只允许 `detect`；`trap` 与 `block` 配置会被拒绝，原库配置校验不放宽。proxy 和 HTTP-log 模式固定使用未验证 `ua-bypass`，不新增 DNS / DoH；伪装 crawler UA 可能绕过代理诱饵，这是避免 SEO 自伤的取舍。
- SIGINT/SIGTERM 停止接受新连接，等待在途请求和告警关闭，上限 **5 s**，之后关闭剩余连接。

## 3. 配置、密钥与本地自测

`init` 生成的 JSON 没有密钥值，使用完整字符串形式的环境引用（仅展开 `${AG_*}`）：

```json
{
  "project": "local-project",
  "env": "local",
  "mode": "detect",
  "projectSeed": "${AG_PROJECT_SEED}",
  "canary": {
    "secret": "${AG_CANARY_SECRET}",
    "registry": { "version": 1, "prefix": "AG-CANARY-", "canaries": [] }
  },
  "crawler": { "verify": "ua-bypass" }
}
```

未传 `--config` 时使用上述默认配置（若当前目录存在 `agent-guard.config.json` 则读取它）。通常由运营者的环境注入 `AG_CANARY_SECRET`、`AG_PROJECT_SEED`。显式 `--config` 不存在时默认拒绝，只有 proxy 的 `--init-secrets` 可开启首次运行路径。

当配置不存在且带 `--init-secrets`，在其目录内独占创建 `.env`（0600），生成 `AG_CANARY_SECRET`、`AG_WEBHOOK_SECRET` 与 `AG_PROJECT_SEED`，从不覆盖已有 `.env` 或打印值。仅载入这三个名字的 64 位 hex 绑定，不执行 shell、不自动读取其他 dotenv 内容；现有进程环境优先。配置文件本身不会被隐式创建或改写。已有 `.env` 若不含这些格式的绑定，应由运营者正常注入环境。配置已存在时不自动载入 `.env`。

默认 JSONL 事件输出到控制台；可配置现有 Node `log.file`。只有显式同时提供 `AG_ALERT_WEBHOOK_URL` 与 `AG_ALERT_WEBHOOK_SECRET`（或 `AG_WEBHOOK_SECRET`）才启用签名 webhook。proxy 与 watch 不自动安装其他通知通道。已有库的 Slack/Telegram/飞书/SMTP API 不变。

启动后打印以下两条自测命令（只含地址与提取指令，不含 secret 值；token 是当场由诱饵返回的 inert canary）：

```sh
curl -s 'http://127.0.0.1:8080/.env'
TOKEN=$(curl -s 'http://127.0.0.1:8080/.env' | sed -n 's/^ADMIN_API_TOKEN=//p'); curl -s -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:8080/api/internal/admin/users'
```

手动端到端冒烟：在另一个终端运行本地 Node HTTP 上游，普通页面经代理应与直连一致；访问 `/.env` 得到 noindex 的假配置及 `decoy_hit` 控制台事件；停止上游后普通页面应为 502。所有 canary 永远不能用来认证。

## 4. init：只读规划，显式写入

```sh
node dist/cli/main.js init --dir ./my-app
node dist/cli/main.js init --dir ./my-app --framework express --write
```

读取 package.json 的 dependencies / devDependencies，不联网、不加载或执行项目代码、不安装依赖。发现多个框架时列出并要求 `--framework`；未发现则生成 Node HTTP 接入片段。支持 express / fastify / koa / hono / node / next。

默认将新增的 `agent-guard.config.json` 和 `agent-guard.setup.ts`（存在 tsconfig.json）或 `.js` 显示为 unified diff，随后打印入口处两行接入说明与可选 `canary scan` pre-commit 示例。JS 对 CommonJS 项目使用 require/exports，对 `type: module` 项目使用 ESM；Next 示例供宿主编译。

`--write` 先显示同样的 diff，再独占创建 0644 文件；已有文件跳过，不备份后覆盖。拒绝父目录穿越、符号链接目录/目标及非普通文件，所有目标固定在 `--dir` 内。不会修改 app.ts、middleware.ts 或 `.git/hooks`，不执行生成的代码。Express 与 Node 片段由真实适配器类型检查验收。

接入片段导出独立的示例 guard；请在项目入口按提示注册，并定制片段的配置，同时维护 JSON 配置的一致性。配置 JSON 供 CLI 使用，片段不会自动加载 JSON。对原生 Node HTTP，应在宿主 request listener 中调用 middleware，并在 next 回调中调用原处理器。关闭应用时停止接收请求并 `await guard.close()`。

## 5. HTTP access-log watch：只读与可见性

```sh
node dist/cli/main.js watch --log ./access.log --format combined
node dist/cli/main.js watch --log ./access.log --format common --from-start
node dist/cli/main.js watch --log ./access.jsonl --format json --config ./agent-guard.config.json --fields '{"path":"request_uri","status":"status","ua":"http_user_agent","ip":"remote_addr","time":"time_iso8601"}'
```

提供相同的环境绑定/注册表/诱饵配置才可正确关联项目 canary。JSON 默认字段是 `path`、`status`、`ua`、`ip`、`time`；`--fields` 可改名。path 可为请求目标或完整 `METHOD target HTTP/version` 请求行；没有方法时按 GET 处理。common/combined 解析 nginx/Apache 标准请求行，combined 还读取 UA；common 没有 UA。status 必须为 100–599；有效日志时间转为 UTC，缺失/无效时间回退到读取时间。

只读匹配：复用注册的 D1–D5 路径/方法和 canary scanner/registry，发出 `decoy_hit` / `canary_replay`，新增可选顶层 `source: "access_log"`。回放扫描只看路径与查询，保留 registry placement；不会调用 core inspect、生成诱饵响应、执行 hooks、触发 trap/block 或赋予 HTTP incident ID。通常没有头与 body，**Bearer / Authorization / Cookie / body 中的回放不可见**。只根据 UA 标注 crawler 声明为 `verified: false`，不做 DNS 反查，无新增出站探测；只有运营者显式配置的告警 adapter 可出站。

默认从文件末尾读取，`--from-start` 才读历史；每 tick 最多读 1 MiB，默认 500 ms。默认最大行长 16 KiB、每分钟最多 60 个事件；可设 `--max-line-bytes`（1–1048576）、`--max-events-per-minute`（1–100000）、`--interval-ms`（1–60000）。超长行整行丢弃，部分行有界保存；畸形行跳过。inode 更换与截断重置读取位置，速率预算不会随轮转重置。此模式跨平台，只接受普通文件且不跟随符号链接；不会修改日志或配置 nginx。三种输入 `--log` / `--auditd` / `--inotify-log` 互斥；后两者仍为 v0.5a Linux honeyfile 日志模式，见 [seed.md](seed.md)。

## 6. 验收与后续

| 编号 | 已实现证据 |
| --- | --- |
| DI-1 | 1000 个 GET/POST 普通请求，含二进制 body 与分块响应，比较直连与代理字节 |
| DI-2 | 上游关闭 502、恢复后继续转发、deadline 504 |
| DI-3 | inspect 抛错/超时仍转发，固定错误事件 |
| DI-4 | 默认回环；公开绑定显式授权及 stderr 警告 |
| DI-5 | 0600 `.env`、不覆盖、stdout/stderr 无 secret 值 |
| DI-6 | 默认 diff 不写入；显式创建、不覆盖、拒绝穿越/符号链接；接入片段类型检查 |
| DI-7 | combined/common/JSON 诱饵与 canary、普通零事件、畸形/超长/轮转处理 |
| DI-8 | **planned**：Docker 非 root、只读根文件系统、SBOM，下一批验收 |

证据：[proxy 测试](../test/integration/proxy.test.ts)、[init 测试](../test/unit/init.test.ts)、[access-log 测试](../test/unit/access-log.test.ts)、[v0.5b 合同](codex-contract-v0.5b.md)。默认配置延迟沿用原门槛；proxy 额外开销仅报告，见 [本轮验证记录](bench-v0.5b.md)。不提供 `curl | sh`，不要求 root；当前不交付镜像、部署或供应链发布产物。后续 npm/provenance/SBOM 仍依照 [release checklist](release-checklist.md) 单独批准。
