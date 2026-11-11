# Codex 合同：v0.4a（把 README「不是什么」里能安全做的都做进去）

- 依据：Dan 2026-11-10 要求把 README "What it is NOT" 中可行的项目实现。设计依据：[exhaust.md](exhaust.md)、[deception.md](deception.md)、[distribution.md](distribution.md)、[roadmap.md](roadmap.md)。
- 约束：Node ≥20，TS strict，**运行时依赖仍为 0**，不新增依赖，不加 CI，不打 tag，不发 npm，不改仓库名/包名，不 force-push。
- **默认行为不变**：`mode` 默认与现有一致（`"detect"`），所有新能力都是 opt-in 且默认关闭；现有 382 项测试不得减少，现有验收断言不得改动（除新增 runtime/选项）。

## 判断：做 / 不做

| 项目 | 决定 | 说明 |
| --- | --- | --- |
| Slack / Telegram / 飞书 / email 告警 | **做** | 全部 opt-in adapter；零依赖；email 用最小 SMTP（node:net/node:tls） |
| Prometheus 指标端点 | **做** | 文本格式导出器，不默认挂载，无路径 label |
| Mechanical timing（请求节奏规律性） | **做** | 只输出 `automation` 轴分数，永不单独判 `agent`，永不触发 block |
| 限流（rate limit） | **做（opt-in）** | 仅作用于诱饵路径、仅已确认会话 |
| 自动阻断（block） | **做（opt-in，默认关）** | 仅 canary 回放或 incident=high 后，TTL 阻断，允许名单/已验证爬虫永不被阻断 |
| trap 模式 `mode: "trap"` | **做（opt-in）** | 组合开关：延迟、限流、阻断、迷宫，每项独立开关 |
| 有界迷宫（maze） | **做（实验性，默认关）** | 按 exhaust.md 预算；文档标注"v0.3b 模拟显示字节比 1:1，尚无真实 agent 实测" |
| 自托管回调 canary | **做（opt-in）** | 只允许指向运营者自己配置的主机，被访问即 `canary_callback` 告警；**不使用任何第三方 honeytoken 服务** |
| Edge（Workers/Next/Deno/Bun）适配器 | **本批不做** | 依赖 Web 标准核心，另起 v0.4b 合同 |
| 反向提示注入 | **不做** | 生产环境红线，可能把我们变成注入源 |
| 出站探测 / 对第三方回连 | **不做** | 对第三方的探测属攻击面，红线 |
| 真实厂商凭证 | **不做** | canary 必须 inert |

## 交付

1. **告警 adapter**（`src/alerts/slack.ts`、`telegram.ts`、`feishu.ts`、`smtp.ts`，导出 `slackAdapter`、`telegramAdapter`、`feishuAdapter`、`smtpAdapter`）
   - Slack incoming webhook；Telegram `sendMessage`（bot token 从配置传入，永不写日志）；飞书自定义机器人 webhook（支持可选签名校验字段 `secret`，按飞书文档的 HMAC-SHA256）；SMTP：隐式 TLS（465）与 STARTTLS（587），AUTH PLAIN/LOGIN，超时与大小限制，收件人列表，纯文本正文。
   - 共同约束：只发请求元数据与 canary ID，不含 body/Cookie/Authorization；非 localhost 必须 https（SMTP 必须 TLS）；拒绝重定向；沿用现有去重、限流、队列与 `close()` 刷新；失败不影响宿主；URL/凭据来自配置，不硬编码。
   - 测试全部使用本地 127.0.0.1 假服务（含最小假 SMTP server），不访问外网。
