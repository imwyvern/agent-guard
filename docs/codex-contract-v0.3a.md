# Codex 合同：v0.3a（Node 侧多框架 + 场景 + 深度检测）

- 依据：[roadmap.md](roadmap.md) §4.1–4.3。纯开源研究，不部署。
- 默认仍是 **alert-only**；`mode` 仍只接受 `"detect"`；不做 Exhaust/trap。红线见 [community.md](community.md)。
- 约束：Node ≥20，TS strict，**运行时依赖仍为 0**。允许新增 **devDependencies**：`fastify`、`koa`、`@types/koa`、`graphql`（仅测试/示例用），对应框架作为 optional `peerDependencies`；安装后跑 `npm audit` 并在报告里列出结果。不加 CI，不打 tag，不发 npm。
- 不改变现有公开 API 的语义；新增导出走新增子路径：`./fastify`、`./koa`。

## 交付

1. **Fastify 插件** `src/adapters/fastify.ts`（`@imwyvern/agent-guard/fastify`）与 **Koa 中间件** `src/adapters/koa.ts`（`.../koa`）
   - 遵循现有适配器接口（参考 `src/adapters/hono.ts`、`express.ts`，先读再写）。body 已被框架解析后才检查；验证过的爬虫交给宿主原生 404；alert-only，canary 回放继续交给宿主。
   - 各自跑通共享验收套件（现有 `test/acceptance` 的参数化方式，新增两个 runtime）；examples 增加 `fastify-demo`、`koa-demo`，`npm run demo:fastify`、`npm run demo:koa`。
2. **GraphQL 诱饵场景** `src/scenarios/graphql.ts`
   - 提供 `graphqlDecoys()`：返回 decoy field/type 名（如 `internalAdminUsers`）供宿主加入 **introspection 结果**，以及 `inspectGraphqlRequest(guard, request)`，在请求查询到 decoy field 时发 `decoy_hit`（id `GQL`，severity medium）；解析用有界的简易 tokenizer（**不引入运行时 graphql 依赖**），对超长/畸形 query 安全降级。
   - decoy 绝不执行真实 resolver，不返回真实数据；返回 GraphQL 标准错误 `FORBIDDEN`，响应带 noindex/no-store；introspection lint 沿用 `lintMcpDecoyDescription` 的规则（无祈使句、无隐藏字符、无外部 URL）。
   - `examples/graphql-demo` + `npm run demo:graphql`（用 devDependency `graphql` 搭一个最小 schema），测试覆盖：introspection 正常、decoy field 查询告警、真实查询不告警、畸形 query 不崩溃。
3. **Per-session correlation（incident）**
   - 同一 `client_key` 在可配置窗口（默认 15 min）内的事件序列（如 robots → D1 → D2）合并为 `incident` 事件：`incident.id`、`incident.sequence`（有序事件类型）、`incident.first_seen/last_seen`、`incident.confidence`（`low|medium|high`，由序列特征与是否含 canary_replay 决定）。
   - **只升级置信度，永不阻断、永不改变响应**；有界状态（沿用现有 LRU 上限）；`schema/event.v1.json` 以向后兼容方式新增可选 `incident` 字段，并更新 schema 测试。
4. **Canary propagation tracing**
   - registry 中每个 canary 已有 placement；回放告警新增 `canary.leaked_at`（placement）、`canary.replayed_at`（回放路径）、`canary.dwell_ms`（自首次下发到回放的时间，来自有界内存记录，重启后缺失则省略）、`canary.client_keys_seen`（跨 client_key 个数，上限 8）。
5. **Placement linter** `src/canary/lint.ts` + CLI `agent-guard lint <path>`
   - 对内置所有诱饵/lure 输出与指定文件检查：祈使句关键词（中英）、隐藏/零宽/双向控制字符、非保留主机名的 URL、真实厂商密钥前缀。违规退出码 1。把 v0.3b 的 `bench/deception-lint.ts` 规则抽成共享模块，bench 改用它，行为不变。
6. **API-only 场景文档与示例**：`docs/scenarios/api-only.md`（canary 放 OpenAPI `example`、错误响应的 `docs_url`、`/.well-known/` 假文件的做法与误报边界），示例沿用 express-demo 的变体，不新增依赖。
7. **文档与多语言（硬性要求）**：更新 README.md、`docs/i18n/README.{zh-CN,zh-TW,ja,ko,es}.md`（新增适配器、场景、incident、`lint` 命令；代码块逐字一致，译正文）、CHANGELOG.md（Unreleased）、`docs/community.md` 中的适配器说明、`docs/roadmap.md`（把已完成项标记为 done 并注明版本）。把 GitHub issues #2（Fastify）、#3（Koa）、#6（GraphQL）在完成后各留一条评论说明已由维护者实现并指向提交（不关闭 issue 之外的其他 issue；可以关闭这三个，使用 API）。

## 验收

- `npm run build && npm run typecheck && npm run lint && npm test` 全绿；原有 217 项不减少。
- 新增测试：每个新 runtime 的共享验收套件、GraphQL 场景、incident 序列、propagation 字段、linter 坏样例必须报错而现有诱饵必须通过。
- `bench:latency:hr` 不要求重跑，但 `npm run bench:deception-lint` 须仍通过；对 incident 状态补一个 50k client 内存上限测试（≤10 MB 门槛不变）。
- `npm audit` 结果写进报告；`npm pack --dry-run` 内容里不应出现 devDependencies 或示例。
- 特定站点集成引用为 0；README 与五个译本的代码块一致、相对链接全部可用。
- 正常提交、`git push origin main`，不 force。
