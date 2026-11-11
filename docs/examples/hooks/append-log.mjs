// Log-only example. The operator creates and controls this parent directory.
import { closeSync, constants, fchmodSync, fstatSync, openSync, writeSync } from 'node:fs';

const logPath = '/var/log/agent-guard/hook-example.jsonl';
const record = { ts: new Date().toISOString() };
for (const key of ['AG_INCIDENT_ID', 'AG_EVENT_TYPE', 'AG_CLIENT_KEY_HASH', 'AG_CANARY_ID', 'AG_PLACEMENT']) {
  const value = process.env[key];
  if (value !== undefined) record[key] = value.slice(0, 512).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}
const fd = openSync(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
try {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Expected a regular log file with one link');
  fchmodSync(fd, 0o600);
  writeSync(fd, JSON.stringify(record) + '\n');
} finally {
  closeSync(fd);
}
