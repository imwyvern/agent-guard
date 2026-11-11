# API-only backends (v0.3a / unreleased)

An API can expose isolated JSON/text decoys without HTML comments. Reuse the [Express demo](../../examples/express-demo/server.ts) and its [configuration](../../examples/shared/site.ts); no additional dependency is needed. Keep `mode: 'detect'`, install bounded JSON/form parsers before the guard, and reserve decoy paths that do not overlap real routes. Canary replay emits an alert and continues to the host's existing handler.

## Placement choices

| Surface | Placement | Observation and boundary |
| --- | --- | --- |
| OpenAPI | An inert token in a decoy security scheme's `example`, or an example response property | Reading a schema is discovery; presenting its token in a later request is replay. SDK generators and API explorers may submit examples automatically. |
| Error response | A relative `docs_url` on an isolated decoy error, with the token in a query parameter | Following the URL presents the token. Link checkers, previews, and support tools can also follow it; this alone does not establish malicious intent. |
| `/.well-known/` file | A fake environment or API-reference file on a reserved decoy route | A GET can deliver canaries; HEAD and verified-crawler bypass do not. Ordinary discovery clients may still request unfamiliar files. |

Use a separate registry entry for each surface and field, for example `API:/openapi-decoy.json#components.schemas.InternalToken.example`, `API:/internal-error#docs_url`, and `D1:/.well-known/internal-example.env#ADMIN_API_TOKEN`. Generate inert tokens with the existing CLI, using an operator-supplied `AG_CANARY_SECRET`; never place real credentials or vendor key prefixes in examples. Registry files contain tokens and placement metadata, never the HMAC secret.

```sh
node dist/cli/main.js canary new --env demo --placement 'API:/openapi-decoy.json#components.schemas.InternalToken.example'
node dist/cli/main.js canary new --env demo --placement 'API:/internal-error#docs_url'
node dist/cli/main.js lint ./api-placements
```

For a custom OpenAPI/error response, load the generated registry in the host and insert the corresponding `entry.token` as data. A sketch of the payload shapes follows; `openApiToken` and `errorToken` stand for those registered inert tokens:

```ts
const decoySchema = {
  openapi: '3.1.0',
  info: { title: 'Internal example API', version: '1.0.0' },
  paths: {},
  components: {
    schemas: {
      InternalToken: { type: 'string', example: openApiToken },
    },
  },
};
const decoyError = {
  error: 'permission denied',
  docs_url: '/.well-known/internal-example.env?ref=' + encodeURIComponent(errorToken),
};
```

Keep these payloads on decoy routes with `X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store`. Use relative URLs or reserved `.invalid`/`.example` hosts. Do not add canary-bearing `docs_url` links to ordinary business errors or documented production examples. The built-in D4 OpenAPI response already includes an inert bearer `x-example`; it does not rewrite the host's real schema. Custom schema/error payloads remain host-owned: keep verified crawlers out of them by using the existing inspection/bypass contract, and never call a business resolver or identity provider to validate a canary.

## Variant of the Express demo

In the demo's guard configuration, override D1 to serve its existing fake environment body from a `/.well-known/` decoy. Leave D4 at its isolated default path and opt into body scanning only on API routes that need it:

```ts
decoys: {
  paths: {
    D1: '/.well-known/internal-example.env',
    D4: '/api/internal/openapi.json',
  },
},
canaryScan: {
  bodyPaths: ['/login', '/api/auth/*', '/v1/*'],
  maxBodyBytes: 16384,
},
```

These are properties to merge into the existing configuration object. Mount the guard before application routes and the native 404, after parsers. Use `guard.robotsLines()` for manual robots integration, or the existing opt-in append integration; overrides automatically update the disallowed paths. Never replace a real standard `/.well-known/` endpoint, include decoys in a sitemap, or put tokens in real authentication storage. Decoys retain their existing noindex/no-store headers, response size caps, and crawler bypass.

Run `npm run demo:express` after that local configuration change. Check a normal JSON request without a canary: its response and authentication behavior should be identical, with no replay event. GET the fake file, extract its inert token locally, then present it in a request header or an eligible parsed JSON body: a `canary_replay` should appear while the original host response remains unchanged. A verified crawler requesting the decoy should receive the host's native missing-route response. The shared [acceptance suite](../../test/acceptance/demos.test.ts) and [propagation tests](../../test/unit/canary-tracing.test.ts) cover these core boundaries.

## Interpreting observations

`canary.leaked_at` repeats the registry placement and `replayed_at` records the replay pathname. `client_keys_seen` counts distinct replaying client keys up to 8. The built-in decoys record first delivery in a bounded, process-local 50k-entry LRU with a 24-hour TTL. `dwell_ms` is omitted after restart/eviction and for custom host-rendered schema/error payloads whose delivery the guard did not observe; registry creation time is never substituted for delivery time. A schema placement identifies a source surface, not proof of which reader copied it.

Optional `incident` metadata correlates the same `client_key` within a fixed 15-minute window by default. NAT, shared proxies, and similar user agents may merge multiple actors; a client key is not a login session or a user identity. Higher confidence is an observation only and never blocks or changes responses.

Schema downloads, ordinary error handling, and JSON clients without canaries must not be treated as replay. Automated example execution, authorized scanners, integration tests, documentation previews, and copied support samples can legitimately present an inert token. Keep examples separate from production client setup, label local test traffic, and use narrow allowlists where appropriate. Neither replay nor a correlated sequence alone establishes that a client is an AI agent or hostile.
