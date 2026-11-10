# agent-guard KPI 与本地验证方法（v0.1）

- 日期：2026-11-10（HKT）
- 性质：**纯开源研究项目，不部署到任何服务器**。所有 KPI 都在本地用 demo app + 自动化测试 + 模拟 benchmark 产出。
- 验证载体：
  - `examples/express-demo/`：Express demo 站点（首页、列表、详情、`/login`、robots.txt、sitemap.xml、静态资源）
  - `examples/node-http-demo/`：同样内容的原生 `node:http` 版本
  - `test/`：单元 / 集成 / 验收（AC-1…AC-15）
  - `bench/simulate.ts`：流量模拟 benchmark，输出 `bench/results/latest.json` 与 `docs/bench-v0.1.md`

## 1. 模拟流量场景（bench/simulate.ts）

| 场景 | 角色 | 行为 | 期望 |
|---|---|---|---|
| S1 human | 真人浏览（浏览器 UA、带 cookie、Referer 链） | 每个会话 20–40 个请求：首页 → 列表 → 详情 → 登录（正确/错误密码各一次）→ 静态资源；随机思考时间（压缩时钟） | 0 告警 |
| S2 verified crawler | Googlebot / Bingbot UA + mock DNS 验证通过 | 读 robots.txt、sitemap、全部真实页面；另外故意请求 D1–D5（模拟误入） | 0 告警；D1–D5 全部 404 |
| S3 spoofed crawler | Googlebot UA + rDNS 失败 | 同 S2 | 访问诱饵即告警，含 `ua_spoof_crawler` |
| S4 curl replay | `curl/8.x` UA | 直接带 canary 访问 `/api/internal/admin/*`、POST 到真实 `/login` 和 D5，canary 分别放 header / query / JSON / form | 每次回放都 `canary_replay` 告警 |
| S5 LLM-agent probing | `python-httpx` / `node-fetch` / 类浏览器 UA 混合 | robots.txt → 跟 Disallow → `/.env` → 解析出 token → `/api/internal/openapi.json` → 用 token 调 D2 → 用 D3 密码试 D5 和 `/login`；也访问 `/llms.txt`、`/.well-known/mcp.json` | 会话被检测（≥ 1 次 `decoy_hit`，有回放时 `canary_replay`） |

默认规模：S1 200 会话，S2/S3 各 20，S4 50，S5 50；种子固定，可复现。

## 2. 核心 KPI（全部由 benchmark/测试自动输出）

| KPI | 定义 | 目标（Gate） |
|---|---|---|
| **False positive (human)** | S1 中产生任意 `decoy_hit`/`canary_replay` 告警的会话数 / S1 会话数 | **= 0** |
| **False positive (verified crawler)** | S2 中进入诱饵或产生告警的请求数 | **= 0** |
| **Decoy-hit detection rate** | S3+S4+S5 中被检测到（≥ 1 条告警）的会话数 / 会话总数 | **= 100%** |
| **Canary replay detection** | S4+S5 中每一次 canary 回放被记为 `canary_replay` 的比例 | **= 100%** |
| **Alert latency** | 请求到达 → 本地 webhook 接收端收到并验签成功 | p95 ≤ 250 ms，p99 ≤ 1 s（本地回环；含去重/队列，不含网络） |
| **p99 latency overhead（非诱饵请求）** | autocannon 30 s、100 连接打 demo 首页，guard on vs off 的 p99 差 | **≤ 1 ms**；p50 ≤ 0.2 ms；内存增量 ≤ 10 MB（50k client_key） |
| **Lighthouse 无回归** | 见 §3 | 分数差 ≤ 2 |
| **SEO 结构性无回归** | 见 §4 | 全部通过 |

基准受机器影响，报告必须记录：CPU 型号、核数、Node 版本、OS，以及 3 次运行的中位数。

## 3. Lighthouse 检查（针对 demo app）

- 工具：`@lhci/cli` + 本机 Chrome/Chromium（若本机无 Chrome，`npm run lhci` 跳过并在报告中标注 `skipped`，不算通过）。
- URL：demo 的 `/`、`/list`、`/item/1`、`/login`、`/pricing`；desktop + mobile，每 URL 5 次取中位数。
- 对比：`AGENT_GUARD=off` vs `AGENT_GUARD=on`（on 时开启 robots append 与 `/login` 的 HTML 注释 lure，作为最坏情况）。
- 通过：Performance / Accessibility / Best Practices / SEO 分数差 ≤ 2；LCP 差 ≤ 100 ms；TBT 差 ≤ 50 ms；CLS 差 = 0。

## 4. SEO 结构性检查（针对 demo app，自动化）

| 检查 | 方法 | 通过条件 |
|---|---|---|
| 诱饵不可索引 | 请求 D1–D5 | 全部带 `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`；HTML 带 robots meta |
| robots.txt | append 模式下解析 | 原内容完整保留；decoy 前缀都在 Disallow；真实页面不在 Disallow |
| sitemap | 解析 demo sitemap.xml | 与 decoy 路径交集为空 |
| 无 cloaking | 真实页面用浏览器 UA / Googlebot UA（verified 与 spoofed）各请求一次 | 状态码与正文逐字节一致 |
| 爬虫不进诱饵 | verified Googlebot 请求 D1–D5 | 404，与 app 原生 404 一致 |

> 真实搜索引擎索引表现（Search Console 等）不在本项目验证范围内——项目不部署。

## 5. 报告

`npm run bench` 结束后生成 `docs/bench-v0.1.md`：环境信息、各场景计数、FP、检测率、告警延迟 p50/p95/p99、off/on 的 p50/p99 与差值、内存增量、Lighthouse 结果（或 skipped）。任一 Gate 未过，`npm run bench` 非零退出。
