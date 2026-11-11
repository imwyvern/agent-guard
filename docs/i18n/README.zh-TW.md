# agent-guard

[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

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

## 設定

每個公開欄位的預設值記錄在 [src/types.ts](../../src/types.ts)。必填欄位：`project`、`env`、`mode: 'detect'`、`projectSeed`，以及 `canary.secret`/`canary.registry`。

| 選項 | 預設值 / 行為 |
| --- | --- |
| `canary.prefix` | `AG-CANARY-`；模式 `^[A-Z][A-Z0-9]{1,15}-CANARY-$` |
| `canary.registry` | 必填的 version-1 物件或 JSON 路徑；其中不儲存任何 secret |
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
```

建立登錄時，`canary new` 也接受 `--prefix ACME-CANARY-` 以及 `--registry <file>`。當規範前綴或登錄權杖出現在登錄/`src/decoys/*.ts` 白名單之外時，掃描以結束代碼 1 結束並輸出 `file:line`；用法錯誤以結束代碼 2 結束。符號連結以及 `.git`、`node_modules`、`dist`、`coverage` 會被略過。請掃描指定的設定目錄，以避免命中文件/測試中有意放置的範例。登錄的精確比對允許在密鑰輪替後仍辨識舊權杖。`report` 彙總觀察到的事件/傳遞延遲；誤報率/偵測率需要帶標註的模擬工作階段。

採用專案的 CI 步驟範例（只使用已建置的 CLI）：

```yaml
- name: Prevent canaries in real configuration
  run: node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
```

## 示範與基準測試

```sh
npm run demo:express
PORT=3001 npm run demo:node
AGENT_GUARD=off npm run demo:express
npm run bench:simulate
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

## 它不是什麼

它不是 WAF、DDoS 防禦、驗證系統、機器人封鎖器、正式環境部署，也不保證搜尋引擎行為。沒有自動封鎖、流量節流、trap 模式、迷宮、反向提示注入、出站探測、真實廠商憑證，或第三方回呼 honeytoken。Slack/Telegram/Feishu/email 以及 Edge/Fastify/Hono 轉接器仍屬後續工作。機械計時和 Prometheus 端點是可選的設計構想，在 v0.1 中未啟用。

請參閱[設計](../design.md)、[合約](../codex-contract.md)、[KPI](../kpi.md)和[威脅模型](../threat-model.md)。既有文獻僅用於啟發概念；並未複製任何第三方專案程式碼。
