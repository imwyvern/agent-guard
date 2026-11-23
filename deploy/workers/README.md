# Workers local template

This repository does **not deploy or publish a Worker**. This template is provided
only in the git checkout and is excluded from the npm package. It wraps a small
example handler with `fromEnv` and `withAgentGuard` from
`@imwyvern/agent-guard/workers`. Ordinary requests reach the handler; decoy routes
are inspected and served by the guard. Replace the example handler with your own
application handler when integrating it.

## Build from source first

The package is **not published**. Before an npm release, build the example's
library dependency from source. From the repository root, run:

```sh
npm run build
cd deploy/workers
```

Within this checkout, the package's self-reference resolves the Workers entry to
`dist/workers.js`. If copying the template into a separate application, build and
pack the library from the checkout, then install that local tarball in the
consuming application. See the [edge guide](../../docs/edge.md#install-and-choose-an-entry).

## Local development only

The operator must install `wrangler` separately; it is not a dependency of this
repository. The instructions here use local `wrangler dev` only. Copy the local
configuration and empty secret binding examples:

```sh
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars` locally with your own nonempty `AG_CANARY_SECRET` and
`AG_PROJECT_SEED`; the empty example cannot start a guard. Keep these values out
of git. Both `.dev.vars` and Wrangler's local state directory are ignored.

```sh
wrangler dev --local --ip 127.0.0.1
```

The example responds at `/`; `/.env` serves a decoy with `X-Robots-Tag: noindex`
and `Cache-Control: no-store`. Decoys stay **noindex**, and generated canaries are
**inert**: they are not real credentials and authorize no external service.

## Secret bindings and operating boundaries

For an operator-managed Worker environment, inject secrets through Wrangler's
secret manager, outside this repository's local-only workflow:

```sh
wrangler secret put AG_CANARY_SECRET
wrangler secret put AG_PROJECT_SEED
```

These commands configure remote secrets; they are not needed for local
`.dev.vars` development. Never place secret values under `[vars]` in
`wrangler.toml`. The configuration has no account ID or active routes, and KV /
Durable Object bindings are comments only.

The guard is initialized lazily at module scope and reused within the isolate.
The template forces detect mode and adds no automatic blocking. Trap is an
explicit library option for a separate, reviewed integration; this template
keeps detect mode even if an environment mode binding is changed.

`fromEnv` supplies no StateStore or alert destinations. Decoys and inert canary
replay detection remain available; incident correlation, rate limiting,
blocking, timing scores, and maze session admission degrade to off, with one
warning at initialization. Events contribute to the guard's isolate metrics;
this minimal template configures no event sink or outbound alert delivery. See
the [degradation table](../../docs/edge.md#full-support-and-degradation-table)
before adding an operator-provided StateStore with `createWebGuard` in a separate
integration. Isolate reuse does not provide persistence or coordination across
isolates.

`fromEnv` trusts `CF-Connecting-IP` by default. This is a trust boundary: only use
it behind ingress that overwrites the header with the actual client address.
Direct local callers can spoof it; local development does not authenticate that
header. Changing `AG_IP_HEADER` requires the same trusted-ingress guarantee. See
the [IP header trust guide](../../docs/edge.md#ip-header-trust).
