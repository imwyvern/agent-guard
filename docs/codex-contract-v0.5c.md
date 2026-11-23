# Codex 合同：v0.5c（Cloudflare Workers 部署模板 E-5；Web Bot Auth 验证器）

- 依据：[plan-v0.5-v0.7.md](plan-v0.5-v0.7.md)、[distribution.md](distribution.md)（E-5）、[roadmap.md](roadmap.md)（Web Bot Auth 行）、[edge.md](edge.md)。Dan 于 2026-11-23（HKT）批准「全部按照建议推进」：本批做 Workers 模板与新版 Web Bot Auth 验证器；Helm 继续后放。
- 草案基线：`draft-ietf-webbotauth-httpsig-protocol-01`（2026-10-29，<https://datatracker.ietf.org/doc/html/draft-ietf-webbotauth-httpsig-protocol-01>），基于 RFC 9421 HTTP Message Signatures。草案仍在演进，实现与文档必须标注所依据的草案版本。
- 约束（全部硬性）：Node ≥20，TS strict，**运行时依赖仍为 0**（不得新增 dependencies；新增 devDependencies 也应避免，确需时在交卷说明理由）；**默认 `mode: 'detect'`、alert-only**，不新增自动拦截；未启用新选项时库行为与 v0.5b 字节一致；现有测试不得减少，**现有断言不得改动（tests add-only）**；canary 永远 inert，不使用真实厂商凭据格式或前缀；诱饵页保持 noindex；verified crawler / allowlist 永不被 trap；`check:neutral` 必须通过（新代码进入 Web 依赖闭包时不得引用任何 `node:` 模块）。
- 禁止：新增 CI / GitHub Actions / CodeQL；打 tag、建 release、`npm publish`；改包名或仓库名；force-push；`wrangler deploy` 或任何真实部署；向任何第三方服务器发请求（测试只用本地 fixture 与注入的 fetcher）；把排除名单中的外部品牌名写进任何文件（验收会全仓扫描，结果必须为 0）；提交任何密钥或 `.dev.vars`。
- 范围外：Helm、真实 AI 代理评测（Issue #11，预算待 Dan 决定）、假成功（Issue #9 / v0.6）、蜜罐主机（v0.7）、延迟门槛（已在本批前单独改为多次运行中位数，不要再改）、GitHub issue / PR 操作。

## 1. Workers 部署模板（E-5）

新增 `deploy/workers/`（模板，只随 git 仓库提供，**不改 `package.json` 的 `files`**，不进 npm 包）：

| 文件 | 要求 |
| --- | --- |
| `deploy/workers/wrangler.toml.example` | `main` 指向示例入口；钉死 `compatibility_date`（不得写 `latest` 或留空）；**不得**含 `[vars]` 密钥值、account_id、route/zone 真实值（用注释占位）；注释说明用 `wrangler secret put AG_CANARY_SECRET` / `AG_PROJECT_SEED` 注入；可选 KV / Durable Object 绑定只能以注释形式给出 |
| `deploy/workers/src/index.ts` | 用 `@imwyvern/agent-guard/workers` 的 `fromEnv` + `withAgentGuard` 包一个上游/示例 handler；**detect-only**（不设置 `AG_MODE=trap`，trap 只在 README 中作为显式选项说明）；guard 在模块级惰性初始化并复用 |
| `deploy/workers/.dev.vars.example` | 只列变量名，值为空或明显占位（如 `replace-me`），不含任何可用密钥 |
| `deploy/workers/.gitignore` | 至少忽略 `.dev.vars`、`.wrangler/`、`node_modules/` |
| `deploy/workers/README.md` | 本地 `wrangler dev` 用法（需运营者自行安装 wrangler，不加为本仓库依赖）、secrets 注入、无 StateStore 时的降级（引用 [edge.md](../../docs/edge.md) 降级表）、`CF-Connecting-IP` 信任边界、诱饵 noindex、canary inert、**本仓库不部署也不发布 Worker**；npm 发布前示例从源码构建引用的说明 |

