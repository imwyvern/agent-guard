# Codex 合同：v0.5b 第一批（`proxy` 反向代理、`init` 接入向导、`watch --log` HTTP 访问日志模式）

- 依据：[plan-v0.5-v0.7.md](plan-v0.5-v0.7.md) §3、[distribution.md](distribution.md) §1–§6（E-1、E-3、E-4，验收 DI-1～DI-7）；每周迭代例行任务 2026-11-16（HKT）。
- 约束：Node ≥20，TS strict，**运行时依赖仍为 0**（只用 Node 内置 `http` / `net` / `fs` / `crypto`）；不加 CI / GitHub Actions / CodeQL，不打 tag，不发 npm，不改包名，不 force-push；**默认 `mode: 'detect'`、alert-only，不新增任何自动拦截**；未使用新命令时库的默认行为与 v0.5a 字节一致；现有测试不得减少，现有断言不得改动。
- 范围外（本合同不做）：Docker 镜像与 Compose / nginx / Caddy / Traefik 片段（DI-8，下一批）、真实 AI 代理评测框架（Issue #11，模型预算待 Dan 决定）、假成功（v0.6）、蜜罐机（v0.7）、Workers 模板 / Helm（E-5）、Web Bot Auth 验证。
- 发布前用法：所有示例写 `node dist/cli/main.js <cmd>`（或 `npx tsx src/cli/main.ts`），并注明 npm 发布后才可用 `npx @imwyvern/agent-guard`（发布仍需 Dan 单独批准）。

## 1. `agent-guard proxy`（E-1，反向代理 / 边车）

CLI：`agent-guard proxy --upstream <http://host:port> [--listen 127.0.0.1:8080] [--allow-public-bind] [--config <agent-guard.config.json>] [--trusted-proxy <cidr>...] [--timeout-ms 30000]`。

行为：
- 用 Node 内置 `http` 实现；复用现有 Node 适配器 / core 的 inspect 与诱饵应答（D1–D5、MCP、GraphQL 等已注册诱饵），**不复制一套检测逻辑**。诱饵路径由代理应答；其余请求**原样转发**（方法、路径、查询、头、body），响应原样回传；只允许去除 hop-by-hop 头（`connection`、`keep-alive`、`transfer-encoding`、`upgrade` 等按 RFC 9110 §7.6.1）并追加 `via`（可选，默认不加也行，但须在文档写明）。
- `--upstream` 只接受 `http:` / `https:` URL；仅允许单一固定上游，**不得**根据请求内容（Host 头、绝对 URI、查询参数）改变转发目标（防开放代理 / SSRF）；拒绝 `CONNECT`。
- **fail-open**：inspect 抛错或超时（内部预算，默认 50 ms）时请求照常转发，并记录一条错误事件（console / 现有 alert 管道，`type` 复用现有错误通道或新增向后兼容的 `proxy_error`，schema 同步）；上游不可达时返回 502（不崩溃），上游恢复后继续转发；上游超时 `--timeout-ms` 返回 504。
- 默认只监听 `127.0.0.1`；监听 `0.0.0.0` / `::` 等非回环地址必须带 `--allow-public-bind`，并向 stderr 打印一条警告；不带该参数时拒绝启动并以非零码退出。
- 不信任 `X-Forwarded-For` / `Forwarded`，除非用 `--trusted-proxy` 显式配置（沿用现有 trusted proxy 语义）。
- 请求体：检查窗口沿用现有 16 KiB 上限；大 body **流式转发**，不整体缓冲；内存有界。
- `AGENT_GUARD=off`（或现有 kill switch）时纯透传，不 inspect。
- 只有 detect 模式：proxy 子命令不接受把 `mode` 改为 block 的参数；配置文件里若出现非 detect 的 mode，按现有配置校验规则处理（不得因 proxy 而放宽）。trap 相关 opt-in 项沿用库语义、默认关闭。
- 首次运行：若 `--config` 指向的文件不存在且带 `--init-secrets`，生成 `AG_CANARY_SECRET` / `AG_WEBHOOK_SECRET` 写入 `.env`（0600，不覆盖已存在文件），**终端与日志从不打印密钥**；随后打印两条本地自测 `curl` 命令（访问 `/.env` 诱饵、回放一个当场生成的 canary 的方式说明，不打印 secret）。
- 优雅退出：SIGINT/SIGTERM 停止接受新连接、等待在途请求（上限 5 s）。

## 2. `agent-guard init`（E-3，接入向导）

CLI：`agent-guard init [--dir <project>] [--framework express|fastify|koa|hono|node|next] [--write]`。
- 读取 `<dir>/package.json` 依赖自动识别框架（多于一个时列出并要求 `--framework`；识别不到时给出 node http 片段）；**只读、不联网、不执行项目代码、不安装依赖**。
- 默认只把将要做的变更以 unified diff 打印到 stdout：新增 `agent-guard.config.json`（不含密钥，只引用环境变量名）、一个接入片段文件（如 `agent-guard.setup.ts|js`，按项目是否有 `tsconfig.json` 决定）、可选 `canary scan` pre-commit 钩子示例（**只打印说明，不改 `.git/hooks`**）。
- `--write`：先打印同样的 diff，再落盘；**绝不覆盖已存在文件**（存在则跳过并提示），新文件权限 0644（配置）；路径必须在 `--dir` 内，拒绝符号链接目标；不修改用户已有源文件（不自动改 `app.ts` 等，只生成新文件并打印"在入口处加入以下两行"的说明）。
- 生成的片段必须能被对应适配器的真实 API 编译/运行（测试里对 express 与 node 片段做一次 typecheck 或实际 import 冒烟）。

