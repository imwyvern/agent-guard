# Host honeyfiles: seed and watch

`seed` and optional `watch` ship in this unreleased v0.5a source tree (2026-11-11 HKT), with no npm publication or version tag. This adds host honeyfiles alongside HTTP/API detection. Read detection depends on operator-supplied Linux logs; it is not complete host monitoring. Nothing here replaces patching, a WAF or least privilege.

## Profiles and inventory

All paths are relative to `--dir`; these are synthetic files, not real service configuration.

| Profile | Files |
| --- | --- |
| `generic` | `.env.backup`, `db-connection.txt` |
| `node` | `.env.backup`, `.npmrc`, `.aws/credentials`, `.ssh/id_rsa` |
| `python` | `.env.backup`, `.pypirc`, `db-connection.txt` |
| `k8s` | `.kube/config`, `.ssh/id_rsa`, `.env.backup` |

Each file contains one inert project canary. Registry placement is `honeyfile:<profile>:<relative-path>`. Contents are deterministic for the same project seed, HMAC secret, environment, profile, callback URL and matching registry. New canary IDs are derived with HMAC; matching registry entries are reused. Registry `createdAt` is bookkeeping, not a file-read or issuance timestamp.

No real vendor credential formats, prefixes or check digits are used. Fake passwords use synthetic values; the SSH placeholder is explicitly invalid and is not a parseable private key. Default hostnames are reserved `.invalid` names; the shared placement linter also allows `.example` and reserved documentation addresses. No imperative or hidden-character lure text is allowed. Never put these values in real identity providers, secret stores or live service configuration.

## Plan, write and verify

Build from source first. The installed command is `agent-guard`; these examples use its built entry point. Supply `AG_CANARY_SECRET` through your normal secret mechanism and prepare a nonempty UTF-8 project-seed file, kept outside the honeyfile directory. Do not print or commit the secret. Generation requires `--env`.

```sh
mkdir -m 700 ./honeyfiles
node dist/cli/main.js seed --profile node --dir ./honeyfiles --seed-file ./operator-seed.txt --env demo
node dist/cli/main.js seed --profile node --dir ./honeyfiles --seed-file ./operator-seed.txt --env demo --write
node dist/cli/main.js seed --profile node --dir ./honeyfiles --seed-file ./operator-seed.txt --env demo --verify
```

The first `seed` invocation is a dry-run: no writes, only relative paths, mode, line counts and shortened canary IDs. Dry-run and verification need an existing root; `--write` can create one. No command prints full canary contents.

`--write` creates honeyfiles at mode **0600** and newly needed directories at **0700**. Existing directory permissions are unchanged. Existing honeyfile destinations, including symlinks, are skipped unchanged; symlink/non-directory ancestors and unsafe metadata targets are refused. Paths with parent traversal are rejected, destinations must stay inside the selected root, and creation uses exclusive/no-follow opens. Repeat writes only fill missing honeyfiles; they do not repair modified existing files. Keep the directory under operator control; these checks are not a sandbox against someone who can concurrently replace its ancestors.

By default metadata goes to `agent-guard.canaries.json` and `agent-guard.seed.json` in the working directory. Override with `--registry <file>` and `--manifest <file>`. Metadata paths must be distinct from the seed file and must not conflict with honeyfile destinations. The default manifest must be outside `--dir`; keep all metadata outside it. Metadata is written at 0600 and may be atomically updated; the no-overwrite rule applies to honeyfiles. The registry contains inert tokens, not the HMAC secret.

`--verify` is read-only: it requires the original seed file/secret, matching registry and manifest, and the same callback URL if configured. `--env` may be omitted to use the manifest environment. Verification recomputes expected bytes, checks missing/modified files and mode 0600, and does not emit access alerts. Exit status is 0 for intact files, 1 for findings, 2 for usage/input/I/O errors. `--verify` and `--write` are mutually exclusive.

To recognize seeded tokens replayed against HTTP, configure the Node guard with that registry filename and the same secret, project seed and environment. This gives replay alerts the honeyfile placement. Creating files does not populate the process-local decoy-issuance clock, so seeded-file replay normally has no `canary.dwell_ms`.

## Operator-hosted callback pointing

`--callback-base <https-url>` replaces the synthetic service endpoint in each template. It must be an endpoint hosted by the operator: HTTPS, no credentials/query/fragment; explicit loopback HTTP is allowed for local work. The callback hostname is passed as an exact `allowedHosts` exception to the shared inert-content linter; other lint rules remain enforced. Reuse the same URL on later writes and verification.

