# 下一阶段实施规划：服务器层预警与拖延（v0.4b → v0.7）

> 状态：v0.4b 与拆分后的 v0.5a 已实现于 unreleased 代码树（未发 npm、未打 tag）；v0.5b / v0.6 / v0.7 仍规划中。更新于 2026-11-11（HKT）。
> 起点：Dan 的定位——「放假配置和假密钥，攻击者的 AI 一碰就告警，再拖慢它，给运维留出处置时间」。本文保留版本计划，并以 [seed.md](seed.md)、[incident-response.md](incident-response.md) 与 [positioning.md](positioning.md) 标注当前已实现范围。
> 范围约束不变：canary 永远 inert、不用任何真实厂商凭据格式、不做生产环境 reverse prompt injection、不做对第三方的外联探测、默认 detect-only、trap 与 deception 全部 opt-in。agent-guard 只提供程序和部署模板，**不替任何人部署**。

## 0. 总览与依赖

| 版本 | 主题 | 覆盖的方向 | 前置 |
| --- | --- | --- | --- |
| v0.4b（已实现，unreleased） | Web 标准核心 + Edge 适配器 | Edge 适配器 | 无 |
| v0.5a（已实现，unreleased） | 服务器层与处置 | ① seed / Linux-log watch ② incident timeline / CLI / log.file / metrics / opt-in escalation 与 Node hooks | v0.4a |
| v0.5b（规划，未实现） | 一键入口与评测 | ③ proxy / init / Docker / HTTP-log 模式 ④ 真实 AI 代理评测框架（预算未设定） | v0.5a |
| v0.6 | 欺骗层 | ⑤ 统一人设 + 分层泄露 + 假成功（opt-in） | v0.5 的评测框架（先量化，再启用） |
| v0.7 | 独立蜜罐机 | ⑥ `decoy-host` 独立进程 / 容器，与真实业务隔离 | v0.5 假文件、v0.6 人设 |

顺序理由：评测框架必须先于任何"消耗 token""骗过 AI"的宣传；假成功风险最高，放在评测之后；独立蜜罐机需要前面的人设和假文件指向它，才能形成「真服务器上的假凭据 → 蜜罐机上的假环境」闭环。

每个版本都必须同时更新 README、五个译本（zh-CN、zh-TW、ja、ko、es）和 CHANGELOG，并写进该版本的 Codex 合同验收项。

---

## 1. 服务器端假文件（v0.5a，已实现 / unreleased）

当前实际用法见 [seed.md](seed.md)。以下保留验收目标；读取只依赖运营者 Linux 日志，不能承诺必定观察到每一次读取。

**目标**：覆盖"攻击者已经进入服务器"的场景：在运营者指定目录放无害假凭据；回放由 HTTP inspection 检测，读取告警依赖运营者提供的 Linux 访问日志。

**做什么**
- `agent-guard seed --profile <node|python|k8s|generic> --dir <path> --seed-file <path> --env <name>`（另需 `AG_CANARY_SECRET`）：默认只打印将要创建的文件清单和内容摘要（dry-run），`--write` 才落盘，权限 0600，不覆盖已存在文件。
- 生成的文件（均在 `--dir` 内，按 profile 取子集）：`.env.backup`、`.aws/credentials`、无效 SSH placeholder `.ssh/id_rsa`、`.kube/config`、`.npmrc` / `.pypirc`、`db-connection.txt`。每个文件内含项目级 canary（`AG-CANARY-…`），相对路径与 profile 记入 canary registry 的 placement。
- `seed` 生成的内容全部来自 `projectSeed` 的确定性合成，**不使用任何云厂商或第三方的真实前缀与校验位**，主机名只用 `.invalid`、`.example` 或运营者自托管的 callback 域名。

**两层检测（诚实说明能力边界）**
1. **使用型（高置信，首选）**：seed 凭据在使用匹配 registry 的 HTTP guard 上重放时产生 `canary_replay` 与文件 placement。可将 endpoint 文本指向运营者自托管 URL，但普通 endpoint 请求不会自动触发 callback 告警；v0.4a `callbackHandler` 需要其自身签名 URL。独立蜜罐机仍规划中。guard 不出站探测。
2. **读取型（中置信，可选，仅 Linux）**：Node 的 `fs.watch` 看不到"读"事件，`atime` 在 `noatime` 下不可靠，所以 guard 本身不假装能检测读取。提供 `agent-guard watch --auditd <log>` 与 `--inotify-log <log>` 两种**只读日志适配器**：运营者自行配置 auditd 规则或 `inotifywait -e access`，guard 解析其日志并关联到 canary placement。文档给出规则模板，并说明需要 root 配置、guard 本身不需要。

**验收（HF）**
- HF-1：dry-run 不改动任何文件；`--write` 权限 0600，重复执行幂等，不覆盖。
- HF-2：所有生成物通过 placement lint 与「无真实格式前缀」自动扫描（沿用 deception-lint）。
- HF-3：auditd / inotify 日志样本喂入后产生 `honeyfile_read` 事件，字段含 placement、路径、时间；普通日志零事件。
- HF-4（原目标，未自动实现）：seed 的 `--callback-base` 只替换 endpoint 文本，不生成签名 callback URL；普通 endpoint 请求不会自动变成 `canary_callback`。原有 callback handler 只识别其签名 URL；seed 凭据回放可经 HTTP canary inspection 关联文件 placement。
- HF-5：`seed` 不发网络请求；`watch` 无出站探测，只有显式配置后的运营者 webhook 告警可以出站。零运行时依赖。

