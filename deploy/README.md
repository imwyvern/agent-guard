# Local deployment templates (unreleased)

These are source templates for an operator-built local image, not a published
official image. No image is published to Docker Hub, GHCR, or any registry. The
templates ship only with git; the npm package's `files` list is unchanged.
Node ≥20 and zero runtime dependencies remain the library contract. See the
[entry-point guide](../docs/distribution.md) for proxy behavior and limitations.

## Build and run locally

Run from the repository root. Source builds need no root privileges; Docker
access depends on your own environment. Both stages pin Node 20.19 slim. The
runtime stage contains only `dist` and `package.json` in `/app`, with no production
`npm ci`. Its entrypoint runs `node dist/cli/main.js proxy --listen 0.0.0.0:8080
--allow-public-bind`; supply `--upstream` in the container command, as Compose
does. There is no baked-in public upstream or secret.

```sh
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
node --input-type=module <<'NODE'
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const path = 'deploy/.env';
let text = readFileSync(path, 'utf8');
for (const name of ['AG_CANARY_SECRET', 'AG_PROJECT_SEED', 'AG_WEBHOOK_SECRET']) {
  text = text.replace(new RegExp(`^${name}=$`, 'm'), `${name}=${randomBytes(32).toString('hex')}`);
}
writeFileSync(path, text, { mode: 0o600 });
NODE
docker build -f deploy/Dockerfile -t agent-guard-local:dev .
docker compose -f deploy/compose.yaml up -d
curl -fsS http://127.0.0.1:8080/
curl -si http://127.0.0.1:8080/.env
docker compose -f deploy/compose.yaml logs guard
docker compose -f deploy/compose.yaml down --remove-orphans
```

Create `.env` once; preserve existing operator bindings instead of copying over
them. `.env.example` contains names with empty values only. Supply your own
`AG_CANARY_SECRET` and `AG_PROJECT_SEED` at runtime; optional webhook configuration
uses `AG_ALERT_WEBHOOK_URL` with `AG_ALERT_WEBHOOK_SECRET` (or
`AG_WEBHOOK_SECRET`). Blank webhook fields send nothing. No key values are
printed by the setup command. Git and both Docker ignore files exclude `.env`
files. The root `.dockerignore` mirrors [deploy/.dockerignore](.dockerignore)
because the build context is the repository root; keep them identical.

The root filesystem is read-only. **Do not use `--init-secrets` in this image or
Compose path**: it would need to write `.env`. Compose's `env_file: .env` loads
the operator's `deploy/.env` into the process without mounting a secret directory.
There are no default data volumes or writable business paths. UID/GID 65532
runs root-owned business files; all capabilities are dropped and
`no-new-privileges:true` is set. No `/tmp` writes are required, so no tmpfs is
mounted; if your own integration needs temporary files, add a bounded `/tmp`
tmpfs and keep the business filesystem read-only.

The example `upstream` is an optional Node HTTP server on the internal network,
with no host port. `/` returns `local upstream`; `/.env` returns an inert decoy,
with `X-Robots-Tag: noindex…` and a `decoy_hit` console alert. Remove/replace
`upstream`, its `depends_on`, and guard's fixed `--upstream` together when using
your own origin. No HTTP healthcheck or extra public/decoy route is added; use
the ordinary upstream `/` for an operator-provided probe if needed.

## Network and detection boundary

Inside the container, `--listen 0.0.0.0:8080 --allow-public-bind` permits access
from the container network namespace and emits the existing bind warning. It
**does not expose all host interfaces**: host exposure is determined by
`ports: ["127.0.0.1:8080:8080"]`. Removing `127.0.0.1:` exposes the service more
widely at the operator's own risk. Keep the upstream private. Both services use
an `internal: true` network; external origins/webhooks need an operator-chosen
network policy before they can be reached.

The proxy accepts only `mode: detect`, alert-only, with no automatic blocking.
`AGENT_GUARD=off` remains pure forwarding. Canaries never authenticate anything;
decoys keep noindex. Proxy crawler UA exemptions remain unverified (`ua-bypass`,
no DNS); the gateway must leave crawler exemption handling to guard. TLS,
upstream availability, ingress access controls, and client-IP trust are operator
responsibilities. Forwarded IP headers are untrusted unless explicitly allowed
with the existing `--trusted-proxy` option; see [distribution](../docs/distribution.md).

## TLS gateways

Use [nginx](nginx.conf.example), [Caddy](Caddyfile.example), or
[Traefik](traefik.yaml.example) on the Docker host: terminate TLS there, then
proxy to `127.0.0.1:8080`. Replace `example.com` and certificate paths with your
own domain and external TLS material. The nginx file is a complete nginx.conf;
Caddy manages TLS; Traefik is a complete dynamic file-provider fragment and
documents its required static `websecure` entrypoint. No dashboard or public
management API is required. Caddy's admin API stays on loopback.

For a gateway in another container, loopback means that gateway container;
connect it to the guard network and replace the backend with `http://guard:8080`.
Gateways must preserve decoy bodies, noindex and robots headers, and must not
rewrite guard errors or implement crawler exemptions themselves. Optionally
feed gateway access logs to the existing `node dist/cli/main.js watch --log`
mode; formats and header/body visibility limits are in
[distribution §5](../docs/distribution.md#5-http-access-log-watch只读与可见性).

## Local SBOM only

On the host, use the existing toolchain with npm 11's built-in `npm sbom`:

```sh
npm ci
npm run sbom
```

[scripts/sbom.mjs](../scripts/sbom.mjs) invokes
`npm sbom --omit=dev --sbom-format=cyclonedx`, validates the JSON and writes
`bench/results/sbom.json`, already gitignored. It inventories the npm runtime
dependency graph (currently empty), not OS packages in the base image. No new
dependencies are installed by the script; Docker builds do not require it.
Missing npm/SBOM support or invalid output exits nonzero with an explicit error.
The document stays local: do not commit it, attach it to a release, or upload it
to a registry.

Before npm publication, CLI examples use `node dist/cli/main.js <cmd>` (or
`npx tsx src/cli/main.ts`). `npx @imwyvern/agent-guard` becomes usable only after
npm publication, which still needs Dan's separate approval under the
[release checklist](../docs/release-checklist.md). Workers templates / Helm and
real AI-agent evaluation remain planned; these templates do not implement them.

## Acceptance

[DI-8a–e tests](../test/unit/deploy.test.ts) inspect the templates and generate a
local SBOM, including explicit errors for missing tools.
[DI-8f](../test/integration/docker.test.ts) builds and starts the default Compose
configuration, curls an ordinary page and the noindex decoy, checks its alert,
and tears everything down. It explicitly skips if Docker or its daemon is
unavailable; it never treats that skip as a successful container test.
