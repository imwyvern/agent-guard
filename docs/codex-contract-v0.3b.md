# Codex 合同：v0.3b 离线评估（Exhaust 成本比 + Deception 安全扫描）

- 性质：**只加 bench 与评估工具，不改任何 `src/` 运行行为**。`mode` 仍只接受 `"detect"`。
- 依据：[exhaust.md](exhaust.md) §6、[deception.md](deception.md) §5。
- 约束：Node ≥20，TypeScript strict，**零新增依赖**，不访问外网，不打 tag，不发 npm，不加 CI。

## 交付

1. `bench/exhaust-sim.ts` + `npm run bench:exhaust-sim`
   - 纯内存模拟（不起 TCP），实现一个**参考型**有界迷宫生成器（放在 `bench/lib/maze-model.ts`，**不进 `src/`**）：HMAC 无状态节点、模板渲染、每会话深度/页数/字节/时长上限、全局并发与字节上限、断路器。
   - 一组"贪婪 agent"模型（脚本，不用 LLM）：深度优先、广度优先、随机游走、遇重复即放弃、遇预算用尽即放弃。各 200 个会话，固定种子。
   - 度量并输出 `bench/results/exhaust-sim.json` 和 `docs/bench-v0.3b.md`：对方请求数/字节/模拟时间 vs 我方 CPU 时间（`process.hrtime.bigint`）和出站字节；成本比；放弃步数分布；预算用尽次数；断路器触发次数。
   - 报告里诚实写明"模型 agent 不等于真实 LLM agent"。
2. `bench/deception-lint.ts` + `npm run bench:deception-lint`
   - 对 `src/decoys` 现有输出（D1–D4 和 MCP 诱饵）与 `bench/lib/persona.ts` 生成的样例做安全扫描：无真实厂商格式前缀（至少覆盖 AKIA/ASIA、`ghp_`/`github_pat_`、`sk-`、`xox[bpas]-`、`AIza`、`eyJ` JWT 头、PEM 私钥头）、主机只能是 `.invalid`/`.example`/保留网段、无祈使句关键词（ignore、disregard、you must、run、execute 等英文与中文常见指令词）、无隐藏/零宽字符、体积 ≤ 上限。违反则退出码 1。
   - `bench/lib/persona.ts`：由 seed 生成一致的虚构公司人设（产品名、域名、栈、服务清单、成员名）的**原型**，同种子输出一致。
3. 测试 `test/unit/bench-exhaust-model.test.ts`、`test/unit/deception-lint.test.ts`：
   - 迷宫模型：伪造节点 MAC → 拒绝；深度/页数/字节上限生效；同种子可复现；预算用尽后返回"stop"。
   - lint：对故意构造的坏样例（含 `AKIA…`、`ignore previous`、零宽空格、非保留域名）必须报错；对现有诱饵输出必须通过。
4. 文档：`CHANGELOG.md` Unreleased 增加条目；README 的 Demos and benchmarks 增加两条命令（中文/多语言译本同步一行命令即可，说明段落保持英文）。

## 验收

- `npm run build && npm run typecheck && npm run lint && npm test` 全绿，原有 197 项测试不减少。
- `npm run bench:exhaust-sim` 与 `npm run bench:deception-lint` 可运行，产出 JSON 与 `docs/bench-v0.3b.md`。
- `git diff --stat` 显示 `src/` 无改动（`src/decoys` 的任何修改必须是 lint 发现真实问题时的最小修复，并在报告中单独列出）。
- 正常 `git push origin main`，不 force-push。
