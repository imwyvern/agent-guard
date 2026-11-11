# Log-only response hook examples

These are examples only for the Node response hooks in the unreleased v0.5a tree. They perform no key rotation, firewall changes, network calls or destructive actions. Read [incident response](../../incident-response.md) for trigger semantics, limits and environment handling.

- [append-log.mjs](append-log.mjs) appends one JSONL record to a fixed local file, using only time and bounded, control-character-stripped metadata. It creates/opens a regular leaf file without following a leaf symlink, refuses multiple hardlinks and enforces mode 0600. It does not create directories or rotate/truncate logs. The operator must create and control `/var/log/agent-guard` and all its ancestors (no symlinks), grant the guard user write access, and manage retention. Edit the fixed `logPath` if needed; never derive it from event metadata.
- [print-only.mjs](print-only.mjs) prints a fixed line to stdout. Run it directly to see that line. The hook runner discards child stdout/stderr, so it will only produce a `hook_result` event when used as a hook.

Point `hooks.run` at the absolute Node executable and absolute script path on your host. The examples are not bundled in the npm tarball; use a source checkout or copy a reviewed script into an operator-owned directory. No executable bit or shell wrapper is needed with this interpreter argv:

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

Replace both paths with actual absolute paths. Swap the script path for `print-only.mjs` to use the print example. Configure your normal event sink/file to see `hook_result`; child output is not captured. Hooks default off and are not available in Web / Edge. The runner uses `shell: false`, passes no inherited environment, and supplies only the five documented `AG_*` metadata keys when available. Neither example evaluates metadata, interpolates a shell command or reads other environment variables. Keep interpreter/script ownership trusted: hooks run with the guard's OS privileges and are not sandboxed.
