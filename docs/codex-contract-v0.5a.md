# Codex 合同：v0.5a（服务器假文件 `seed`、事件时间线、处置钩子、Hono 延迟核查）

- 依据：[plan-v0.5-v0.7.md](plan-v0.5-v0.7.md) §1、§2；Dan 2026-11-11 22:31（HKT）要求继续推进。
- 约束：Node ≥20，TS strict，**运行时依赖仍为 0**；不加 CI，不打 tag，不发 npm，不改包名，不 force-push；默认行为与 v0.4b 字节一致；现有测试不得减少，现有断言不得改动。
- 范围外（本合同不做）：假成功环境（v0.6）、蜜罐机（v0.7）、proxy/init/Docker/log 模式与真实 AI 代理评测框架（v0.5b，单独合同）。

## 0. 先做：Hono 延迟核查（独立于新功能，先出结论）

v0.4b 验收里 Hono 适配器 100 并发 Δp99 三次中位数 1115 µs，超过 1000 µs 门槛（v0.4a 时一次过一次不过）。步骤：
1. 在同一台机器、无其他负载下，对 v0.4a 提交 `97f0e9d` 与 v0.4b `ad11701` 交替各跑 `bench:latency:hr` 至少 3 次（用 `git worktree` 分别检出，不动工作区），记录 Hono 的 Δp50/Δp99 与对照基线 p99 的绝对值。
2. 判定：若两个版本的 Hono Δp99 分布重叠（差异小于各自的运行间波动），结论为"测量噪声"，如实写入 `docs/bench-v0.4b-hono.md`，并建议把门槛判定改为"多次运行中位数 + 报告波动范围"（只提建议，**不得自行放宽门槛**，改门槛需 Dan 批准）。
3. 若 v0.4b 明显差于 v0.4a，定位回退（共用逻辑拆分、CryptoProvider 间接调用、适配器路径），修复并重测。
4. 无论哪种结论都写入报告。

## 1. `agent-guard seed`（服务器端假文件）

CLI：`agent-guard seed --profile <node|python|k8s|generic> --dir <path> [--write] [--seed-file <path>] [--callback-base <https-url>]`。

行为：
- 默认 dry-run：只打印将创建的文件清单（相对路径、权限、行数、canary id 前缀），**不打印任何 canary 全文或密钥**。`--write` 才落盘：文件权限 0600，目录 0700，**绝不覆盖已存在文件**（存在则跳过并提示），拒绝符号链接目标，路径必须在 `--dir` 内（防路径穿越）。
- 生成物（按 profile 取子集）：`.env.backup`、`.aws/credentials` 样式文件、假 SSH 私钥样式文件（明显无效的假密钥体，不是任何真实密钥格式）、`.kube/config`、`.npmrc` / `.pypirc`、`db-connection.txt`。内容由 `projectSeed`（来自配置或 `--seed-file`）确定性合成：同 seed 同输出，不同 seed 不同输出。
- **inert 红线（自动测试守护）**：不使用任何云厂商或第三方真实凭据的前缀与校验位；主机名只用 `.invalid`、`.example`、保留网段，或运营者通过 `--callback-base` 指定的自托管 https 域名（沿用 v0.4a `callback` 配置与 `allowedHosts`）；不含祈使句、隐藏字符；SSH 私钥样式文件不得是可解析的有效密钥。
- 每个文件内嵌一枚项目级 canary（`AG-CANARY-…`），并把文件相对路径、profile 作为 placement 记入 canary registry，使回放时能报告「在哪个文件泄露」。
- 提供 `agent-guard seed --verify --dir <path>`：只读检查已 seed 文件是否仍在、canary 是否完好、权限是否仍为 0600，输出缺失与被改动项（被改动本身不是告警）。
- 幂等：重复 `--write` 不改变已存在文件，只补缺。

### 读取检测（日志适配器，仅 Linux，只读，可选）
guard 自己**不**声称能检测文件读取（Node 的 `fs.watch` 无读事件）。提供：
- `agent-guard watch --auditd <logfile>` 与 `--inotify-log <logfile>`：持续读取运营者配置的 auditd 日志或 `inotifywait -m -e access` 输出，解析命中 seed 文件路径的记录，发出 `honeyfile_read` 事件（字段：placement、路径、时间、可得则含 uid/进程名）。普通日志零事件；解析必须有界（行长上限、速率上限、日志轮转处理），畸形行不得抛错。
- 文档提供 auditd 规则与 inotifywait 示例；明确需要 root 配置规则，guard 本身不需要 root，也不修改系统审计配置。
- 事件走 v0.4a 告警 adapters；`honeyfile_read` 默认严重度中，不单独触发 trap/block。
- schema 向后兼容新增事件类型与字段。

## 2. 事件时间线与 dwell time