- 示例必须能在本仓库内被 TypeScript 类型检查（可通过 tsconfig path 或测试内 `tsc` 子集检查；不要把 `deploy/` 加进库的 build 输出）。
- 若本机 miniflare（已存在的 devDependency）可用，用它在**本地**加载模板入口做冒烟：普通 `/` 透传，`/.env` 诱饵返回 noindex 且产生 `decoy_hit`；不可用时显式 skip，不得假装通过。

### 验收 WT

- **WT-1**：解析 `wrangler.toml.example`：`compatibility_date` 为固定日期；无 `[vars]` 下的密钥键（`AG_CANARY_SECRET`、`AG_PROJECT_SEED`、`AG_WEBHOOK_SECRET` 等）；无 account_id / 真实 route 值。
- **WT-2**：`deploy/workers/src/index.ts` 不设置 trap 模式、不含硬编码 secret/seed；通过类型检查。
- **WT-3**：`.dev.vars.example` 只含占位；`deploy/workers/.gitignore` 含 `.dev.vars`；仓库中不存在被跟踪的 `.dev.vars`。
- **WT-4**：miniflare 本地冒烟（见上）；不可用时 skip 并在输出中说明原因。
- **WT-5**：`npm pack --dry-run` 不包含 `deploy/`；`files` 字段未变。

## 2. Web Bot Auth 验证器

新增 WebCrypto-only 模块（建议 `src/crawler/web-bot-auth.ts` 及必要的结构化字段解析器，如 `src/crawler/sfv.ts`），Node 核心与 Web 核心共用；只用 `globalThis.crypto.subtle`（或现有 `CryptoProvider` 抽象），**不得 import `node:crypto` 或任何 `node:` 模块**，以便进入 Web 依赖闭包后 `check:neutral` 仍通过。

### 2.1 协议要点（按 -01）

- 解析 `Signature-Input`、`Signature`（RFC 8941 Dictionary）与 `Signature-Agent`：新版为 **Dictionary**（成员名 = 签名 label，值 = 直接指向 JWKS 的 HTTPS URI 字符串，如 `sig1="https://signature-agent.test/jwks.json"`）；同时兼容**旧版 bare sf-string** 形式（草案附录 E 的 legacy 示例）。
- 签名参数：`created` 必须存在；`expires` 必须存在且晚于 now（允许可配置时钟偏差，默认 ≤60 s）；`expires - created` 超过可配置上限（默认 24 h，对应草案 RECOMMENDED）即拒绝；`keyid` 为 JWK SHA-256 Thumbprint（OKP 按 RFC 8037，EC/RSA 按 RFC 7638）；`tag` 必须为 `web-bot-auth`，否则忽略该签名。
- 覆盖组件必须至少含 `@authority`，存在 `Signature-Agent` 时必须覆盖 `"signature-agent";key="<label>"`；按 RFC 9421 §2.5 构造 signature base。
- 算法：**必须支持 Ed25519**；其他算法（如 ecdsa-p256-sha256）可选，未实现的一律视为 `unsupported`，**不得** bypass。运行时 WebCrypto 不支持 Ed25519 时同样 `unsupported`，fail closed（不 bypass、不抛出到宿主请求）。
- **密钥查找必须以 (Signature-Agent URL, key) 对为键，绝不能只按 keyid**（草案 §5.4）。未经解析或未由运营者配置关联的 URL 只是声明，不得据此附加信任。
- 不实现 nonce 重放库；文档写明重放边界由 `expires` 与覆盖组件限定。

### 2.2 配置与默认（安全默认）