This is placement data only. `seed` does not deploy a listener or contact the URL, and it does not wrap that URL in a signed callback token. A plain request to the seeded endpoint is not automatically a valid `canary_callback`. The existing `canary.callback.baseUrl` / explicitly mounted `callbackHandler(guard)` accepts its own signed callback URLs; ordinary seeded credential replay is detected through HTTP canary inspection. Configure any operator endpoint deliberately; do not point it at a third-party honeytoken service. An isolated decoy host remains planned, not shipped.

## Optional Linux access-log parser

`watch` only reads a regular operator-supplied log and emits matching `honeyfile_read` records. It does not configure auditd, launch inotifywait, watch file reads in-process, infer reads from atime, or probe outbound. Operators run/configure the source tools themselves. The parser process needs no root privileges; audit-rule configuration and access to audit logs may require them. Grant only the needed log-read access rather than running the guard as root.

The following are templates, not deployment automation. Replace `/srv/agent-guard/honeyfiles` and log paths with absolute paths on your Linux host. Use the exact seeded root and a matching manifest/environment. Set up rules after seeding, and account for your own verification, backup and security scanners reading these files.

### auditd template

For the `node` profile, an operator can add these file-read rules to an audit rules file (for example `/etc/audit/rules.d/agent-guard.rules`), then load them with their distribution's audit administration tooling:

```text
-w /srv/agent-guard/honeyfiles/.env.backup -p r -k agent_guard_honeyfile
-w /srv/agent-guard/honeyfiles/.npmrc -p r -k agent_guard_honeyfile
-w /srv/agent-guard/honeyfiles/.aws/credentials -p r -k agent_guard_honeyfile
-w /srv/agent-guard/honeyfiles/.ssh/id_rsa -p r -k agent_guard_honeyfile
```

Feed raw auditd `SYSCALL` / `PATH` records, not a formatted search report. Matching absolute `PATH` names produce events; a preceding matching `SYSCALL` can supply numeric uid and process name. The parser does not independently prove a successful read syscall: its meaning depends on the operator's read-only audit rules. Unrelated audit lines produce no events. Audit timestamp/serial pairs associate process metadata; relative-only paths are not matched.

```sh
node dist/cli/main.js watch --auditd /var/log/audit/audit.log --dir /srv/agent-guard/honeyfiles --manifest ./agent-guard.seed.json --registry ./agent-guard.canaries.json --project local-catalog --env demo
```

### inotifywait template

Run the access logger separately. The log must exist before starting `watch`; the shell redirection creates it. Restrict its permissions with the operator's umask:

```sh
umask 077
inotifywait -m -r -e access --format '%w%f %e' /srv/agent-guard/honeyfiles > ./access.log
```

In another terminal:

```sh
node dist/cli/main.js watch --inotify-log ./access.log --dir /srv/agent-guard/honeyfiles --manifest ./agent-guard.seed.json --project local-catalog --env demo
```

Both `absolute-path ACCESS` from this format and the default directory/event/basename format are parsed. Inotify records have no uid/process metadata or source timestamp; events use parser time. Inotify can coalesce/drop notifications and is not a durable security audit trail.

### Output, bounds and integration

Only one of `--auditd` / `--inotify-log` is accepted. Startup requires readable, regular, non-symlink log/metadata/honeyfiles and a matching manifest/environment. Optional `--registry` validates placement/ID correspondence; `watch` does not perform `seed --verify` content/permission verification.

Default behavior tails new lines from EOF. `--from-start` replays existing records. Polling defaults to 500 ms (`--interval-ms`, maximum 60000); each tick reads at most 1 MiB. Default line cap is 16 KiB (`--max-line-bytes`, maximum 1 MiB); oversized/malformed lines are discarded. Default emission cap is 60 matching events/minute (`--max-events-per-minute`, maximum 100000). Pending audit process metadata is bounded to 1024 entries. Rotation/truncation resets reading and pending audit metadata; unsafe/missing replacements are retried. Caps and source reliability can cause missed events.

The CLI emits sanitized JSONL to stdout. An operator can collect it into a local event log; protect and rotate that collected file themselves. Webhook alerts are optional and require both `AG_ALERT_WEBHOOK_URL` and `AG_ALERT_WEBHOOK_SECRET`; normal dispatcher deduplication/retries/rate limits apply. No delivery-status events are mixed into watch's hit stream. `honeyfile_read` is medium severity, has a honeyfile path/placement/source and available uid/process name, and never enters trap/block. It carries no HTTP incident ID; the [incident CLI](incident-response.md) displays collected reads as adjacent records without inventing cross-process identities. The standalone CLI has no hook-config flag; the internal Node watcher supports operator-supplied hooks for embedders.

See the [threat model](threat-model.md), [incident response](incident-response.md), and [log-only hook examples](examples/hooks/README.md).
