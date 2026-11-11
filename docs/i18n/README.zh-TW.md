# agent-guard

An AI-agent honeypot middleware for Node and the edge.

（面向 Node 與邊緣執行環境的 AI agent 蜜罐中介軟體。）

[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

## 為什麼需要它

- AI agent 和掃描器會探測 API、讀取 `.env`，並重放它們找到的憑證。
- 隔離的誘餌路由和惰性金絲雀憑證用於偵測這類探測與重放。
- 預設僅偵測並警示：中介軟體記錄事件並傳送非同步警示，不會阻擋、節流或反擊。
- 零執行期相依；Express、Hono、Fastify 與 Koa 為可選 peer。目前面向 Node ≥20；邊緣執行環境已列入路線圖。

**它是什麼 / 不是什麼。** agent-guard 用於偵測、誘捕並觀察針對你的 API 的敵對或探測性 AI agent 流量。它不會反擊或攻擊任何人。完整的非目標清單見[它不是什麼](#它不是什麼)。

面向 Node ≥20 的 HTTP 中介軟體：五條隔離的誘餌路由與惰性金絲雀憑證，用於偵測憑證重放與探索式掃描。它會記錄事件並發送非同步警示。執行期相依套件為零；Express 為可選 peer。Apache-2.0，著作權 2026 Wesley Wang。

這是一個開源研究專案，尚未發佈到 npm。請從原始碼安裝，或使用 `npm pack` 建立本機 tarball。目前的套件名稱為 `@imwyvern/agent-guard`。

請參閱[安全性政策](../../SECURITY.md)、[貢獻指南](../../CONTRIBUTING.md)和[路線圖](../roadmap.md)。

## 本機安裝與驗證

本工作區已安裝開發工具。請勿在此安裝額外相依套件。

```sh
npm run build
npm run typecheck
npm run lint          # strict-compiler lint (tsc --noUnusedLocals --noUnusedParameters)
npm test
npm run test:coverage
npm run bench
npm pack --dry-run
```

若要在單獨的本機使用端使用，用 `npm pack` 建立 tarball，並安裝 `./imwyvern-agent-guard-0.1.0.tgz`。tarball 只包含 `dist/`、`schema/`、readme/changelog 以及法律聲明。`private: true` 可避免發佈。

## Express

```ts
import express from 'express';
import { createAgentGuard, consoleAdapter } from '@imwyvern/agent-guard';
import { agentGuard } from '@imwyvern/agent-guard/express';

const guard = createAgentGuard({
  project: 'local-catalog', env: 'demo', mode: 'detect',
  projectSeed: 'stable-project-seed',
  canary: {
    secret: process.env.AG_CANARY_SECRET!, // operator-supplied HMAC secret
    registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] },
  },
  alerts: { adapters: [consoleAdapter()] },
  lures: { robots: 'append' },
});
const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(agentGuard(guard)); // body parsers must precede the guard
app.get('/', (_req, res) => res.send('<h1>Local catalog</h1>'));
app.use((_req, res) => res.status(404).send('Not Found\n'));
const server = app.listen(3000, '127.0.0.1');
// On shutdown: stop accepting requests, then await guard.close() to flush alerts.
```

若使用登錄檔案名稱，請先以 CLI 準備該檔案。空的登錄會在記憶體中產生六個規範的誘餌金絲雀。若權杖必須在重新啟動後保持穩定，請用 CLI 持久化登錄中的放置位置。種子只控制無害的假資料；金絲雀 ID 仍保持密碼學隨機。

## 原生 Node HTTP

```ts
import { createServer } from 'node:http';
import { agentGuardNode, wrap } from '@imwyvern/agent-guard/node';

// Reuse the guard configured above.
const middleware = agentGuardNode(guard);
const server = createServer((req, res) => {
  // If this host parses a body, attach the bounded parsed value as req.body
  // before calling middleware. The guard never consumes the request stream.
  middleware(req, res, () => {
    res.statusCode = 404;
    res.end('Not Found\n');
  });
});
// Equivalent for a host that already provides req.body:
const listener = wrap(guard, (_req, res) => res.end('Hello'));
```

`inspect(AGRequest)` 回傳 `{ action: 'pass', events }` 或 `{ action: 'respond', response, events }`。直接呼叫核心的使用者需自行處理核心給出的普通 `404`。轉接器會把已驗證的爬蟲交回主機，以保留其原生的缺失路由回應。請預留誘餌路徑：若某條誘餌與真實路由衝突，請停用或覆寫該誘餌。

可選的 robots/HTML/llms 轉換在選定路徑上最多緩衝 1 MiB；一般資料流會直接通過。請安裝在壓縮之前。轉換只套用在成功且未壓縮的回應。只有登入頁的 HTML 註解會在明確啟用時改動真實 HTML 頁面。

## Hono（Node 執行環境）

v0.2 的 Hono 轉接器以 `@imwyvern/agent-guard/hono` 提供，並帶可選的 `hono` peer。它要求 Node ≥20：共用核心仍使用 `node:crypto` 和 Node DNS。Edge 執行環境與 WebCrypto 核心屬於路線圖中的 v0.3 工作。

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { agentGuard } from '@imwyvern/agent-guard/hono';

// Reuse the guard configured in the Express example.
const app = new Hono();
app.use('*', agentGuard(guard));
app.post('/login', async c => c.json(await c.req.json()));
app.get('/', c => c.text('Local catalog'));
app.notFound(c => c.text('Not Found\n', 404));
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 3000 });
```

請在使用端應用程式中安裝 Hono 以及你的 Node 伺服器整合。本儲存庫只將二者作為開發相依套件安裝；轉接器不增加執行期相依套件。`agentGuard` 接受 guard 或 config，從複製的請求中掃描符合條件的請求主體，上限為設定的 body cap（預設 16 KiB），並讓下游處理常式仍可使用原始請求主體。支援 JSON 和表單請求主體；格式錯誤或被截斷的輸入會按有界文字掃描。主機仍負責傳輸大小限制和讀取 body 的期限。`@hono/node-server` 提供 socket IP；轉送標頭需要明確受信任的 `clientIp` 回呼。

偵測仍然僅為警示：金絲雀重放會繼續到達主機，誘餌帶有 noindex/no-store 標頭，已驗證的爬蟲會到達主機原生的缺失路由處理常式。可選的 robots/HTML/llms 轉換保留既有的 1 MiB 緩衝上限。執行 `npm run demo:hono`（`PORT` 和 `AGENT_GUARD=off` 的用法與其他目錄示範相同）。Hono 執行與 Express 和 Node 相同的共用驗收套件。

## Fastify 與 Koa（Node 執行環境）

v0.3a（未發佈）新增 `@imwyvern/agent-guard/fastify` 與 `@imwyvern/agent-guard/koa` 的 `agentGuard`，接受相同的 guard 或 config。在路由之前透過 `await app.register(agentGuard(guard))` 註冊 Fastify 外掛；檢查在請求主體剖析後的 `preHandler` 中執行。Koa 使用 `app.use(agentGuard(guard))`，放在有界請求主體剖析器之後。兩個轉接器均不消費請求串流，並保留主機原生的爬蟲 404、僅警示的重放偵測及可選 lure 轉換；框架為可選 peer，核心不增加執行期相依套件。見 [Fastify 示範](../../examples/fastify-demo/server.ts)、[Koa 示範](../../examples/koa-demo/server.ts)和[轉接器指南](../community.md)。邊緣執行環境仍屬路線圖工作。

## MCP / LLM 工具端點誘餌

```sh
npm run demo:mcp
curl -s http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"export_customer_records","arguments":{}}}'
```

本機 Node HTTP 範例在 `POST /mcp` 實作了最小的 JSON-RPC `initialize`、`tools/list` 和 `tools/call`。`echo` 和 `get_time` 是無害的真實工具。呼叫列出的 `export_customer_records` 誘餌會透過正常警示管線發出 `decoy_hit`（`decoy.id: "MCP"`），並回傳 JSON-RPC 權限錯誤。它不執行任何業務操作，也不回傳紀錄、密鑰或金絲雀。真實工具呼叫仍然僅為警示，包括在工具參數中進行一般的惰性金絲雀重放偵測。

根匯出提供 `mcpDecoyTools`、`inspectMcpRequest(guard, request, toolName?)` 和 `lintMcpDecoyDescription`。在有界剖析之後呼叫一次該輔助函式，僅在 `tools/call` 時傳入工具名稱；將 `crawler_bypass` 按主機原生 404 處理。此範例同樣把這一點用於探索階段，因此已驗證的爬蟲永遠看不到誘餌工具。所有 MCP JSON 回應均為 noindex/no-store。內建描述是中性資料，測試會拒絕祈使語氣、URL 和隱藏字元。本範例是有限的 HTTP 場景，不包含完整的 MCP Streamable HTTP、工作階段或 SSE 支援。OWASP MCP01/MCP08 威脅對應、schema 細節與整合界限見 [MCP 場景與安全規則（中文）](../scenarios/mcp.md)。

## GraphQL 與純 API 場景

v0.3a 匯出 `graphqlDecoys()` 與 `inspectGraphqlRequest(guard, request)`。將回傳的欄位/類型中繼資料加入主機 schema，讓 introspection 列出 `internalAdminUsers`；在有界請求主體剖析之後、執行之前檢查一次。選中誘餌會發出 `decoy_hit`（`decoy.id: "GQL"`），並回傳帶 noindex/no-store 的標準 GraphQL `FORBIDDEN` 錯誤；該請求不會執行真實 resolver。誘餌本身也應設定惰性的錯誤 resolver。真實查詢繼續交給主機；格式錯誤或超限的查詢交給主機驗證器。已驗證爬蟲到達主機原生 404。見 [GraphQL 示範](../../examples/graphql-demo/server.ts)，執行 `npm run demo:graphql`。

沒有 HTML 的 API 請參閱[純 API 指南](../scenarios/api-only.md)：將惰性金絲雀放在 OpenAPI `example`、誘餌錯誤的 `docs_url` 與隔離的 `/.well-known/` 檔案中，並說明 SDK 與文件用戶端的誤報界限。

## 設定

每個公開欄位的預設值記錄在 [src/types.ts](../../src/types.ts)。必填欄位：`project`、`env`、`mode: 'detect'`、`projectSeed`，以及 `canary.secret`/`canary.registry`。

| 選項 | 預設值 / 行為 |
| --- | --- |
| `canary.prefix` | `AG-CANARY-`；模式 `^[A-Z][A-Z0-9]{1,15}-CANARY-$` |
| `canary.registry` | 必填的 version-1 物件或 JSON 路徑；其中不儲存任何 secret |
| `incident.windowMs` | 900000；固定 15 分鐘關聯窗口，0 關閉；僅附加中繼資料 |
| `decoys.enabled` | D1–D5；`/.env` 別名、admin 子樹、ops notes、OpenAPI、假登入 |
| `decoys.basePath` | `/api/internal` |
| `decoys.paths` / `siteName` | 可選路徑覆寫 / `.invalid` 電子郵件網域 |
| `lures.robots` | `manual`；`append` 保留主機的 robots 回應，`off` 停用整合 |
| `lures.htmlComment` | `false`；`{ paths: ['/login'] }` 選擇啟用；每頁 ≤120 bytes |
| `lures.llmsTxt` | `false`；只向既有的成功回應附加一筆參照 |
| `canaryScan.headers` / `query` | 均為 `true`；路徑一律掃描 |
| `canaryScan.bodyPaths` / `maxBodyBytes` | `['/login', '/api/auth/*']` / 16384；D5 一律掃描 |
| `crawler.verify` / `timeoutMs` / `failOpen` | `true` / 300 / `true` |
| `crawler.resolver` | Node DNS；可注入 `{ reverse, resolve }` 以供離線使用 |
| `crawler.extraSuffixes` / `ipRangesFile` | 可選的爬蟲家族後綴 / 離線 JSON `{ google: ['CIDR'] }` |
| `allowlist` | 可選的精確 `ips`、IPv4/IPv6 `cidrs`、`uaPatterns`、精確 `headerToken` |
| `alerts.adapters` | 無預設目的地；提供 `webhookAdapter()` 和 `consoleAdapter()` |
| `alerts.minSeverity` | 誘餌/重放為 `info`；明確取值還會啟用 probe/discovery 升級 |
| `alerts.dedupeWindowSec` | 600；同一事件 + placement/ID + client key |
| `alerts.ratePerMinute` | 每通道 30；被抑制的計數會帶到下一則警示摘要中 |
| `alerts.redactIp` | `true`；警示中使用粗略的 IPv4/IPv6 網段 |
| `log.sink` / `level` / `keepIp` | stdout JSONL / `info` / `true` |
| `clientIp` | socket IP；僅在驗證受信任的代理之後再覆寫 |
| `onEvent` | 可選觀察者；觀察者/sink 失敗會被隔離 |

`guard.robotsLines()` 支援手動 robots 整合。`guard.htmlCommentFor(path)` 回傳可選註解或 null。`guard.metrics()` 回傳請求/事件/傳遞計數，以及有界的近期 inspect 延遲分位數。分數是依執行個體的有界觀測值，從不作為強制執行依據。用戶端狀態：50k 筆，30 分鐘閒置 TTL；爬蟲快取：10k，陽性 24h / 陰性 1h。任何轉送標頭都不會被自動信任。

D5 一律拒絕登入，並帶有確定性的 300–600ms 延遲。所有誘餌均為 `noindex`、`no-store`，≤8KiB，只使用 `.invalid` 主機名稱，且從不建立 cookie、進行驗證或呼叫業務服務。已宣告的 AI 爬蟲誘餌命中嚴重程度為 `info`。搜尋爬蟲的 DNS 檢查只發生在誘餌路由上。錯誤/逾時會以 fail open 落到原生 404。

## 事件關聯與金絲雀傳播追蹤

v0.3a 為同一 `client_key` 的既有事件附加可選 `incident`：`id`、有序 `sequence`（例如 `robots → D1 → D2`）、`first_seen`、`last_seen` 和 `confidence`。`incident.windowMs` 預設為 900000（從首次觀察起固定 15 分鐘）；0 關閉關聯。狀態使用 50k 用戶端 LRU，保留最近 32 次觀察。重複的孤立命中信心等級為 low；不同誘餌或探索加誘餌升為 medium；`canary_replay` 升為 high。同一窗口內信心等級不會降低。robots 存取僅作內部標記，不增加事件類型。共用網路可能合併用戶端；關聯只補充觀察資訊，永不改變嚴重程度、HTTP 回應、爬蟲繞過或誘餌決策。`mode` 仍只接受 `detect`。

重放警示保留 `canary.id`、`placement`、`env`、`found_in`、`field`，新增 `leaked_at`（放置位置）、`replayed_at`（路徑）、`dwell_ms`（首次誘餌下發至重放的時間）與 `client_keys_seen`（不同重放用戶端鍵的數量，上限 8）。只有回傳的誘餌回應主體包含權杖時才記錄下發；HEAD 與爬蟲繞過不計。追蹤僅存在於處理程序內，使用 50k 筆 LRU 與 24 小時 TTL。淘汰、重新啟動或內建誘餌之外的下發會使時間未知，因此省略 `dwell_ms`。這些觀察無法證明身分或惡意意圖。

## 警示與簽章

```ts
import { webhookAdapter, verifyWebhookSignature } from '@imwyvern/agent-guard';
const adapter = webhookAdapter({
  url: 'http://127.0.0.1:4000/events', secret: process.env.AG_WEBHOOK_SECRET!,
  timeoutMs: 5000,
});
// Receiver: verify the ORIGINAL body string before parsing JSON.
const valid = verifyWebhookSignature({
  body: rawBody, timestamp: timestampHeader, signature: signatureHeader,
  secret: process.env.AG_WEBHOOK_SECRET!, toleranceSec: 300,
});
```

HMAC 輸入為 `timestamp + '.' + body`；標頭為 `X-AgentGuard-Timestamp` 和 `X-AgentGuard-Signature: sha256=<hex>`。重新導向會被拒絕。接收端還應另外對事件 ID 去重，以拒絕時間戳記窗口內的重複傳遞。傳遞以非同步方式執行，使用八個 worker、有界佇列、5s 嘗試期限和兩次重試；`close()` 會刷出待傳遞項目。Webhook 專用期限可以更短。警示紀錄只包含請求中繼資料和金絲雀 ID/來源，從不包含 body 或 Cookie/Authorization 的值。摘要計數代表被抑制的通知，並隨下一則被接受的警示發出，而不是由背景計時器發出。探測/探索流量預設只記錄日誌，不發警示。

## 金絲雀 CLI

```sh
# Set AG_CANARY_SECRET in your environment; never commit it.
node dist/cli/main.js canary new --env demo --placement 'D1:/.env#ADMIN_API_TOKEN'
node dist/cli/main.js canary list
node dist/cli/main.js canary scan ./config
node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
node dist/cli/main.js report --since 7d ./events.jsonl
node dist/cli/main.js lint ./config
```

`agent-guard lint <path>`（或上面的已建置 CLI）檢查內建誘餌/lure 輸出及放置檔案中的祈使語句、隱藏字元、非保留 URL 主機名稱與真實廠商密鑰前綴。發現問題結束代碼為 1；用法錯誤為 2。它檢查放置安全性；權杖意外洩漏另用 `canary scan` 檢查。

建立登錄時，`canary new` 也接受 `--prefix ACME-CANARY-` 以及 `--registry <file>`。當規範前綴或登錄權杖出現在登錄/`src/decoys/*.ts` 白名單之外時，掃描以結束代碼 1 結束並輸出 `file:line`；用法錯誤以結束代碼 2 結束。符號連結以及 `.git`、`node_modules`、`dist`、`coverage` 會被略過。請掃描指定的設定目錄，以避免命中文件/測試中有意放置的範例。登錄的精確比對允許在密鑰輪替後仍辨識舊權杖。`report` 彙總觀察到的事件/傳遞延遲；誤報率/偵測率需要帶標註的模擬工作階段。

採用專案的 CI 步驟範例（只使用已建置的 CLI）：

```yaml
- name: Prevent canaries in real configuration
  run: node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
```

## 示範與基準測試

```sh
npm run demo:express
npm run demo:hono
npm run demo:fastify
npm run demo:koa
npm run demo:graphql
npm run demo:mcp
PORT=3001 npm run demo:node
AGENT_GUARD=off npm run demo:express
npm run bench:simulate
npm run bench:exhaust-sim
npm run bench:deception-lint
npm run bench:latency
npm run bench:latency:hr
npm run lhci
npm run bench
```

示範預設使用 `PORT=3000`、`AGENT_GUARD=on`、主控台警示，以及離線注入的 DNS。可選的 `AG_WEBHOOK_URL` 會啟用帶簽章的 webhook；`AG_WEBHOOK_SECRET` 和 `AG_CANARY_SECRET` 可覆寫本機示範用密鑰。這些示範預設值僅供本機研究使用。

兩個示範共用 `/`、`/list`、`/item/:id`、`/login`、`/logout`、`/pricing`、robots/sitemap/靜態內容，以及原生 404。示範登入使用 `demo@example.invalid` / `demo-password`。基準測試在兩個示範上以指定的工作階段數與固定種子執行 S1–S5，驗證已簽章警示是否送達，執行延遲預熱 + 三次執行的中位數，並檢查 50k 用戶端記憶體。在 TCP 可用時，每次執行會用 autocannon 跑 30 seconds / 100 connections。Lighthouse 使用本機 Chrome、`--headless --no-sandbox`、兩種裝置形態、五個 URL，以及每個 URL/mode/demo 五次執行。

對正在執行的示範做快速手動檢查（第二個終端機）：

```sh
PORT=3000 npm run demo:express          # or: npm run demo:node
curl -s -A 'Mozilla/5.0 Chrome/130' http://127.0.0.1:3000/   # real page, no event
TOKEN=$(curl -s http://127.0.0.1:3000/.env | sed -n 's/^ADMIN_API_TOKEN=//p')   # decoy_hit (high)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/internal/admin/users   # canary_replay (critical)
```

示範終端機會列印單行 JSON 事件和主控台警示。所有權杖都是惰性的 `AG-CANARY-` 字串，無法解鎖任何內容。

自 v0.2 起，`npm run bench:latency:hr` 是 Express、Node 和 Hono 的主要 AC-10 量測方式：隔離的 keep-alive 用戶端/伺服器、微秒級計時、在 100/10 connections 下交錯三次執行，以及核心 inspect 的 ns/op（約 3 分鐘）。門檻仍為 Δp50 ≤200 µs、Δp99 ≤1000 µs，以及 50k-client heap ≤10 MB；只有 100-connection 那一列決定延遲是否通過。見 [v0.2 結果與設定](../bench-v0.2.md)；原始 JSON 為 `bench/results/latency-hr.json`，其中包含歷史 autocannon 的次要證據。原來的 `bench` 命令仍保留其 v0.1 的 autocannon 門檻檢查。

量測門檻檢查失敗會使基準測試以非零結束代碼結束。`bench:latency` 在各自的子行程中執行每個示範伺服器，並用 autocannon 驅動（100 connections，30 s，3 次執行的中位數）；它還會記錄一次非門檻的固定速率執行，以及由吞吐量推導的每請求額外開銷估計。完整矩陣的 Lighthouse 大約需要 35 分鐘。若沙盒禁止本機 socket，研究工具會在記憶體中的 Duplex 資料流上使用實際的 HTTP 請求/回應物件；TCP 延遲仍為 **未驗證**。Chrome 啟動失敗會被 **略過**，而不是記為通過。確切的環境限制見 [基準測試報告](../bench-v0.1.md) 和 [實作說明](../implementation-notes.md)。本程式庫不包含此測試工具。

自 v0.3b 起，`npm run bench:exhaust-sim` 在記憶體中以腳本化的貪婪 agent 對有界迷宮做成本比模擬，`npm run bench:deception-lint` 則對現有誘餌輸出與確定性人設原型做安全掃描。這兩條命令都不改變執行期行為；`mode` 仍只接受 `detect`。見 [v0.3b 離線評估](../bench-v0.3b.md)。

## 它不是什麼

它不是 WAF、DDoS 防禦、驗證系統、機器人封鎖器、正式環境部署，也不保證搜尋引擎行為。沒有自動封鎖、流量節流、trap 模式、迷宮、反向提示注入、出站探測、真實廠商憑證，或第三方回呼 honeytoken。Slack/Telegram/Feishu/email 以及 Edge 轉接器仍屬後續工作。Hono 轉接器已面向 Node ≥20 提供。機械計時和 Prometheus 端點是可選的設計構想，在 v0.1 中未啟用。

## 路線圖與設計文件

- [社群參與](../community.md) — 如何貢獻轉接器、偵測特徵、譯本和 RFC。
- [路線圖](../roadmap.md) — 規劃中的 v0.3/v0.4 工作。Exhaust 與 Deception 目前是設計草案，預設關閉。
- [Exhaust](../exhaust.md) — 對已確認惡意工作階段的有界成本施加（延遲、迷宮、上下文消耗）。
- [Deception](../deception.md) — 提高誘餌資料的可信度，讓攻擊者的 agent 可能把它當成真實資料。
- [設計](../design.md)、[合約](../codex-contract.md)、[KPI](../kpi.md)和[威脅模型](../threat-model.md)。既有文獻僅用於啟發概念；並未複製任何第三方專案程式碼。