```ts
webBotAuth?: {
  enabled?: boolean;                 // 默认 false：完全不解析签名头
  trustedAgents?: Array<{
    url: string;                     // 运营者信任的 Signature-Agent URL（https）
    keys?: JsonWebKeySet;            // 静态 JWKS：默认路径，无出站
  }>;
  fetchKeys?: {                      // 默认 undefined：不出站
    fetcher: (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;
    allowHosts: string[];            // 必填、精确主机匹配，空数组 = 不抓取
    timeoutMs?: number;              // 默认 2000，上限 5000
    maxBytes?: number;               // 默认 64 KiB，上限 256 KiB
    cache?: StateStore;              // 可选；否则有界内存 LRU（条目与 TTL 上限）
    maxTtlSeconds?: number;          // 尊重 Cache-Control 但不超过此值，默认 86400
  };
  clockSkewSeconds?: number;         // 默认 60
  maxSignatureAgeSeconds?: number;   // 默认 86400
}
```

- **默认无任何出站请求**。只有运营者显式提供 `fetchKeys.fetcher` 且 URL 主机在 `allowHosts` 中、协议为 `https:`、无凭据、无非默认端口（或在文档明确规则）时才抓取；不跟随重定向（`redirect: 'manual'`，3xx 视为失败）；超时、超大、非 JSON、非 JWKS、媒体类型不符均视为失败且被缓存为短期负结果（有上限），失败不阻塞或改变宿主响应。guard 不在启动时主动抓取。
- **信任策略**：只有签名有效**且** Signature-Agent URL 属于 `trustedAgents` 时，才视为 verified agent，等同 verified crawler：bypass 诱饵、maze 与全部 trap 处置，事件 `ua_class` 记为 `verified_crawler`（或新增枚举值时只**追加**，不改既有值），并在事件中附加 `web_bot_auth: { agent_url, keyid, verified: true }`（不记录签名原文）。
- 签名有效但 URL 不在 `trustedAgents`：**不 bypass**，按普通请求处理，仅在事件中记录 `web_bot_auth.verified: true, trusted: false` 供观测。签名无效、过期、篡改、unsupported：不 bypass、不提升严重级别、不单独触发 block；记录 `verified: false` 与原因枚举。
- 任何解析异常都被隔离（fail-open 给宿主，fail-closed 给信任判断）。
- 可选辅助：`acceptSignatureHeader(opts)` 生成符合 RFC 9421 §5.1 的 `Accept-Signature` 值（覆盖 `@authority` 与 `signature-agent`，`tag="web-bot-auth"`），**默认不自动加到任何响应**，诱饵页尤其不加；只导出函数并在文档说明运营者可在自己的 403/普通响应中使用。
- Node 核心与 Web 核心（含 Workers/Next/Deno/Bun/honoWeb 适配器）行为一致；Node 的 DNS crawler 验证保持原样，Web Bot Auth 为额外的正向验证路径。

### 验收 WBA

- **WBA-1**：RFC 9421 Ed25519 测试向量（RFC 9421 附录 B.1.4 测试密钥 / B.2.6 示例）在 Node 与 Web 构建下均验证通过；改一个字节即失败。
- **WBA-2**：新版 Dictionary `Signature-Agent` 与旧版 bare string 两种形式都能解析并验证；多个 label 时按 label 正确配对。
- **WBA-3**：过期、`created` 在未来超过偏差、`expires - created` 超上限、`tag` 不是 `web-bot-auth`、缺 `@authority`、缺 `signature-agent` 覆盖、keyid 与 thumbprint 不符 —— 全部拒绝，且不 bypass。
- **WBA-4**：(URL, key) 绑定：A URL 下的合法 key 用于签名但请求声明 B URL → 拒绝（防 keyid-only 混淆）。
- **WBA-5**：默认配置（`enabled` 未设或无 `fetchKeys`）下发生 0 次 fetch（用注入 spy + 全局 `fetch` 替身断言）；`allowHosts` 外的主机、`http:`、带凭据 URL、3xx、超时、超过 `maxBytes`、非 JWKS → 0 次信任且有界失败缓存。
- **WBA-6**：verified + trusted 的请求访问诱饵 / maze / trap 路径时不被诱饵、不被 trap；verified 但 untrusted 的请求访问诱饵时行为与未签名请求一致（仅事件多出观测字段）。
- **WBA-7**：Node 与 Web 差分：同一组签名请求在 `createAgentGuard` 与 `createWebGuard` 下决策一致。
- **WBA-8**：`check:neutral` 通过，Web bundles 中无 `node:` 引用；运行时依赖仍为 0。
- **WBA-9**：WebCrypto 不支持 Ed25519 的模拟环境下结果为 `unsupported`，请求透传、无异常抛出。
- **WBA-10**：`acceptSignatureHeader` 输出可被本模块自己的解析器回读，默认不出现在任何响应中（诱饵响应快照不变）。

