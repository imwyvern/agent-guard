# agent-guard v0.3b 离线评估

开始：2026-11-11T12:11:38.025+08:00；结束：2026-11-11T12:11:40.394+08:00（HKT / UTC+8）；wall time 2.370 s。

Node v24.22.1；CPU Intel(R) Xeon(R) Processor；8 logical CPUs；linux 6.12.113+ x64。

## 方法与复现

`npm run bench:exhaust-sim` 与 `npm run bench:deception-lint`；raw JSON：`bench/results/exhaust-sim.json`（gitignored）。固定 seed：`agent-guard-v0.3b-20261110`。五种 scripted greedy agents，各 200 sessions；每组 20 会话 round-robin，组间推进模拟时钟 60 s。DFS 使用 stack、BFS 使用 queue，均跳过已访问节点；random-walk 均匀选择出链；abandon-on-repeat 在响应重复路径后退出；abandon-on-budget-exhaustion 反复访问入口直到 stop。所有模型在 stop 时结束，step 包含终止请求。JSON 保存完整 step histogram、每会话 steps/time/reason。

每次请求假设固定 25 ms 开销，加 body bytes / 131072 bytes/s 的处理时间；这是人为设定的模拟值，不是 LLM token、真实请求延迟或计费数据。对方时间累加所有 session active time（并发时不是 wall time），不包含组间 cooldown。host time 用 `process.hrtime.bigint()` 包围同步模型创建会话、入口生成、visit、clock advance、结束会话；不计 agent 选择、JSON 和报告 I/O。它是同步 CPU 成本的 elapsed-time proxy，含调度/GC 噪声，不是操作系统 CPU accounting。无 warmup、单次测量，结果随机器变化。

**脚本模型 agent 不等于真实 LLM agent。** 未测真实 agent 的逃逸率、可信度判断、token 成本、生产正常路径 p99 或误伤率；模型也未实现生产准入闸门。因此不能据此启用 E2 或推导生产防护有效性。纯内存，不建 TCP server，不访问网络、不实际 sleep、不改 src；mode 仍只接受 detect。

## 成本比（cost ratio）

时间比 = sum(opponent simulated active milliseconds) / sum(host synchronous hrtime nanoseconds / 1e6)。字节比 = opponent received body bytes / host outbound body bytes。请求比 = opponent requests / host handled requests。不同单位没有任意加权混成一个比值；request bytes 是合成 GET request-line 与空 headers 的 UTF-8 长度，received/outbound bytes 只计 body，不含实际 HTTP/TLS 开销。空 stop body 为 0 bytes。

| Agent model（200 sessions 各） | Requests | Request / received bytes | Opponent simulated ms | Host CPU proxy ms | Time ratio | Byte ratio | Abandon steps min/p50/p95/max | Budget spent | Circuit opens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| depth-first | 1600 | 111400 / 1639400 | 52507.6 | 190.785 | 275.22:1 | 1.00:1 | 8/8/8/8 | 200 | 0 |
| breadth-first | 10200 | 691800 / 11602400 | 343519.3 | 906.727 | 378.86:1 | 1.00:1 | 51/51/51/51 | 200 | 0 |
| random-walk | 3121 | 215200 / 3407366 | 104021.1 | 319.542 | 325.53:1 | 1.00:1 | 8/13/31/51 | 200 | 0 |
| abandon-on-repeat | 1123 | 76933 / 1251126 | 37620.3 | 108.401 | 347.05:1 | 1.00:1 | 3/6/8/8 | 47 | 0 |
| abandon-on-budget-exhaustion | 10200 | 683400 / 11460000 | 342432.9 | 547.409 | 625.55:1 | 1.00:1 | 51/51/51/51 | 200 | 0 |

请求比均为 1:1，host outbound bytes 等于 opponent received bytes。exhaust.md §6 目标 >10:1，低于 3:1 该级别不得启用。即使假设下的 time ratio 达标，**byte ratio 仍为 1:1，低于 3:1，E2 不应启用**。没有用模拟时间比掩盖带宽成本。

## 边界与自保

默认每会话 depth ≤6、pages ≤50、bytes ≤512 KiB、duration <600,000 simulated ms；访问第 7 层或再请求超过额度时 stop/404，每会话只计一次 exhaust_budget_spent。每页固定模板替换、8 子链接 + parent/root 共 10 出链，均 rel=nofollow；noindex/nofollow/no-store，无 cookie、外部 URL。入口仅存在 bench，未加入运行时路由/robots/lures。

节点为截断 100-bit base32 HMAC(seed, parent|index|depth)，query trail 携带有界祖先索引以无状态重算校验；无节点表。伪造 MAC 在任何预算处理前拒绝，无页面/字节支出，也不增加 budget counter。session budget 本身有状态。全局并发 ≤20；出站为 rolling 60 s window ≤5 MiB（不是固定分钟桶）。断路器阈值 inspect p99 >1 ms 或 event-loop delay >20 ms，注入 telemetry 后永久关闭该模型实例，每次打开只计一次。正常 agent runs 不伪造 overload。

独立 fault probes（不混入成本比）：100 会话同时申请，admitted 20、rejected 80；同一模拟分钟出站 5241804 bytes（cap 5242880），rate stop 9；duration probe 在 600000 ms 返回 duration。inspect 与 event-loop 两个 probe 各触发 1 次 exhaust_circuit_open，后续访问均 stop/circuit，重复 overload 不重复计数。这些是注入信号的功能验证，不是宿主实际压力测试。

## Deception safety scan

扫描结果：passed，140 samples，0 violations。只读调用现有 envBody、adminResponse、opsBody、openapiBody、fakeData、generateCanary 与 mcpDecoyTools，覆盖 D1–D4（含 D2 401/403）、MCP tool/schema/description，以及 20 个 seed 的 persona JSON。现有 decoy cap 8 KiB；persona cap 16 KiB，persona 不含凭据。canary 为 AG-CANARY-，不当作厂商 secret。

扫描覆盖厂商前缀、PEM private-key headers、保留主机（.invalid/.example、RFC 5737/3849）、隐藏字符与 agent-directed English/中文命令。允许描述性 copy “do not share”，以及相对路径的 dotted filename。lint 是 bounded samples 的启发式检查，不是任意文本的完整语义安全证明；未测 persona 的真实 agent 可信度。独立 lint 命令按当前生成物重新检查，发现违规退出 1。

## 范围与偏差

仅新增 bench、tests、docs 与 package.json scripts；无 runtime 修改，无 src safety fix，无新依赖，未改 lockfile。未执行 commit/push/publish，遵循本次用户约束（覆盖旧合同的 push 条款）。
