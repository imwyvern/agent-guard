# agent-guard

An AI-agent honeypot middleware for Node and the edge.

（Node とエッジ向けの AI エージェント・ハニーポット・ミドルウェア。）

[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

## なぜ必要か

- AI エージェントとスキャナは API を探索し、`.env` を読み、見つけた認証情報をリプレイします。
- 隔離されたデコイルートと不活性なカナリア認証情報により、そのような探索とリプレイを検出します。
- 既定は検出とアラートのみです。ミドルウェアはイベントを記録し、非同期でアラートを送りますが、遮断・制限・反撃はしません。
- ランタイム依存関係はゼロです。Express、Hono、Fastify、Koa はオプションの peer です。現在は Node ≥20 向けで、エッジランタイムはロードマップ上にあります。

**対象と非対象。** agent-guard は、API に向かう敵対的または探索的な AI エージェントのトラフィックを検出・誘捕・観測します。反撃したり、誰かを攻撃したりはしません。詳細は[対象外であること](#対象外であること)を参照してください。

Node ≥20 向けの HTTP ミドルウェアです。隔離された 5 つのデコイルートと不活性なカナリア認証情報により、認証情報のリプレイと探索的スキャンを検出します。イベントを記録し、非同期でアラートを送信します。ランタイム依存関係はゼロで、Express はオプションの peer です。Apache-2.0、著作権 2026 Wesley Wang。

これはオープンソースの研究プロジェクトであり、まだ npm には公開されていません。ソースからインストールするか、`npm pack` でローカル tarball を作成してください。作業中のパッケージ名は `@imwyvern/agent-guard` です。

[セキュリティポリシー](../../SECURITY.md)、[コントリビューションガイド](../../CONTRIBUTING.md)、[ロードマップ](../roadmap.md) を参照してください。

## ローカルでのインストールと検証

このワークスペースには開発ツールが既に入っています。ここに追加の依存関係をインストールしないでください。

```sh
npm run build
npm run typecheck
npm run lint          # strict-compiler lint (tsc --noUnusedLocals --noUnusedParameters)
npm test
npm run test:coverage
npm run bench
npm pack --dry-run
```

別のローカル利用側では、`npm pack` で tarball を作成し、`./imwyvern-agent-guard-0.1.0.tgz` をインストールしてください。tarball に含まれるのは `dist/`、`schema/`、readme/changelog、および法的通知のみです。`private: true` により公開は防止されます。

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

レジストリのファイル名を使う場合は、先に CLI で準備してください。空のレジストリは、メモリ上で 6 個の正規デコイカナリアを生成します。再起動後もトークンを安定させる必要がある場合は、CLI でレジストリの配置を永続化してください。シードが制御するのは無害な偽データであり、カナリア ID は暗号学的にランダムなままです。

## ネイティブ Node HTTP

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

`inspect(AGRequest)` は `{ action: 'pass', events }` または `{ action: 'respond', response, events }` を返します。コアを直接使う場合は、コアが出す素の `404` を自分で処理します。アダプターは検証済みクローラーをホストに委譲し、ホスト固有の欠落ルート応答を保ちます。デコイパスは予約してください。実ルートと衝突するデコイは無効化するか上書きしてください。

オプトインの robots/HTML/llms 変換は、対象パスで最大 1 MiB までバッファします。通常のストリームはそのまま通過します。圧縮より前にインストールしてください。変換は成功した非圧縮レスポンスにのみ適用されます。実在の HTML ページを変更するのは、明示的に有効化した場合のログイン HTML コメントだけです。

## Hono（Node ランタイム）

v0.2 の Hono アダプターは `@imwyvern/agent-guard/hono` として利用でき、オプションの `hono` peer を伴います。Node ≥20 が必要です。共有コアはまだ `node:crypto` と Node DNS を使っています。エッジランタイムと WebCrypto コアはロードマップの v0.3 作業です。

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

利用側アプリケーションに Hono と Node サーバー統合をインストールしてください。このリポジトリは両者を開発依存関係としてのみインストールし、アダプターはランタイム依存関係を追加しません。`agentGuard` は guard または config を受け取り、クローンしたリクエストから対象ボディを、設定されたボディ上限（デフォルト 16 KiB）までスキャンし、元のボディは下流ハンドラーが利用できるまま残します。JSON とフォームボディに対応し、不正または切り詰められた入力は有界テキストとしてスキャンされます。ワイヤーサイズ制限とボディ読み取り期限は、引き続きホストの責任です。`@hono/node-server` がソケット IP を提供します。転送ヘッダーを使う場合は、明示的に信頼した `clientIp` コールバックが必要です。

検出は引き続きアラートのみです。カナリアリプレイはホストへ進み、デコイには noindex/no-store ヘッダーが付き、検証済みクローラーはホスト固有の欠落ルートハンドラーに到達します。オプトインの robots/HTML/llms 変換は、既存の 1 MiB バッファ上限を維持します。`npm run demo:hono` を実行してください（`PORT` と `AGENT_GUARD=off` は他のカタログデモと同じように動作します）。Hono は Express および Node と同じ共有受け入れスイートを実行します。

## Fastify と Koa（Node ランタイム）

v0.3a（未リリース）では `@imwyvern/agent-guard/fastify` と `@imwyvern/agent-guard/koa` の `agentGuard` を追加し、同じ guard または config を受け取ります。Fastify はルートより前に `await app.register(agentGuard(guard))` で登録します。ボディ解析後の `preHandler` で検査します。Koa はサイズ制限付きボディパーサーの後に `app.use(agentGuard(guard))` を配置します。どちらもリクエストストリームを消費せず、ホスト固有のクローラー向け 404、アラートのみのリプレイ検出、オプトインの lure 変換を保ちます。フレームワークはオプションの peer で、コアのランタイム依存関係は増えません。[Fastify デモ](../../examples/fastify-demo/server.ts)、[Koa デモ](../../examples/koa-demo/server.ts)、[アダプターガイド](../community.md)を参照してください。エッジランタイムは引き続きロードマップ上の作業です。

## MCP / LLM ツールエンドポイントのデコイ

```sh
npm run demo:mcp
curl -s http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"export_customer_records","arguments":{}}}'
```

ローカルの Node HTTP の例は、`POST /mcp` で最小限の JSON-RPC `initialize`、`tools/list`、`tools/call` を実装しています。`echo` と `get_time` は無害な実ツールです。一覧にある `export_customer_records` デコイを呼び出すと、通常のアラートパイプライン経由で `decoy.id: "MCP"` 付きの `decoy_hit` が発行され、JSON-RPC の権限エラーが返ります。業務処理は実行せず、レコード、シークレット、カナリアも返しません。実ツール呼び出しは引き続きアラートのみであり、ツール引数に対する通常の不活性カナリアリプレイ検出も含みます。

ルートは `mcpDecoyTools`、`inspectMcpRequest(guard, request, toolName?)`、`lintMcpDecoyDescription` をエクスポートします。有界パースの後にヘルパーを一度呼び、ツール名は `tools/call` のときだけ渡してください。`crawler_bypass` はホスト固有の 404 として扱います。この例では発見にも同じ処理を適用するため、検証済みクローラーがデコイツールを見ることはありません。すべての MCP JSON レスポンスは noindex/no-store です。組み込みの説明は中立なデータであり、テストは命令的な言い回し、URL、隠し文字を拒否します。この例は限定的な HTTP シナリオであり、完全な MCP Streamable HTTP、セッション、SSE は含みません。OWASP MCP01/MCP08 の脅威マッピング、スキーマの詳細、統合の境界については、[MCP シナリオと安全ルール（中文）](../scenarios/mcp.md) を参照してください。

## GraphQL と API 専用シナリオ

v0.3a は `graphqlDecoys()` と `inspectGraphqlRequest(guard, request)` をエクスポートします。返されたフィールド/型のメタデータをホストのスキーマに加え、introspection に `internalAdminUsers` を表示し、有界なボディ解析後、実行前に一度検査します。デコイが選択されると `decoy_hit`（`decoy.id: "GQL"`）を発行し、noindex/no-store 付きの標準 GraphQL `FORBIDDEN` エラーを返します。そのリクエストでは実際の resolver を実行しません。デコイ自体にも不活性なエラー resolver を設定してください。通常のクエリは通過し、不正または上限超過のクエリはホストの検証器に委譲します。検証済みクローラーはホスト固有の 404 に進みます。[GraphQL デモ](../../examples/graphql-demo/server.ts)を参照し、`npm run demo:graphql` を実行してください。

HTML のない API については [API 専用ガイド](../scenarios/api-only.md)を参照してください。OpenAPI の `example`、デコイエラーの `docs_url`、隔離された `/.well-known/` ファイルへの不活性カナリア配置と、SDK やドキュメントクライアントの誤検出の境界を説明します。

## 設定

公開フィールドすべてのデフォルトは [src/types.ts](../../src/types.ts) に記載されています。必須フィールドは `project`、`env`、`mode: 'detect'`、`projectSeed`、および `canary.secret`/`canary.registry` です。

| オプション | デフォルト / 動作 |
| --- | --- |
| `canary.prefix` | `AG-CANARY-`；パターン `^[A-Z][A-Z0-9]{1,15}-CANARY-$` |
| `canary.registry` | 必須の version-1 オブジェクトまたは JSON パス。secret は格納されない |
| `incident.windowMs` | 900000；固定 15 分の相関窓、0 で無効化；メタデータのみ |
| `decoys.enabled` | D1–D5；`/.env` エイリアス、admin サブツリー、ops notes、OpenAPI、偽ログイン |
| `decoys.basePath` | `/api/internal` |
| `decoys.paths` / `siteName` | 任意のパス上書き / `.invalid` メールドメイン |
| `lures.robots` | `manual`；`append` はホストの robots 応答を保持し、`off` は統合を無効化 |
| `lures.htmlComment` | `false`；`{ paths: ['/login'] }` でオプトイン；1 ページあたり ≤120 bytes |
| `lures.llmsTxt` | `false`；既存の成功レスポンスに参照を追加するのみ |
| `canaryScan.headers` / `query` | どちらも `true`；パスは常にスキャン |
| `canaryScan.bodyPaths` / `maxBodyBytes` | `['/login', '/api/auth/*']` / 16384；D5 は常にスキャン |
| `crawler.verify` / `timeoutMs` / `failOpen` | `true` / 300 / `true` |
| `crawler.resolver` | Node DNS；オフライン利用には `{ reverse, resolve }` を注入 |
| `crawler.extraSuffixes` / `ipRangesFile` | 任意のクローラーファミリー接尾辞 / オフライン JSON `{ google: ['CIDR'] }` |
| `allowlist` | 任意の完全一致 `ips`、IPv4/IPv6 `cidrs`、`uaPatterns`、完全一致 `headerToken` |
| `alerts.adapters` | デフォルトの宛先なし；`webhookAdapter()` と `consoleAdapter()` を利用可能 |
| `alerts.minSeverity` | デコイ/リプレイは `info`；明示値は probe/discovery のエスカレーションも有効化 |
| `alerts.dedupeWindowSec` | 600；同一イベント + placement/ID + client key |
| `alerts.ratePerMinute` | チャネルあたり 30；抑制件数は次のアラート要約に繰り越し |
| `alerts.redactIp` | `true`；アラート内では粗い IPv4/IPv6 ネットワーク |
| `log.sink` / `level` / `keepIp` | stdout JSONL / `info` / `true` |
| `clientIp` | ソケット IP；信頼できるプロキシを検証したあとでのみ上書き |
| `onEvent` | 任意のオブザーバー；オブザーバー/sink の失敗は隔離される |

`guard.robotsLines()` は手動の robots 統合を支援します。`guard.htmlCommentFor(path)` はオプトインコメントまたは null を返します。`guard.metrics()` はリクエスト/イベント/配送の件数と、有界な直近 inspect タイミング分位数を返します。スコアはインスタンスごとの有界な観測値であり、強制には使いません。クライアント状態：50k エントリ、30 分のアイドル TTL。クローラーキャッシュ：10k、陽性 24h / 陰性 1h。転送ヘッダーは自動的には信頼されません。

D5 は常にログインを拒否し、決定的な 300–600ms の遅延を伴います。すべてのデコイは `noindex`、`no-store`、≤8KiB で、`.invalid` ホスト名のみを使い、cookie の作成、認証、業務サービス呼び出しは行いません。申告済み AI クローラーのデコイヒットは重大度 `info` です。検索クローラーの DNS 検査はデコイルート上でのみ行われます。エラー/タイムアウトは fail open し、ネイティブ 404 になります。

## インシデント相関とカナリア伝播追跡

v0.3a は同じ `client_key` の既存イベントに任意の `incident` を付加します。フィールドは `id`、順序付き `sequence`（例：`robots → D1 → D2`）、`first_seen`、`last_seen`、`confidence` です。`incident.windowMs` の既定値は 900000（最初の観測から固定 15 分）、0 は相関を無効化します。状態は 50k クライアントの LRU に収め、直近 32 観測を保持します。単独ヒットの反復は low、異なるデコイまたは発見とデコイの組み合わせは medium、`canary_replay` は high に上げます。同じ窓内で確信度は下がりません。robots の訪問は内部マーカーで、イベント型を追加しません。共有ネットワークではクライアントが統合され得ます。相関は観測情報の補足のみで、重大度、HTTP 応答、クローラーバイパス、デコイ判断を変更しません。`mode` は引き続き `detect` のみです。

リプレイアラートは `canary.id`、`placement`、`env`、`found_in`、`field` を保ち、`leaked_at`（配置）、`replayed_at`（パス）、`dwell_ms`（最初のデコイ配信からの時間）、`client_keys_seen`（異なるリプレイクライアントキー数、最大 8）を追加します。返すデコイボディにトークンが含まれる場合だけ配信を記録し、HEAD とクローラーバイパスは数えません。追跡はプロセス内のみで、50k 件の LRU と 24 時間 TTL を使います。追い出し、再起動、組み込みデコイ以外での配信では時刻が不明となり、`dwell_ms` を省略します。これらの観測は身元や悪意の証明にはなりません。

## アラートと署名

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

HMAC の入力は `timestamp + '.' + body`、ヘッダーは `X-AgentGuard-Timestamp` と `X-AgentGuard-Signature: sha256=<hex>` です。リダイレクトは拒否されます。受信側はさらにイベント ID を重複排除し、タイムスタンプ窓内の重複配送を拒否すべきです。配送は非同期で、8 個のワーカー、有界キュー、5s の試行期限、2 回のリトライで動き、`close()` は保留中の配送をフラッシュします。Webhook 固有の期限はより短くできます。アラート記録に含まれるのはリクエストメタデータとカナリア ID/来歴のみで、body や Cookie/Authorization の値は含まれません。サマリー件数は抑制された通知を表し、バックグラウンドタイマーではなく、次に受理されたアラートと一緒に出されます。probe/discovery トラフィックは、デフォルトではアラートせずにログのみです。

## カナリア CLI

```sh
# Set AG_CANARY_SECRET in your environment; never commit it.
node dist/cli/main.js canary new --env demo --placement 'D1:/.env#ADMIN_API_TOKEN'
node dist/cli/main.js canary list
node dist/cli/main.js canary scan ./config
node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
node dist/cli/main.js report --since 7d ./events.jsonl
node dist/cli/main.js lint ./config
```

`agent-guard lint <path>`（または上記のビルド済み CLI）は、組み込みデコイ/lure 出力と配置ファイルの命令表現、隠し文字、予約外 URL ホスト、実在ベンダーのキー接頭辞を検査します。違反は終了コード 1、用法エラーは 2 です。配置の安全性を検査するもので、意図しないトークン漏洩は別途 `canary scan` で検査します。

レジストリ作成時、`canary new` は `--prefix ACME-CANARY-` と `--registry <file>` も受け付けます。正規プレフィックスまたはレジストリトークンが、レジストリ/`src/decoys/*.ts` ホワイトリストの外に現れた場合、スキャンは `file:line` を出して終了コード 1 で終了します。用法エラーは終了コード 2 です。シンボリックリンクと `.git`、`node_modules`、`dist`、`coverage` はスキップされます。意図的なドキュメント/テスト例に当たらないよう、対象を絞った設定ディレクトリをスキャンしてください。レジストリの完全一致により、シークレットローテーション後も古いトークンを許可します。`report` は観測されたイベント/配送遅延を要約します。FP/検出率には、ラベル付きのシミュレーションセッションが必要です。

採用プロジェクト向け CI ステップの例（ビルド済み CLI のみを使用）：

```yaml
- name: Prevent canaries in real configuration
  run: node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
```

## デモとベンチマーク

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

デモのデフォルトは `PORT=3000`、`AGENT_GUARD=on`、コンソールアラート、オフライン注入 DNS です。任意の `AG_WEBHOOK_URL` は署名付き webhook を追加し、`AG_WEBHOOK_SECRET` と `AG_CANARY_SECRET` はローカルデモ用シークレットを上書きします。これらのデモデフォルトはローカル研究向けです。

両方のデモは `/`、`/list`、`/item/:id`、`/login`、`/logout`、`/pricing`、robots/sitemap/静的コンテンツ、およびネイティブ 404 を共有します。デモのログインは `demo@example.invalid` / `demo-password` です。ベンチマークは指定のセッション数と固定シードで、両方のデモに対して S1–S5 を実行し、署名付きアラートの到着を検証し、レイテンシのウォームアップ + 3 回実行の中央値を取り、50k クライアントのメモリを確認します。TCP が利用可能な場合は、各実行で autocannon を 30 seconds / 100 connections で走らせます。Lighthouse はローカル Chrome、`--headless --no-sandbox`、両方のフォームファクター、5 つの URL、および URL/mode/demo ごとに 5 回の実行を使います。

稼働中のデモに対する簡単な手動確認（2 つ目のターミナル）：

```sh
PORT=3000 npm run demo:express          # or: npm run demo:node
curl -s -A 'Mozilla/5.0 Chrome/130' http://127.0.0.1:3000/   # real page, no event
TOKEN=$(curl -s http://127.0.0.1:3000/.env | sed -n 's/^ADMIN_API_TOKEN=//p')   # decoy_hit (high)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/internal/admin/users   # canary_replay (critical)
```

デモのターミナルは 1 行の JSON イベントとコンソールアラートを表示します。すべてのトークンは不活性な `AG-CANARY-` 文字列であり、何も解除しません。

v0.2 以降、Express、Node、Hono の主要な AC-10 測定は `npm run bench:latency:hr` です。隔離された keep-alive のクライアント/サーバー、µs 分解能の計測、100/10 connections での 3 回の交互実行、およびコア inspect の ns/op（約 3 分）です。しきい値はこれまでどおり Δp50 ≤200 µs、Δp99 ≤1000 µs、50k-client heap ≤10 MB で、レイテンシの合否は 100-connection の行だけが決めます。[v0.2 の結果と設定](../bench-v0.2.md) を参照してください。生 JSON は `bench/results/latency-hr.json` で、過去の autocannon による二次的証拠も含みます。もともとの `bench` コマンドは、v0.1 の autocannon ゲートを維持しています。

測定ゲートの失敗は、ベンチマークを非ゼロ終了にします。`bench:latency` は各デモサーバーを専用の子プロセスで起動し、autocannon で負荷をかけます（100 connections、30 s、3 回実行の中央値）。ゲート対象外の固定レート実行と、スループットから導出したリクエストあたりオーバーヘッドの見積もりも記録します。Lighthouse のフルマトリックスには約 35 分かかります。サンドボックスがローカルソケットを禁じている場合、研究用ハーネスはメモリ上の Duplex ストリーム越しに実際の HTTP リクエスト/レスポンスオブジェクトを使います。TCP レイテンシは **未検証** のままです。Chrome の起動失敗は合格ではなく **スキップ** です。正確な環境上の制約は [ベンチマークレポート](../bench-v0.1.md) と [実装ノート](../implementation-notes.md) を参照してください。このライブラリにこのハーネスは含まれません。

v0.3b 以降、`npm run bench:exhaust-sim` はスクリプト化された貪欲 agent に対する有界迷路のコスト比シミュレーションをメモリ上で実行し、`npm run bench:deception-lint` は現行のデコイ出力と決定論的なペルソナ原型を安全スキャンします。いずれのコマンドもランタイムの動作は変えず、`mode` は引き続き `detect` のみを受け付けます。[v0.3b のオフライン評価](../bench-v0.3b.md) を参照してください。

## 対象外であること

WAF、DDoS 防御、認証システム、ボットブロッカー、本番デプロイ、検索エンジン動作の保証ではありません。自動ブロック、トラフィック制限、trap モード、迷路、リバースプロンプトインジェクション、外向きプロービング、実在ベンダーの認証情報、第三者コールバックの honeytoken はありません。Slack/Telegram/Feishu/email および Edge アダプターは今後の作業です。Hono アダプターはすでに Node ≥20 向けに提供されています。機械的タイミングと Prometheus エンドポイントは任意の設計アイデアであり、v0.1 では有効化されていません。

## ロードマップと設計ドキュメント

- [コミュニティ](../community.md) — アダプター、検出シグネチャ、翻訳、RFC の貢献方法。
- [ロードマップ](../roadmap.md) — 予定している v0.3/v0.4 の作業です。Exhaust と Deception は設計草案であり、デフォルトでは無効です。
- [Exhaust](../exhaust.md) — 確認済みの悪意あるセッションに対する有界のコスト賦課（遅延、迷路、コンテキスト消費）。
- [Deception](../deception.md) — デコイデータをより信じられるものにし、攻撃者の agent がそれを本物として扱う可能性を高める。
- [設計](../design.md)、[契約](../codex-contract.md)、[KPI](../kpi.md)、[脅威モデル](../threat-model.md)。先行事例は概念の参考にすぎず、第三者プロジェクトのコードは複製していません。
