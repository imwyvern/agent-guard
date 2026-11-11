# agent-guard

An AI-agent honeypot middleware for Node and the edge.

（Node とエッジ向けの AI エージェント・ハニーポット・ミドルウェア。）

[English](../../README.md) | [简体中文](../i18n/README.zh-CN.md) | [繁體中文](../i18n/README.zh-TW.md) | [日本語](../i18n/README.ja.md) | [한국어](../i18n/README.ko.md) | [Español](../i18n/README.es.md)

## なぜ必要か

攻撃者はいま、AI エージェントを使ってサーバーを探査し、設定を読み、見つけた鍵をリプレイします。agent-guard は、アプリケーションの HTTP/API 層に隔離された偽の設定・鍵・エンドポイント（何の権限も開かない不活性カナリア）を仕掛けます。攻撃者の AI がそれらに触れたとき、高い確度の早期アラートと、鍵のローテーション、アクセス制限、ホスト停止といった対応に使える時間の窓が得られます。

これはサーバーにおける最後のトリップワイヤであり、早期警戒 / 遅延の層です。パッチ適用、WAF、最小権限の代替ではありません。既定モードは検出とアラートのみです。オプションで、デフォルト無効の trap モードは確認済みクライアントを遅延またはレート制限できますが、攻撃を遮断すると主張しません。

**現在提供しているものと、まだ提供していないもの。**

- **現在**の対象は HTTP/API 層です。隔離された 5 つのデコイルート、MCP および GraphQL デコイ、不活性カナリア認証情報（`AG-CANARY-…`）。ランタイム依存関係はゼロで、Node ≥20 向けに Express、Node `http`、Hono、Fastify、Koa のアダプターがあります。加えて v0.4b の Web / Edge アダプター（未リリース）を提供します。
- **ホストレベルの honeyfile**（ディスク上の偽の `.env`、クラウド認証情報、SSH 鍵、kubeconfig と、アクセス時のアラート）は**計画中**であり、未実装です。将来の `agent-guard seed` コマンドは[ロードマップ](../roadmap.md)にあります。
- **「偽の成功」による欺瞞** — 攻撃者の AI に侵入が成功したと信じさせる可能性のある模擬環境 — は**計画中**です（オプトイン必須、先に安全性を評価）。未実装です。[deception.md](../deception.md) を参照してください。
- **攻撃者のトークンを消費する**ことは、まだ**実証されていません**。実験的な迷路のバイト比はシミュレーションで 1:1 であり、下限の 3:1 を下回ります。時間比の数字は 25 ms/request モデルであり、実際の LLM エージェントでの測定ではありません。その測定が終わるまで、トークン消費を期待して迷路を有効にしないでください。[exhaust.md](../exhaust.md) と [trap-mode.md](../trap-mode.md) を参照してください。
- カナリアは不活性のままです。本プロジェクトは実在の認証情報を使わず、リバースプロンプトインジェクションを行わず、外向きの探索もしません。反撃しません。

