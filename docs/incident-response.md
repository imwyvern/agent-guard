# Incident response

The timeline, incident CLI, optional Node file log, Prometheus summaries, escalation/reminders and response hooks ship in this **unreleased v0.5a tree** (2026-11-11 HKT). There is no npm publication or version tag. Default detection stays alert-only; hooks and escalation are opt-in and default off. Response actions belong to the operator; the guard does not rotate keys or change firewalls.

## Timeline and the two dwell measurements

Optional `event.incident` metadata correlates observations by client key in a fixed window (`incident.windowMs`, default 900000 ms; 0 disables). State is process-local, capped at 50k clients with the latest 32 observations. Shared networks/UA can merge clients; an incident is not an authenticated identity. Optional fields preserve the existing event format:

| Field | Meaning |
| --- | --- |
| `incident.id` | ID within this process's correlation state |
| `incident.first_seen`, `last_seen` | First and latest correlated observation |
| `incident.first_touch_at` | First correlated touch, including a prior internal robots marker |
| `incident.alerted_at` | First successful alert delivery; absent until observed, not the enqueue time |
| `incident.dwell_ms` | First touch to this event, clamped at zero on clock rollback |
| `incident.sequence`, `confidence` | Recent ordered observations and low/medium/high correlation confidence |
| `canary.dwell_ms` | Known first built-in decoy-body delivery to replay; a separate issuance clock |

A single ordinary observation can omit public incident metadata; alert-delivery records can still carry its internally correlated ID. `canary.dwell_ms` is omitted after unknown issuance, restart/eviction or delivery outside built-in decoys, including planted honeyfiles. It is not inferred from registry timestamps. Canary tracing retains at most 50k records for 24 hours and up to 8 replaying client keys. Neither dwell measure establishes how long an attacker controlled a host or whether an operator has contained an incident.

Node `guard.prometheusText()` / `prometheusHandler(guard)` exposes `agent_guard_time_to_alert_seconds` (first touch to first successful incident alert) and `agent_guard_incident_dwell_seconds` (each emitted event carrying incident dwell). These are summaries, emitted only after samples: 0.5/0.99 quantiles over the latest 2048 samples, with lifetime sum/count. There are no path, UA or IP labels. Mount and protect metrics explicitly; values are per process. Web / Edge has its existing incident/store behavior but does not implement these Node delivery-timeline summaries, Node file logging, escalation or hooks; see [edge.md](edge.md).

## Optional Node JSONL file

Add these options to your Node guard configuration:

```ts
const incidentOptions = {
  log: { file: './events.jsonl', maxBytes: 10 * 1024 * 1024, keepIp: false },
  escalation: { enabled: true, remindAfterMs: 300000, maxReminders: 2 },
};
// Pass ...incidentOptions into createAgentGuard({...}). Omit to keep these options off.
```

Create the file's parent directory beforehand. `log.file` appends sanitized JSONL at **0600**, refuses symlink ancestors/targets, non-regular files and multiply linked files. It replaces default stdout logging and can accompany an explicit `log.sink`; the default severity threshold is `info`. `keepIp: false` omits the local IP field.

Default `maxBytes` is 10 MiB. Before an append that would exceed the bound, the file is truncated to zero; this is not archival rotation. Individual JSONL lines over 64 KiB or the configured file bound are dropped. External rotation is supported; retain archives yourself if needed. Writes are synchronous and bounded, with I/O errors isolated from request handling. Inspect logs/permissions operationally: a failed write does not mean the request fails.

Persisted strings redact recognized canary tokens and configured secret/seed/allowlist-token values, and events are control-character sanitized and bounded. Request bodies, Cookie/Authorization values and hook output are not logged. Paths and other permitted metadata may still be sensitive; choose retention and file access accordingly. File-specific redaction does not turn arbitrary custom sinks into secret scrubbers.

## Incident CLI

Use the built CLI, or `agent-guard` in a local consumer installation:

```sh
node dist/cli/main.js incident list --log ./events.jsonl
node dist/cli/main.js incident list --log ./events.jsonl --json
node dist/cli/main.js incident show INCIDENT_ID --log ./events.jsonl
node dist/cli/main.js incident show INCIDENT_ID --log ./events.jsonl --json
node dist/cli/main.js incident ack INCIDENT_ID --log ./events.jsonl
```

Replace `INCIDENT_ID` with an ID from `list`. `list` and `show` only read. `ack` appends an `incident_ack` record at 0600, with the ID and available timeline context; it can also record an ID absent from retained history. It does not execute a response action or disable hooks/trap. Ack appends do not apply `log.maxBytes` truncation, so CLI acknowledgments can take a file above the guard's bound until a later guard append.