## 3. `agent-guard watch --log`（E-4，HTTP 访问日志模式，只读）

CLI：`agent-guard watch --log <access.log> --format combined|common|json [--from-start]`。与 v0.5a 的 `--auditd` / `--inotify-log` 并列、互斥。
- 解析 nginx/Apache combined、common 与每行一个 JSON 对象（字段名可配置的最小集：`path`、`status`、`ua`、`ip`、`time`）。命中已注册诱饵路径 → 发出 `decoy_hit`（字段标注 `source: "access_log"`，schema 向后兼容新增）；请求行/查询串中出现合法 canary（复用现有 canary 识别与 registry）→ `canary_replay`（同样标注来源）。
- 能力边界写进文档：日志通常不含请求头与 body，Bearer/headers 里的回放看不到；verified-crawler 判定在日志模式下只能按 UA 字符串标注为未验证，不做 DNS 反查（不新增出站）。
- 有界：行长上限（沿用 watch 现有上限）、速率上限、日志轮转（inode 变化 / 截断）处理、畸形行不抛错；默认从文件末尾开始，`--from-start` 才读历史。
- 只读：不修改日志、不配置 nginx；无出站，只有运营者显式配置的告警适配器可以出站。不触发 trap/block。

## 4. 文档与多语言（硬性要求）

更新 README.md 与 `docs/i18n/README.*.md` 五个译本（zh-CN、zh-TW、ja、ko、es；代码块逐字一致，相对链接可解析）：新增 "Zero-code entry points (unreleased)" 小节，给出 proxy / init / watch --log 的最小示例与能力边界（fail-open、默认 127.0.0.1、只打印 diff、日志模式看不到头/body），Docker 与评测仍为 planned。更新 CHANGELOG（[Unreleased] 下 Added / Changed，带 HKT 日期）、`docs/distribution.md`（E-1/E-3/E-4 状态从草案改为已实现 / unreleased，E-2/E-5 仍未实现）、`docs/plan-v0.5-v0.7.md` §3 与总览表、`docs/roadmap.md`、`docs/positioning.md` 的「宣称 / 状态 / 证据」表、`docs/threat-model.md`（代理进入数据通路的攻击面：开放代理/SSRF、头部走私、请求体缓冲、绑定地址，及缓解）、`docs/community.md`（如有相关 good first issue 想法）。不改 GitHub issues（关闭/评论由人工处理）。

## 5. 验收

- build / typecheck / lint / test 全绿，通过数不低于 1448（2026-11-16 基线：1448 passed / 4 skipped）且不改动既有断言；`check:neutral` 通过（新代码不得进入 Web 核心依赖闭包）；`bench:deception-lint` 0 违规。
- 新增测试至少覆盖：
  - DI-1：经代理转发 1000 个普通请求（含 GET/POST、二进制 body、分块响应），响应状态/body 与直连上游字节一致（除允许的 hop-by-hop 头）。
  - DI-2：上游关闭 → 502，代理不崩溃；上游恢复后继续转发；上游超时 → 504。
  - DI-3：注入 inspect 抛错 → 请求仍被转发（fail-open）且记录错误事件。
  - DI-4：默认只监听 127.0.0.1；非回环地址无 `--allow-public-bind` 拒绝启动；有则打印警告。
  - DI-5：`--init-secrets` 生成 0600 `.env`、不覆盖；stdout/stderr 不含 secret 值。
  - DI-6：`init` 不带 `--write` 不修改任何文件，只输出 diff；`--write` 不覆盖、拒绝路径穿越与符号链接。
  - DI-7：`watch --log` 喂入含诱饵命中与 canary 的 combined/common/JSON 样本 → 产生对应事件；普通日志零事件；畸形行、超长行、轮转不抛错。
  - 安全：Host 头 / 绝对 URI 无法改变上游；`CONNECT` 被拒；>16 KiB body 流式转发且内存有界；`AGENT_GUARD=off` 纯透传；诱饵应答仍带 `noindex`。
- 端到端冒烟：本地起一个 node http 上游 → `proxy` → curl 普通页面（与直连一致）→ curl `/.env` 诱饵看到 console 告警 → 杀上游得 502。
- 基准：`bench:latency:hr` 默认配置不得相对 v0.5a 回退（多次取中位数，如实报告波动；不得改门槛）；proxy 额外开销仅报告，不设门槛。
- `npm audit --omit=dev` 为 0；`npm pack --dry-run` 内容合理；对已排除的外部品牌名做全仓扫描，结果为 0（扫描词不要写进仓库文件）；六份 README 代码块一致、相对链接无失效；不新增 `.github/workflows`。