**対象と非対象。** agent-guard は、API に向かう敵対的または探索的な AI エージェントのトラフィックを検出・誘捕・観測します。反撃したり、誰かを攻撃したりはしません。非対象、オプトイン機能、実験上の制約は[対象外であること](#対象外であること)を参照してください。

これはオープンソースの研究プロジェクトであり、まだ npm には公開されていません。ソースからインストールするか、`npm pack` でローカル tarball を作成してください。作業中のパッケージ名は `@imwyvern/agent-guard` です。Apache-2.0、著作権 2026 Wesley Wang。

[セキュリティポリシー](../../SECURITY.md)、[コントリビューションガイド](../../CONTRIBUTING.md)、[位置づけ](../positioning.md)、[ロードマップ](../roadmap.md) を参照してください。

## ロードマップ: これから向かう先

特記なき項目は計画中であり、未実装です。

- **ホストレベルの honeyfile** — `agent-guard seed` がディスク上に不活性な偽の `.env`、クラウド認証情報、SSH 鍵、kubeconfig を置き、アクセス時にアラートします。
- **偽の成功環境** — オプトイン必須、先に安全性を評価。攻撃者の AI が偽データを本物として扱う可能性のある模擬サービス面です。[deception.md](../deception.md) を参照してください。
- **対応時間の窓** — 運用者向けのインシデントタイムライン、滞在時間（dwell-time）指標、および運用者自身の鍵ローテーション / 遮断スクリプトへのフック。プロセス内のインシデント相関と `dwell_ms` は既に提供済みです。運用者向けタイムラインとフックは未実装です。
- **隔離されたデコイホスト** — 本番アプリケーションプロセスから分離された専用のデコイ環境。
- **実エージェントによるトークンコスト評価** — 実験的な迷路を有効にする前に、実際の AI エージェントのトークンを本当に消費するかを測定します。現在のバイト比 1:1 は仮説にすぎません。
- **Edge アダプター（v0.4b）** — **実装済み（未リリース）**：Web 標準コア、Cloudflare Workers、Next.js middleware / Vercel Edge、Deno、Bun、Hono-web。

詳細な計画は [docs/roadmap.md](../roadmap.md) にあります。範囲と誠実な主張は [docs/positioning.md](../positioning.md) にあります。

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

v0.2 の Hono アダプターは `@imwyvern/agent-guard/hono` として利用でき、オプションの `hono` peer を伴います。Node ≥20 が必要で、Node コアは `node:crypto` と Node DNS を使います。Workers/Bun/Deno では `@imwyvern/agent-guard/hono-web` と `@imwyvern/agent-guard/web` の `createWebGuard` を使ってください（v0.4b、未リリース）。

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

既定の `mode: 'detect'` では、検出は引き続きアラートのみです。カナリアリプレイはホストへ進み、デコイには noindex/no-store ヘッダーが付き、検証済みクローラーはホスト固有の欠落ルートハンドラーに到達します。オプトインの robots/HTML/llms 変換は、既存の 1 MiB バッファ上限を維持します。`npm run demo:hono` を実行してください（`PORT` と `AGENT_GUARD=off` は他のカタログデモと同じように動作します）。Hono は Express および Node と同じ共有受け入れスイートを実行します。

## Fastify と Koa（Node ランタイム）

v0.3a（未リリース）では `@imwyvern/agent-guard/fastify` と `@imwyvern/agent-guard/koa` の `agentGuard` を追加し、同じ guard または config を受け取ります。Fastify はルートより前に `await app.register(agentGuard(guard))` で登録します。ボディ解析後の `preHandler` で検査します。Koa はサイズ制限付きボディパーサーの後に `app.use(agentGuard(guard))` を配置します。どちらもリクエストストリームを消費せず、ホスト固有のクローラー向け 404、detect モードでのアラートのみのリプレイ検出、オプトインの lure 変換を保ちます。フレームワークはオプションの peer で、コアのランタイム依存関係は増えません。[Fastify デモ](../../examples/fastify-demo/server.ts)、[Koa デモ](../../examples/koa-demo/server.ts)、[アダプターガイド](../community.md)を参照してください。

## Edge / Web runtimes

v0.4b はこの**未リリースのツリー**に実装済みで、実行時依存はゼロです。git/ソースまたはローカルの `npm pack` tarball からインストールしてください。npm には未公開です。Web エントリーは WebCrypto とホストの構造的型を使い、アダプターは `next` や `hono` をインポートしません。

`createWebGuard(config)` は Web guard を返します。`await guard.handle(request, ctx?)` は介入時に `Response`、ホストへ通過させる場合に `null` を返します。

| ランタイム | `@imwyvern/agent-guard` に続くインポート接尾辞 | クライアント IP |
| --- | --- | --- |
| Web 標準ホスト | `/web`（`createWebGuard`） | ホストの `ctx.clientIp` または明示的な `ipHeader`。なければ `unknown` |
| Cloudflare Workers | `/workers`（`fromEnv`、`withAgentGuard`） | `fromEnv` の既定値は `CF-Connecting-IP` |
| Next.js middleware / Vercel Edge | `/next`（`agentGuardMiddleware`） | 運用者による `ipHeader` 設定が必須 |
| Deno | `/deno`（`denoHandler`） | `remoteAddr.hostname` |
| Bun | `/bun`（`bunHandler`） | `server.requestIP(request)` |
| エッジ上の Hono | `/hono-web`（`honoWeb`）+ `/web` | Web guard で `ipHeader` を明示 |
| Node ≥20 上の Hono | `/hono`（`agentGuard`）+ ルートの Node コア | ソケット IP。信頼できる `clientIp` による上書き |

次の表は `/web` と上記の五つの Web アダプターに適用され、Bun/Deno 上の Hono も含みます。`/hono` は Node コア（`node:crypto` / Node DNS）を維持します。

| 機能 | Web コア / Workers / Next / Deno / Bun / Hono-web | Node 上の Hono（`/hono`） |
| --- | --- | --- |
| ステートレス機能 | デコイルート、カナリア生成/再利用検出、HMAC ステートレス迷路**ノード**、fetch アラート、Prometheus（単一 isolate の視点） | 利用可能。メトリクスはプロセス単位 |
| インシデント相関、rateLimit、block、タイミングスコア、迷路セッションの受け入れ | `StateStore` が必要。未指定なら自動無効化し、guard ごとに一度コンソール警告。`memoryStore()` は isolate ごとで、グローバルではない | 上限付きのプロセス内状態 |
| クローラーポリシー | 既定の `ua-bypass`：Googlebot/Bingbot など認識対象の検索クローラーを名乗るクライアントは trap/maze/block に入らず、`crawler.verified: false`。`custom` 検証器も利用可能。DNS / DoH なし | Node DNS 検証、または設定したポリシー |
| `trap.delay` | 既定で無効。エッジでは経過時間に課金されるため非推奨。明示的に有効化しても上限 3000 ms | 既定で無効、オプトイン |
| 転送ヘッダー | 未設定のヘッダーは信頼しない。明示した `x-forwarded-for` は右端の空でないホップを使うため、信頼できるプロキシが必要 | 明示的に信頼した `clientIp` コールバック |
| SMTP | 利用不可。fetch による webhook / Slack / Telegram / Feishu を使用 | SMTP は Node のみ |

trap は全ランタイムで既定無効です。署名済み迷路ノードだけでは store なしのセッション受け入れはできません。迷路は引き続き実験段階（シミュレーションのバイト比 1:1）です。永続 store は運用者が提供します。StateStore の例、完全な縮退表、トラブルシューティングは [Edge 運用ガイド](../edge.md) を参照してください。この README の後続の設定・アラート例は Node API 用です。

**Workers** — 環境バインディングで `AG_CANARY_SECRET` と `AG_PROJECT_SEED` を渡します。`fromEnv(env)` は欠落/空の値を拒否し、既定の秘密鍵はありません。この最小例に StateStore はありません。

```ts
import { fromEnv, withAgentGuard } from '@imwyvern/agent-guard/workers';
import type { WebContext, WebGuard } from '@imwyvern/agent-guard/web';

let guard: WebGuard | undefined;
export default {
  fetch(request: Request, env: Record<string, unknown>, ctx: WebContext) {
    // Bind AG_CANARY_SECRET and AG_PROJECT_SEED in the host environment.
    guard ??= fromEnv(env);
    return withAgentGuard(guard, {
      fetch: () => new Response('Hello'),
    }).fetch(request, env, ctx);
  },
};
```

**Next.js / Vercel Edge** — `middleware.ts`。信頼できる入口プロキシが上書きするヘッダーを設定します。アダプターは介入時に `Response`、通過時に `undefined` を返し、`next` をインポートしません。

```ts
import { createWebGuard } from '@imwyvern/agent-guard/web';
import { agentGuardMiddleware } from '@imwyvern/agent-guard/next';

const secret = process.env.AG_CANARY_SECRET;
const projectSeed = process.env.AG_PROJECT_SEED;
if (!secret || !projectSeed) throw new Error('Set AG_CANARY_SECRET and AG_PROJECT_SEED');
const guard = createWebGuard({
  project: 'catalog', env: 'production', mode: 'detect', projectSeed,
  ipHeader: 'x-real-ip', // Only trust a header overwritten by your ingress.
  canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
});
export const middleware = agentGuardMiddleware(guard);
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|assets/).*)'],
};
```

**Deno** — ローカルの利用側に tarball をインストールし、Deno 2 の `nodeModulesDir: "manual"` を使います。この二つの環境変数の読み取りと、サーバーのネットワークアクセスを許可してください。

```ts
import { createWebGuard } from '@imwyvern/agent-guard/web';
import { denoHandler } from '@imwyvern/agent-guard/deno';

const secret = Deno.env.get('AG_CANARY_SECRET');
const projectSeed = Deno.env.get('AG_PROJECT_SEED');
if (!secret || !projectSeed) throw new Error('Set AG_CANARY_SECRET and AG_PROJECT_SEED');
const guard = createWebGuard({
  project: 'catalog', env: 'production', mode: 'detect', projectSeed,
  canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
});
Deno.serve(denoHandler(guard, () => new Response('Hello')));
```

**Bun** — アダプターはサーバーから接続 IP を取得します。

```ts
import { createWebGuard } from '@imwyvern/agent-guard/web';
import { bunHandler } from '@imwyvern/agent-guard/bun';

const secret = Bun.env.AG_CANARY_SECRET;
const projectSeed = Bun.env.AG_PROJECT_SEED;
if (!secret || !projectSeed) throw new Error('Set AG_CANARY_SECRET and AG_PROJECT_SEED');
const guard = createWebGuard({
  project: 'catalog', env: 'production', mode: 'detect', projectSeed,
  canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
});
Bun.serve({ fetch: bunHandler(guard, () => new Response('Hello')) });
```

**エッジ上の Hono** — この Workers 例は同じ必須バインディングを使います。Bun/Deno では `createWebGuard` で Web guard を作り、そのホスト用の信頼できる `ipHeader` を設定します。Hono は利用側アプリにインストールしてください。

```ts
import { Hono } from 'hono';
import { fromEnv } from '@imwyvern/agent-guard/workers';
import { honoWeb } from '@imwyvern/agent-guard/hono-web';
import type { WebGuard } from '@imwyvern/agent-guard/web';

let guard: WebGuard | undefined;
const app = new Hono<{ Bindings: Record<string, unknown> }>();
app.use('*', (c, next) => honoWeb(guard ??= fromEnv(c.env))(c, next));
app.get('/', c => c.text('Hello'));
export default app;
```

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
| `alerts.adapters` | 既定の送信先なし。webhook、console、Slack、Telegram、Feishu、SMTP/email アダプターを利用可能 |
| `alerts.minSeverity` | デコイ/リプレイは `info`；明示値は probe/discovery のエスカレーションも有効化 |
| `alerts.dedupeWindowSec` | 600；同一イベント + placement/ID + client key |
| `alerts.ratePerMinute` | チャネルあたり 30；抑制件数は次のアラート要約に繰り越し |
| `alerts.redactIp` | `true`；アラート内では粗い IPv4/IPv6 ネットワーク |
| `log.sink` / `level` / `keepIp` | stdout JSONL / `info` / `true` |
| `clientIp` | ソケット IP；信頼できるプロキシを検証したあとでのみ上書き |
| `onEvent` | 任意のオブザーバー；オブザーバー/sink の失敗は隔離される |

`guard.robotsLines()` は手動の robots 統合を支援します。`guard.htmlCommentFor(path)` はオプトインコメントまたは null を返します。`guard.metrics()` はリクエスト/イベント/配送の件数と、有界な直近 inspect タイミング分位数を返します。タイミングスコアはインスタンスごとの有界な観測値です。検出スコアはオプトインの trap ゲートに使われる場合があります。クライアント状態：50k エントリ、30 分のアイドル TTL。クローラーキャッシュ：10k、陽性 24h / 陰性 1h。転送ヘッダーは自動的には信頼されません。

detect モードでは、D5 は常にログインを拒否し、決定的な 300–600ms の遅延を伴います。すべてのデコイは `noindex`、`no-store`、≤8KiB で、既定では `.invalid` の架空ホスト名を使い（明示設定したセルフホストの callback URL は例外）、cookie の作成、認証、業務サービス呼び出しは行いません。申告済み AI クローラーのデコイヒットは重大度 `info` です。detect ではデコイルート上で検索クローラーの DNS 検証を行います。オプトインの trap と callback ハンドラーも検証を行い、クローラーを保護します。エラー/タイムアウトは fail open し、ネイティブ 404 になります。

## インシデント相関とカナリア伝播追跡

v0.3a は同じ `client_key` の既存イベントに任意の `incident` を付加します。フィールドは `id`、順序付き `sequence`（例：`robots → D1 → D2`）、`first_seen`、`last_seen`、`confidence` です。`incident.windowMs` の既定値は 900000（最初の観測から固定 15 分）、0 は相関を無効化します。状態は 50k クライアントの LRU に収め、直近 32 観測を保持します。単独ヒットの反復は low、異なるデコイまたは発見とデコイの組み合わせは medium、`canary_replay` は high に上げます。同じ窓内で確信度は下がりません。robots の訪問は内部マーカーで、イベント型を追加しません。共有ネットワークではクライアントが統合され得ます。相関は重大度を引き上げません。既定の detect では HTTP 応答とデコイ判断を維持しますが、v0.4a のオプトイン trap は high confidence をゲートに使えます。検証済みクローラーと allowlist は常に対象外です。[trap モード](../trap-mode.md) を参照してください。

リプレイアラートは `canary.id`、`placement`、`env`、`found_in`、`field` を保ち、`leaked_at`（配置）、`replayed_at`（パス）、`dwell_ms`（最初のデコイ配信からの時間）、`client_keys_seen`（異なるリプレイクライアントキー数、最大 8）を追加します。返すデコイボディにトークンが含まれる場合だけ配信を記録し、HEAD とクローラーバイパスは数えません。追跡はプロセス内のみで、50k 件の LRU と 24 時間 TTL を使います。追い出し、再起動、組み込みデコイ以外での配信では時刻が不明となり、`dwell_ms` を省略します。これらの観測は身元や悪意の証明にはなりません。

## アラートと署名

webhook と console に加え、`slackAdapter`、`telegramAdapter`、`feishuAdapter`、`smtpAdapter` を提供しています。送信先と認証情報は明示的に設定し、デフォルトではどれも有効になりません。新たなランタイム依存関係はありません。新しい HTTP アダプターは loopback 以外で HTTPS を要求し、リダイレクトを拒否します。SMTP は暗黙の TLS（465）、STARTTLS（587）、AUTH PLAIN/LOGIN に対応します。以下のキュー、重複排除、レート制限、`close()` による配送完了待ちを共有します。

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

v0.3b 以降、`npm run bench:exhaust-sim` はスクリプト化された貪欲 agent に対する有界迷路のコスト比シミュレーションをメモリ上で実行し、`npm run bench:deception-lint` は現行のデコイ出力と決定論的なペルソナ原型を安全スキャンします。いずれのコマンドも trap を有効にしません。v0.4a では別途、オプトインの trap と実験的な迷路が実装されています。[v0.3b のオフライン評価](../bench-v0.3b.md) を参照してください。

## 対象外であること

WAF、DDoS 防御、認証システム、汎用ボットブロッカーではありません。パッチ適用、最小権限、秘密情報の衛生管理の代替でもありません。この研究プロジェクトは本番デプロイを提供せず、検索エンジンの動作も保証しません。

ホストレベルの honeyfile と「偽の成功」による欺瞞は計画中であり、未実装です。攻撃者のトークン消費は実証されていません。[位置づけ](../positioning.md)と上記の[ロードマップ一覧](#ロードマップ-これから向かう先)を参照してください。

リバースプロンプトインジェクション / counter-injection（E4）は製品に一切含めません。外向きの探索や、guard が第三者に向けて開始するコールバックは行いません。外向きの通知は運用者が設定したアラートアダプターだけで、既存のクローラー識別用 DNS 検証は変わりません。カナリアは不活性な HMAC トークンであり、実在するベンダーの認証情報は使いません。第三者の honeytoken サービス（Canarytokens など）は利用せず、コールバックカナリアは運用者自身のホストでのみ受信します。

Edge / Web ランタイムは**この未リリースの v0.4b ツリーで対応済み**です。永続状態には運用者が提供する store が必要です。`StateStore` がなければインシデント相関、rateLimit、block、タイミングスコア、迷路セッションの受け入れは無効となり、一度警告します。`memoryStore()` は isolate 単位です。既定のクローラーポリシーは未検証の `ua-bypass`（DNS / DoH なし）で、SMTP は Node 専用です。`trap.delay` は既定無効でエッジでは非推奨、明示的に有効化しても上限 3000 ms です。[Edge 運用ガイド](../edge.md) を参照してください。

v0.4a には以下の**明示的なオプトインが必要で、デフォルトでは無効**の連携と制御が実装されています。既定のモードは `mode: 'detect'` のままです。

- Slack、Telegram、Feishu、SMTP/email のアラートアダプター。新たなランタイム依存関係はなく、既定の送信先もありません。
- `guard.prometheusText()` / `prometheusHandler(guard)` によるテキスト出力。エンドポイントは自動登録されず、パスの label は含みません。
- `mode: 'trap'`。`delay`、`rateLimit`、`block`、**実験的**な `maze` は個別に切り替えます。検証済みクローラーと allowlist は trap の対象になりません。
- `canary.callback.baseUrl` + `callbackHandler(guard)` によるセルフホスト型コールバックカナリア。ハンドラーは明示的に登録する必要があり、guard が `baseUrl` を fetch することはありません。

機械的なリクエスト間隔の `automation_score` も実装済みですが、観測専用です。重大度を引き上げたり、単独で block/maze を発動させたりしません。現行コードは十分なサンプルが集まると自動でスコアを算出し、独立した有効化スイッチはありません。

**実験的な迷路**を有効にする前に、運用者自身による実際の agent での測定が必要です。[v0.3b オフラインシミュレーション](../bench-v0.3b.md) では、スクリプト化された agent が **25 ms/request** のモデルで数百対一の時間比を示しましたが、**バイト比は 1:1 で、下限の 3:1 を下回りました**。実際の agent に対する費用削減を示す結果ではありません。[trap の設定とリスク](../trap-mode.md)、[Exhaust](../exhaust.md) を参照してください。

## ロードマップと設計ドキュメント

- [位置づけ](../positioning.md) — 趣旨、範囲の境界、誠実な主張の表（主張 / 状態 / 根拠）。
- [コミュニティ](../community.md) — アダプター、検出シグネチャ、翻訳、RFC の貢献方法。
- [ロードマップ](../roadmap.md) — 進む方向、v0.4a/v0.4b の完了項目（未リリース）、v0.5+ の計画。persona/deception の拡張は設計段階です。
- [Edge 運用ガイド](../edge.md) — ランタイムの接続、StateStore の例、縮退とトラブルシューティング。
- [Exhaust](../exhaust.md) — 実装済みのオプトイン遅延と実験的な迷路。コンテキスト消費（E3）は未実装です。トークン消費は実証されていません。
- [Deception](../deception.md) — デコイデータをより信じられるものにし、攻撃者の agent がそれを本物として扱う可能性を高める。「偽の成功」は計画中であり、未実装です。
- [設計](../design.md)、[契約](../codex-contract.md)、[KPI](../kpi.md)、[脅威モデル](../threat-model.md)。先行事例は概念の参考にすぎず、第三者プロジェクトのコードは複製していません。
