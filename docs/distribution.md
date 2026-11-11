# 一键入口设计：面向防护者与运维者（设计草案）

> 状态：设计草案，未实现。目标：不会写代码的运维者和不想改应用的团队，也能在几分钟内装上并看到第一条告警。
> 注意：npm 上无作用域的 `agent-guard` 已被他人占用，我们所有命令都使用带作用域的名字 `@imwyvern/agent-guard`。

## 1. 入口形态（按优先级）

| 入口 | 谁用 | 命令 / 形态 | 风险 |
| --- | --- | --- | --- |
| **E-1 反向代理 / 边车** | 运维者，任意语言后端 | `npx @imwyvern/agent-guard proxy --upstream http://127.0.0.1:3000` | 进入数据通路 → 必须 fail-open、超时、默认只绑 `127.0.0.1` |
| **E-2 Docker 镜像** | 运维者 | `docker run -p 8080:8080 -e UPSTREAM=http://host:3000 ghcr.io/imwyvern/agent-guard`；附 Compose、nginx、Caddy、Traefik 配置片段 | 镜像供应链 → 固定基础镜像摘要、无 root、只读文件系统、SBOM |
| **E-3 init 向导** | 开发者 | `npx @imwyvern/agent-guard init`：检测 Express/Fastify/Koa/Hono，生成接入片段、配置、`canary scan` 的 pre-commit 钩子 | 改用户文件 → 默认只打印补丁，`--write` 才落盘，且先备份 |
| **E-4 日志模式** | 不想碰流量的生产运维 | `agent-guard watch --log /var/log/nginx/access.log --format combined`：只读日志，命中诱饵路径或回放假密钥则告警 | 日志不含请求头/请求体 → 只能做路径和 Bearer 以外的检测，文档写明能力边界 |
| **E-5 Workers / Helm** | edge、K8s 用户 | Cloudflare Workers 模板；Helm chart（边车） | 依赖 Web 标准核心（v0.3b） |

## 2. 代理模式的行为约束

- 诱饵路径（D1–D5、MCP、GraphQL）由代理应答；其余请求**原样转发**，不改请求和响应（除 opt-in 的 robots/llms 追加）。
- **fail-open**：代理自身异常、内部超时、或上游不可达时，不得吞掉真实请求；上游不可达则透传上游错误。
- 默认只绑 `127.0.0.1`；监听 `0.0.0.0` 需要显式参数并打印一条警告。
- 不信任 `X-Forwarded-For`，除非显式配置可信代理列表。
- 请求体大小上限沿用 16 KiB 检查窗口，大 body 流式转发，不整体缓冲。
- 仍然是 **alert-only**；`mode` 保持 `detect`。

## 3. 首次运行体验（目标 ≤ 5 分钟）

1. 命令启动，自动生成 `AG_CANARY_SECRET`、`AG_WEBHOOK_SECRET`，写入 `./agent-guard.config.json` 与 `.env`，文件权限 `0600`，**从不打印密钥**。
2. 终端打印一块"自测"提示：用 `curl` 访问假 `/.env`、再回放假 token 的两条命令，让用户亲眼看到一次告警。
3. 默认告警去处是控制台；`--webhook <url>` 一个参数接入签名 webhook（含 Slack/Telegram 适配器，见 issue #5）。

## 4. 安全原则

- 不提供 `curl | sh`；只走 npx、Docker、源码。
- 安装与运行都不需要 root。
- 配置文件、日志不含明文密钥；`init --write` 前必须展示 diff。
- 镜像与 npm 包带 provenance、SBOM；固定依赖版本；`npm audit --omit=dev` 为 0 才能发版。
- 所有入口的默认配置都不会改变宿主响应（除诱饵路径），并有一键 `AGENT_GUARD=off` 旁路。

## 5. 验收（草案）

| 编号 | 用例 | 期望 |
| --- | --- | --- |
| DI-1 | 代理转发 1000 个普通请求 | 响应与直连上游字节一致（除允许的头） |
| DI-2 | 杀掉上游 | 代理透传 502，不崩溃，恢复后继续转发 |
| DI-3 | 代理内部抛错注入 | 请求仍被转发（fail-open），并记录错误事件 |
| DI-4 | 默认启动 | 只监听 127.0.0.1；`0.0.0.0` 需显式参数 |
| DI-5 | 首次运行 | 生成 0600 的密钥文件；日志与终端无明文密钥 |
| DI-6 | `init` 不带 `--write` | 不修改任何文件，只打印补丁 |
| DI-7 | 日志模式喂入含诱饵命中的 nginx 日志样本 | 产生 `decoy_hit` 告警；普通日志零告警 |
| DI-8 | Docker 镜像 | 非 root、只读根文件系统可运行、SBOM 存在 |

## 6. 路线

1. 先做 E-1（代理）+ E-3（init），Node 内置 `http` 实现，零依赖。
2. 再做 E-2 镜像与配置片段，E-4 日志模式。
3. E-5 等 Web 标准核心。
4. E-1 / E-2 的"一行命令"体验依赖 npm 发布，见 [release-checklist.md](release-checklist.md)。