- 事件新增（可选字段，向后兼容）：`incident.id`、`first_touch_at`、`alerted_at`、`dwell_ms`（首次触碰到当前事件）。时钟回拨不得产生负值。沿用现有 incident 关联的上限（50k 客户端 LRU，最近 32 次观察），**不新增无界状态**。
- Prometheus：`agent_guard_time_to_alert_seconds`、`agent_guard_incident_dwell_seconds`（直方图或摘要，**无路径 label**）。
- 事件日志（JSONL）持久化：新增可选 `log.file`（运营者指定路径，追加写，0600，大小上限与轮转由运营者外部管理或提供简单 `maxBytes` 截断策略并文档说明）。
- CLI `agent-guard incident list|show <id> --log <jsonl>`：只读，从事件日志还原时间线（首次触碰、读取假文件、回放假凭据、被限流、被拦截），输出人可读文本与 `--json`。
- 告警升级：同一 incident 首次告警 → 升级为 high 时再通知一次 → 超过 `escalation.remindAfterMs` 仍未被运营者标记处置则提醒一次（每 incident 提醒上限默认 2 次）。处置标记通过 CLI `agent-guard incident ack <id> --log <jsonl>` 写入一条 `incident_ack` 记录。均默认关闭，避免告警疲劳。

## 3. 处置钩子（response hooks，opt-in，默认不配置）

配置：`hooks: [{ on: 'incident_high' | 'canary_replay' | 'honeyfile_read', run: ['/abs/path/exe', 'arg1'], timeoutMs, maxPerHour, maxConcurrent }]`。
- 只执行运营者在配置里写死的**绝对路径可执行文件和参数数组**，用 `child_process.spawn`（`shell: false`），不经过 shell；不使用任何请求内容拼接 argv。
- 环境变量只传元数据白名单：`AG_INCIDENT_ID`、`AG_EVENT_TYPE`、`AG_CLIENT_KEY_HASH`、`AG_CANARY_ID`、`AG_PLACEMENT`，**不传 UA、路径、header、body**；子进程环境不继承 guard 的 secret。
- 超时终止（SIGTERM 后 SIGKILL），频率上限（每小时）、并发上限，失败只记录事件 `hook_result`，**绝不影响请求处理或抛到宿主**。
- Web / Edge 核心不支持 hooks（无子进程），文档写明。
- guard 自己不做密钥轮换、不改防火墙；示例脚本放在 `docs/examples/hooks/`（仅打印或写日志的示例，不含任何破坏性动作）。
- 自动测试：构造含 `;`、反引号、`$()`、换行的恶意 UA/路径，断言 argv 与环境不含其内容；超时、频率上限、并发上限；未配置时与 v0.4b 字节一致。

## 4. 文档与多语言（硬性要求）

更新 README.md 与 `docs/i18n/README.*.md` 五个译本（zh-CN、zh-TW、ja、ko、es；代码块逐字一致，相对链接可解析）：把"Host honeyfiles / Response time window"从 planned 改为已实现（`seed`、`watch`、`incident`、hooks 的最小示例和能力边界：读取检测依赖 auditd/inotify 日志），仍未做的写清楚；更新 CHANGELOG、`docs/roadmap.md`、`docs/positioning.md` 的「宣称 / 状态 / 证据」表、`docs/threat-model.md`（hooks 的攻击面与缓解、seed 文件的风险）、`docs/design.md`、`docs/community.md`；新增 `docs/seed.md`（profiles、文件清单、inert 规则、callback 指向、auditd/inotify 配置模板）与 `docs/incident-response.md`（时间线、dwell、升级、hooks 的安全使用）。Issue #8（seed）、#10（时间线）完成后评论并关闭。

## 5. 验收

- build / typecheck / lint / test 全绿，总数不低于 1106 通过且不改动既有断言。
- 新增测试覆盖：seed 的 dry-run 无写入、0600 权限、不覆盖、路径穿越与符号链接拒绝、确定性、inert 扫描（沿用 deception-lint 并扩展到 seed 产物）；auditd/inotify 解析（含畸形行、超长行）；incident 时间线与回拨；hooks 的注入防护、超时与上限；`check:neutral` 仍通过（新代码不得进入 Web 核心依赖闭包）。
- 端到端冒烟：对临时目录 `seed --write` → 把回放假凭据打到本地 demo → 看到带 placement 的告警与 incident 时间线 → 配置一个只写日志的 hook 被触发一次且受频率限制。
- 基准：`bench:latency:hr` 与 `bench:latency:web` 重跑，默认配置（未启用新功能）不得相对 v0.4b 回退；如实报告并说明波动（多次取中位数），不得改门槛。
- `npm audit --omit=dev` 为 0；`npm pack --dry-run` 内容合理；对已排除的外部品牌名做全仓扫描，结果为 0（扫描词不要写进仓库文件）；六份 README 代码块一致、相对链接无失效；`git status` 干净并正常推送 main。