## 3. 文档与多语言（硬性）

- README.md 与 `docs/i18n/README.{zh-CN,zh-TW,ja,ko,es}.md` 五个译本同步：Workers 模板（本地模板，不是已部署 Worker / 已发布产物）与 Web Bot Auth（opt-in、默认关闭、默认无出站、仅信任运营者列出的 agent URL）。**六份 README 的 fenced code blocks 必须逐字节一致**，所有相对链接必须可解析（沿用并按需扩展 `test/unit/entry-docs.test.ts`，只追加断言）。
- CHANGELOG `[Unreleased]` 下 Added / Changed 条目，日期写 2026-11-23（HKT）或实际完成日（HKT）。
- 更新 `docs/roadmap.md`（Web Bot Auth 行改为已实现 / unreleased，注明草案 -01 与兼容旧形式）、`docs/distribution.md`（E-5 Workers 模板已实现、Helm 仍 planned）、`docs/plan-v0.5-v0.7.md`、`docs/positioning.md` 的状态表、`docs/edge.md`（Workers 模板与 Web Bot Auth 配置段）、`docs/threat-model.md`（JWKS 抓取 SSRF 面、重放边界、自签 agent 不获信任）、必要时 `docs/security-review.md` 记录新增正则 / 解析器的边界。
- 不得把未证实的「消耗攻击者 token」或「假成功」写成已交付。

## 4. 总体验收（维护者交卷后独立重跑）

```sh
npm run build && npm run typecheck && npm run lint && npx vitest run && npm run check:neutral && npm run bench:deception-lint
```

- 全绿；通过数不低于本批开始时的基线（1534 passed / 5 skipped 之上，加上延迟门槛批次新增的测试），既有断言未改；`bench:deception-lint` 0 违规。
- `npm audit --omit=dev` 为 0；`npm pack --dry-run` 不含 `deploy/`、密钥、日志或测试夹具。
- 外部品牌名全仓扫描 0 命中（扫描词不写进仓库）；无 `.github/workflows`；运行时依赖 0。
- 延迟：维护者按新门槛（多次外层运行中位数 + 最小–最大范围）重跑 `bench:latency:hr` 与 `bench:latency:web` 并如实报告；Web Bot Auth 默认关闭，不应影响默认路径。
- 不对第三方做探测或攻击；不做 reverse prompt injection；不部署。

## 5. 分步执行（每步单独一轮 Codex，结束后由维护者验收再进入下一步）

1. **v0.5c-1**：结构化字段解析器 + Web Bot Auth 验证核心（WBA-1～WBA-5、WBA-9、WBA-10 单元测试）。
2. **v0.5c-2**：接入 Node / Web 核心与适配器的信任决策（WBA-6～WBA-8）。
3. **v0.5c-3**：Workers 模板（WT-1～WT-5）。
4. **v0.5c-4**：文档、六份 README、CHANGELOG、roadmap 等（§3）。

每轮只改本步范围；不要运行延迟基准；不要 `git push`（由维护者验收后推送）；可以本地 commit，提交信息用英文 conventional commits。