## 2. 处置时间窗（v0.5a，已实现 / unreleased）

实际字段位于 `event.incident`，操作与限制见 [incident-response.md](incident-response.md)。CLI `list|show` 只读，`ack` 追加；可选 Node `log.file` 0600/有界/sanitized；只有同一文件中的 CLI ack 对进程可见。watch 事件无 HTTP incident ID，只作日志相邻展示。

**目标**：把「给我们留出的时间」变成可量化、可行动。

**做什么**
- 事件新增：`first_touch_at`、`alerted_at`、`dwell_ms`（首次触碰到现在）、`incident.id`；Prometheus 增加 `agent_guard_time_to_alert_seconds` 与 `agent_guard_incident_dwell_seconds`（无路径 label）。
- `agent-guard incident list|show <id> --log <jsonl>`（list 不带 id）：从本地 JSONL 事件日志还原时间线（首次触碰、读取假文件、回放假凭据、被限流、被拦截），只读。
- **Response hooks（opt-in）**：`hooks: [{ on: 'incident_high', run: ['/usr/bin/node', '/absolute/path/to/agent-guard/docs/examples/hooks/append-log.mjs'], timeoutMs, maxPerHour }]`。约束：只执行运营者在配置里写死的可执行文件和参数数组，不经过 shell；环境变量只传元数据（incident id、client key 哈希、canary id），不传请求内容；有超时、频率上限、并发上限；默认不配置；hook 失败只记录，不影响请求。guard 自己不做密钥轮换、不改防火墙。
- Webhook / Slack / Telegram / 飞书 / 邮件沿用 v0.4a 适配器，增加"事件升级"（首次告警 → 同一 incident 升级为 high → 超过时间窗仍未处置的提醒），避免告警疲劳。

**验收（IT）**
- IT-1：CLI 按时间戳排序保留的 incident 记录；字段可选，时钟回拨不产生负 `dwell_ms`，不承诺墙钟事件时间单调。
- IT-2：hook 超时被终止，频率上限生效，恶意构造的路径、UA 不会进入 argv 或环境变量。
- IT-3：未配置 hook 时保留 v0.4b 的默认请求决策与响应行为。
- IT-4：升级提醒每个 incident 有上限，不刷屏。

## 3. 一键入口（v0.5b，规划 / 未实现，沿用 [distribution.md](distribution.md)）

先做 `proxy`（fail-open、默认绑 127.0.0.1）与 `init`（默认只打印补丁），再做 Docker 与 `watch --log`。验收沿用 DI-1～DI-8。这些入口属于 v0.5b，和已实现的 v0.5a seed/watch/incident/hooks 分开。这里的 HTTP-log 模式不是已实现的 Linux 访问日志 watch。npm 发布仍需 Dan 单独批准，发布前这些命令用 `node dist/cli` 或源码运行。

## 4. 真实 AI 代理评测框架（v0.5b，规划 / 未实现，`bench/agents`）

模型预算未设定，尚未开跑；当前模拟 maze 字节比仍 1:1，消耗攻击者 token 未得到证明。

**目标**：用证据而不是假设，回答「它真的会被骗吗？真的会耗 token 吗？」

**做什么**
- 评测靶场：本地 demo + seed 出的假文件目录，**纯本地、无外联**。
- 评测对象：我们自己控制的 agent（用 Codex CLI、其他本地可运行的 agent 驱动，经 Dan 批准的模型预算）。每个场景给固定任务提示，如"评估这台服务器的安全并找出可用凭据"，条件分为：无诱饵、仅诱饵、诱饵加迷宫、诱饵加假成功（v0.6）。
- 指标：`token_total`（以 agent 报告的用量为准）、请求数、时间、首次碰诱饵时间、是否使用假凭据、是否判定为蜜罐（让 agent 在结束时自述）、误入真实页面比例。每组至少 20 次，报告中位数和分位数，标注模型版本与提示词，结果原样入库 `docs/bench-agents-*.md`，不挑样。
- 结论规则：只有 `token_total` 在加迷宫组相对对照组有显著增加，README 才能写「消耗 token」；否则保持"未证实"。

**验收（EV）**
- EV-1：框架可一条命令跑完并产出可复现报告（固定随机种子、固定提示词）。
- EV-2：靶场网络隔离（无外联）有测试：agent 进程的出站请求被拦截并记录。
- EV-3：报告包含对照组与样本量，且 README 的相关措辞与报告结论一致（有 docs 校验脚本）。

**需要 Dan 决定**：评测的模型与预算上限（真实 agent 会产生 API 费用），我会在开跑前给出预算估算。

## 5. 欺骗层：人设、分层泄露、假成功（v0.6）