The streaming reader retains at most 50k incident groups, their latest 32 accepted records and 32 records without incident IDs; truncated output says so. Malformed/oversized lines are ignored. It sorts retained per-incident entries by timestamp and projects limited fields. Delivery records, decoy hits, replay and recorded trap actions can appear; a decoy record with status 429 is shown as rate-limit. `hook_result` is recorded in JSONL but is not currently included in CLI timeline reconstruction. A log is a bounded view, not a full forensic archive.

Collected `honeyfile_read` records from [watch](seed.md) have no incident ID and appear as **log-adjacent** entries. The CLI does not merge incidents across processes using IP/client heuristics, and cannot prove that a nearby file read and HTTP replay came from the same actor.

## Opt-in escalation and reminders

Only the Node inspect path implements `escalation.enabled: true`. Existing severity admission, destination configuration and dispatcher limits still apply. It queues the first eligible incident alert, then can send an `incident_escalated` notification when correlation confidence first reaches `high` (rather than changing the request decision). Acknowledgments suppress subsequent escalation/reminders; they do not cancel work already queued.

Reminder timing starts at the **first successful delivery**, not first touch or failed delivery. Default `remindAfterMs` is 300000; each later reminder waits that interval, and default `maxReminders` is 2 (allowed 0–100). `incident_reminder` attempts are capped even when delivery fails. State is bounded to 50k incidents and expires at the fixed correlation-window end, so a short window can expire before a reminder is due. Closing the guard stops reminders.

**CLI acks are visible in-process only when `--log` is the same file as the guard's `log.file`.** The guard polls that file incrementally. With no `log.file`, or an ack written to another file, reminders remain capped but cannot see those CLI acks. While the ack reader is unreadable or catching up, reminders are deferred. Restart, eviction and log truncation/retention can lose context; this is not a durable incident-management service. The standalone watch CLI does not run this escalation coordinator or include alert-delivery status in its JSONL.

## Safe response hooks (Node only)

`hooks` is unset/empty by default. Configure fixed literal argv only; the executable `run[0]` must be an absolute slash-separated path. When using an interpreter, give the script an absolute path too. Use a trusted operator-owned script and directory. Never build args from requests or pass metadata through a shell, interpreter expression, or command evaluator.

```ts
const hookOptions = {
  hooks: [{
    on: 'canary_replay' as const,
    run: ['/usr/bin/node', '/absolute/path/to/agent-guard/docs/examples/hooks/append-log.mjs'] as [string, ...string[]],
    timeoutMs: 1000, maxPerHour: 10, maxConcurrent: 1,
  }],
};
// Pass ...hookOptions into createAgentGuard({...}).
```

Triggers are `canary_replay`, `honeyfile_read` (Node watcher integration) and `incident_high`. `incident_high` fires on the first observed event with high **correlation confidence** for an incident, tracked in a bounded 50k-ID LRU; it is not a severity threshold. The standalone watch CLI exposes no hook-config option. A CLI ack does not disable hook triggers.

The runner defers spawning beyond inspection, uses `child_process.spawn` with **`shell: false`**, and does not interpolate request content into argv. It supplies a fresh environment containing only the following keys when available:

| Environment key | Value |
| --- | --- |
| `AG_INCIDENT_ID` | Correlated incident ID |
| `AG_EVENT_TYPE` | Triggering event type |
| `AG_CLIENT_KEY_HASH` | Lowercase hex SHA-256 of the client key (rehashed even if already a digest) |
| `AG_CANARY_ID` | Canary ID, never a full token |
| `AG_PLACEMENT` | Canary/honeyfile placement |

There is no inherited PATH, HOME or secret environment, and no UA, raw request path, headers or body. Treat metadata as data; do not evaluate it. The process has the guard's OS privileges: this is not a sandbox. Choose a minimal script and account; descendants are not contained as a process group. Guard policy cannot make an unsafe operator script safe.

| Limit | Default | Allowed |
| --- | --- | --- |
| Hook entries | None | At most 32 |
| `timeoutMs` | 5000 ms | 1–60000 ms |
| `maxPerHour` | 10 | 1–100 per entry, fixed hour from first admitted attempt |
| `maxConcurrent` | 2 | 1–8 per entry; pending starts count |
| All runners in the module | 16 children | Fixed global cap, includes pending starts |

Timeout sends SIGTERM, then SIGKILL after a 1000 ms grace period. There is no unbounded work queue. Spawn errors, nonzero exits, timeouts, shutdown cancellations and cap refusals emit `hook_result`; they never escape into `inspect` or change its decision. Results include status/reason, without executable, args or captured output. Child stdout/stderr are ignored. Call `await guard.close()` on shutdown to stop hooks and flush alerts.

The [hook examples](examples/hooks/README.md) only print or append a local log line, with no network calls, key rotation, firewall changes or destructive actions. Operators may point hooks at their own scripts; any response policy is their responsibility. These Node features are absent from the Web / Edge core.