2. **Prometheus**：`guard.prometheusText()` 与 `prometheusHandler(guard)`（不默认挂载，需宿主显式注册路径）。指标：请求数、事件数（按类型）、告警投递数、延迟分位数、client 状态大小、trap 状态。**不得出现诱饵路径作为 label**。测试校验文本格式（`# HELP`/`# TYPE`），无 promtool 依赖。
3. **Mechanical timing**：`src/core/timing.ts`，对每个 client key 保存有界的最近 N（默认 20）次请求间隔，计算变异系数；仅在 N 足够时产生 `signals.automation`（0–1）。事件里新增可选 `automation_score`；schema 向后兼容更新。永不单独造成告警升级到 agent，永不触发 block。测试：人类节奏样本（高方差）与机械样本（低方差），误报测试。
4. **trap 模式**（`mode: 'detect' | 'trap'`，默认 `detect`；`trap` 配置块 `trap: { delay, rateLimit, block, maze }` 每项默认关闭）
   - 闸门沿用 exhaust.md §3：verified crawler / allowlist 永不进入；单次 `/.env` 命中不够；需要 canary 回放或 `incident.confidence === 'high'` 或配置的行为分阈值。
   - `delay`：仅诱饵路径，上限 3000 ms，异步定时器，全局并发上限。
   - `rateLimit`：仅诱饵路径，对已确认会话做令牌桶，超限返回 429。
   - `block`：对已确认会话在 TTL（默认 15 min，上限 24 h）内返回 403，有界内存（LRU），事件 `trap_block`，**每次阻断记录日志**，允许名单永远优先；阻断范围只对"同一 client key"，不得扩大到 CIDR。
   - `maze`：按 exhaust.md §5 实现无状态 HMAC 节点，预算与保险丝（每会话深度/页数/字节/时长，全局并发与字节上限，断路器），页面 `noindex, nofollow, no-store`，无 cookie，无外部 URL，预算耗尽回原生 404 并告警一次 `exhaust_budget_spent`。
   - 全局一键关闭：环境变量 `AGENT_GUARD_TRAP=off`（运行时读取，立即生效）与 `guard.setTrapEnabled(false)`。
   - 自保断路器：inspect p99 或事件循环延迟超阈值则自动关闭所有 trap 并告警 `trap_circuit_open`。
   - 验收（新增 AC-16…AC-24，对应 exhaust.md §7）：默认配置与 v0.3 行为逐字一致；真人会话、模拟 Googlebot/Bingbot、allowlist 永不进入；单次诱饵命中只走检测；回放后遍历迷宫到上限即 404 并告警一次；并发 100 个已确认会话时全局上限生效；伪造迷宫节点 MAC → 404；所有迷宫响应带 noindex/nofollow/no-store 且无 Set-Cookie 与外部 URL；断路器触发后回到检测。
   - 每个适配器（Express/Node/Hono/Fastify/Koa）都跑通这些 trap 验收。
5. **自托管回调 canary**：配置 `canary.callback: { baseUrl }`（必须 https，或 localhost 用于测试；主机由运营者配置）。生成的诱饵里可包含 `baseUrl + '/ag/cb/' + <callback token>`；`callbackHandler(guard)` 被访问时返回 204 并发 `canary_callback` 告警。回调 token 同样是 inert 且带 HMAC。
   - 不得连接任何第三方 honeytoken 服务；不得由 guard 主动发起任何出站请求（告警 adapter 除外）；linter 只放行配置的 `baseUrl` 主机。
6. **文档与多语言（硬性要求）**：更新 README.md（把 "What it is NOT" 改为准确描述：哪些现为 opt-in 能力，哪些仍然不做——反向提示注入、出站探测、真实厂商凭证、第三方 honeytoken 服务；迷宫标注实验性；Edge 标注"下一批"）、`docs/i18n/README.*.md` 五个译本同步（代码块逐字一致）、CHANGELOG、`docs/roadmap.md` 标记完成项、`docs/design.md` 与 `docs/threat-model.md` 中关于 trap 的段落更新、`docs/community.md` 的适配器说明；新增 `docs/trap-mode.md` 说明开启方法、闸门与风险；`docs/exhaust.md` 状态更新为"已实现（实验性）"。

## 验收

- `build`/`typecheck`/`lint`/`test` 全绿，原 382 项不减少，新增测试覆盖上述每一项。
- 默认配置回归：`bench:latency:hr` 重跑，Δp50 ≤ 200 µs、Δp99 ≤ 1000 µs、50k client 堆 ≤ 10 MB（新增 timing/trap 状态后仍须满足，若不满足需如实写入报告并说明）。
- `bench:exhaust-sim` 仍可运行；`bench:deception-lint` 0 违规；`agent-guard lint` 对内置输出 0 违规。
- `npm audit --omit=dev` = 0；`npm pack --dry-run` 内容干净。
- grep `liandaai|练答` = 0；六个 README 代码块一致、相对链接可用。
- 正常提交、`git push origin main`。