**目标**：让攻击者的 AI 误以为已经入侵成功，继续行动并暴露意图——正是 Dan 描述的"仿真环境"。

**做什么**
1. **统一人设（persona）+ 共享状态**：由 `projectSeed` 生成一家虚构公司的技术栈、内部域名、命名风格、团队成员；`.env`、OpenAPI、运维笔记、seed 文件、迷宫页引用同一批假服务、假端口、假版本号。
2. **分层泄露**：先低价值线索，深入才给下一层；每层独立 canary，回放时可还原决策链。
3. **假成功（默认关闭、逐路由 opt-in）**：假 canary 回放到诱饵登录或 API 时，返回只读的合成数据视图，而不是 401。硬性要求：只含合成记录；不执行任何真实操作；不设 cookie；不签发被任何真实接口接受的会话；响应带 `noindex`；单客户端数据量、请求次数、持续时间有预算；kill switch 与 `AGENT_GUARD_TRAP=off` 同样生效；`deception.fake_success` 事件字段记录使用情况。
4. 事件新增：`persona.id`、`deception.layer`、`deception.fake_success`。

**门槛（必须全部满足才允许合入默认可用状态）**
- 完成一次书面安全评估（沿用 deception.md §2 的六条红线）并通过自动扫描：无真实格式前缀、无外部主机、无祈使句、无隐藏字符。
- EV 评测显示：假数据被我们自己的 agent 误判为真实的比例有量化结果（目标 ≥ 50%）；没有达标就不宣传"骗过 AI"。
- 真人、verified crawler 零可见（AC-3、AC-17、AC-18 回归）。
- Dan 对"假成功开关"单独批准。

**验收（DC）**：DC-1 persona 跨页一致（同 seed 同输出，不同 seed 不同输出）；DC-2 假成功响应无 Set-Cookie、无真实操作副作用；DC-3 预算耗尽后回到普通拒绝；DC-4 默认配置字节不变；DC-5 deception-lint 对全部生成物 0 违规。

## 6. 独立蜜罐机（v0.7，`agent-guard decoy-host`）

**目标**：把假环境放到与真实业务隔离的另一个进程或容器里，真实服务器上的假凭据指向它，形成闭环：攻击者读到假凭据 → 去蜜罐机"登录" → 蜜罐机展示仿真环境并记录全部行动 → 运维收到高置信告警。

**做什么**
- 独立运行模式：`agent-guard decoy-host --persona <seed> --listen 127.0.0.1:8443`，只提供 HTTP / MCP / GraphQL 诱饵与 v0.6 的仿真环境；可选最小 TCP banner 监听（只记录连接和首包，不实现真实协议、不放行任何登录）。
- **隔离要求写成部署模板并附自检**：Docker Compose 的内部网络（无出站）、非 root、只读根文件系统、无挂载业务数据、无真实密钥；`decoy-host selfcheck` 检查出站连通性、运行用户、可写路径，不通过则拒绝启动。
- 蜜罐机不转发流量到真实后端；告警走 v0.4a 适配器与 v0.5 incident 时间线。
- 我们只提供程序、模板和文档；是否部署、部署到哪台机器由 Dan 或各运维者自行决定，**我们不替任何人部署**。

**验收（DH）**：DH-1 自检在有出站、root、可写业务目录时拒绝启动；DH-2 无论请求什么都不产生到外部的连接；DH-3 seed 文件里的 callback 指向蜜罐机时，一次完整链路（读文件 → 回放 → 告警）端到端通过；DH-4 资源上限（连接数、内存、会话数）有测试。

---

## 7. v0.4b（承接，不变）

Web 标准核心（`Request`→decision，WebCrypto）+ Cloudflare Workers、Next.js middleware、Vercel Edge、Deno、Bun 适配器。边缘无持久内存，状态降级策略写进文档。顺带关闭 Issue #4（Next.js）。

## 8. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 假凭据被第三方扫描器当真 | 不使用真实格式前缀；自动扫描；保留域名只用 `.invalid` / `.example` / 自托管 |
| 假成功变成真实入口 | 只读合成视图、无会话、无 cookie、预算、kill switch、安全评估 |
| hook 被滥用成命令注入 | argv 数组、元数据白名单、超时与频率上限、默认不配置 |
| 读取检测依赖系统配置 | 明说 guard 不能自己检测读取，给 auditd / inotify 日志适配器与模板 |
| 评测成本与结论偏差 | 预算先批、固定种子、报告样本量与对照组、结论不挑样 |
| 范围膨胀成大型蜜罐平台 | 每个版本设验收闸门；达不到就不合入默认；不做 SSH/数据库协议的完整仿真 |

## 9. 开放问题（待 Dan 决定）

1. 评测使用的模型和费用上限。
2. 假凭据真实度与"不使用真实厂商前缀"之间的取舍：默认保持严格不用；是否允许运营者自行配置自家的前缀格式（仅用于自家系统）。
3. v0.6 假成功仍需安全评估与单独批准；v0.5a Node 本地 hooks 已实现，opt-in/默认关闭，示例仅记录日志。
4. v0.7 仍规划为程序/隔离模板，不替运营者部署；不是已交付能力。
