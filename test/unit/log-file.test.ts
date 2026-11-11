import { mkdtempSync, readFileSync, statSync, writeFileSync, symlinkSync, mkdirSync, rmSync, readdirSync, renameSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentGuard } from '../../src/index.js';
import { appendJsonl, JsonlReader, maxJsonlLineBytes } from '../../src/log/file.js';
import { logEvent } from '../../src/log/sink.js';
import { config, event, request } from '../helpers.js';

const dirs: string[] = [];
const directory = (): string => { const dir = mkdtempSync(join(tmpdir(), 'ag-log-')); dirs.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('writes sanitized JSONL with 0600 permissions through the Node inspect path', async () => {
    const file = join(directory(), 'events.jsonl'), sink = vi.fn();
    const guard = createAgentGuard(config({ log: { file, keepIp: false, sink } }));
    try {
        await guard.inspect(request('/robots.txt'));
        await guard.inspect(request('/.env', { headers: { 'user-agent': 'curl/8.0\n\x01' } }));
        await guard.inspect(request('/.env', { headers: { 'user-agent': 'curl/8.0\n\x01' } }));
        const lines = readFileSync(file, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(lines.map(line => JSON.parse(line).event)).toEqual(['decoy_hit', 'decoy_hit']);
        expect(JSON.parse(lines[1]!).incident.dwell_ms).toBeGreaterThanOrEqual(0);
        expect(JSON.parse(lines[0]!).req.ua).toBe('curl/8.0');
        expect(JSON.parse(lines[0]!).req.ip).toBeUndefined();
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(sink).toHaveBeenCalledTimes(2);
        expect(readFileSync(file, 'utf8')).not.toContain('AG-CANARY-');
    } finally { await guard.close(); }
});

it('truncates before exceeding maxBytes and drops oversized lines without damaging history', () => {
    const file = join(directory(), 'events'), first = event(), bytes = Buffer.byteLength(JSON.stringify(first) + '\n');
    const c = config({ log: { file, maxBytes: bytes, sink: () => {} } });
    logEvent(first, c); logEvent(first, c);
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(first) + '\n');
    expect(statSync(file).size).toBeLessThanOrEqual(bytes);
    logEvent(event({ project: 'longer-than-the-bound' }), c);
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(first) + '\n');
});

it('keeps stdout as the default and creates no files when options are unset', async () => {
    const dir = directory(), stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const guard = createAgentGuard(config({ log: undefined }));
    try {
        const decision = await guard.inspect(request('/.env'));
        expect(decision.action).toBe('respond');
        expect(decision.events.map(e => e.event)).toEqual(['decoy_hit']);
        expect(stdout).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(stdout.mock.calls[0]![0])).event).toBe('decoy_hit');
        expect(readdirSync(dir)).toEqual([]);
    } finally { await guard.close(); }
});

it('isolates observer, sink, missing directory and disk target failures from inspect', async () => {
    const dir = directory();
    for (const file of [dir, join(dir, 'missing', 'events')]) {
        const guard = createAgentGuard(config({ log: { file, sink: () => { throw new Error('sink failed'); } }, onEvent: () => { throw new Error('observer failed'); } }));
        try { expect((await guard.inspect(request('/.env'))).action).toBe('respond'); }
        finally { await guard.close(); }
    }
    expect(readdirSync(dir)).toEqual([]);
});

it('refuses leaf and parent symlinks and does not modify their targets', () => {
    const dir = directory(), target = join(dir, 'target'), link = join(dir, 'link');
    writeFileSync(target, 'unchanged'); symlinkSync(target, link);
    expect(() => appendJsonl(link, event())).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('unchanged');
    const sub = join(dir, 'sub'), alias = join(dir, 'alias'); mkdirSync(sub); symlinkSync(sub, alias);
    expect(() => appendJsonl(join(alias, 'events'), event())).toThrow();
    expect(readdirSync(sub)).toEqual([]);
});

it('restores restrictive permissions on an existing regular file', () => {
    const file = join(directory(), 'events'); writeFileSync(file, '', { mode: 0o644 });
    appendJsonl(file, event());
    expect(statSync(file).mode & 0o777).toBe(0o600);
});

it('redacts canary replays and configured secrets in persisted request metadata', async () => {
    const file = join(directory(), 'events');
    const c = config({ log: { file } }), guard = createAgentGuard(c);
    try {
        const decoy = await guard.inspect(request('/.env'));
        if (decoy.action !== 'respond') throw new Error('expected decoy');
        const token = /^ADMIN_API_TOKEN=(.+)$/m.exec(decoy.response.body)![1]!;
        await guard.inspect(request('/use/' + token));
        logEvent(event({ req: { method: 'GET', path: '/' + c.canary.secret, client_key: 'client' } }), c);
        const text = readFileSync(file, 'utf8');
        expect(text.includes(token)).toBe(false);
        expect(text.includes(c.canary.secret)).toBe(false);
        expect(text).toContain('[redacted]');
    } finally { await guard.close(); }
});

it('reads fixed byte budgets and skips oversized/malformed lines across chunk boundaries', () => {
    const file = join(directory(), 'events');
    writeFileSync(file, 'x'.repeat(maxJsonlLineBytes + 10) + '\n{invalid}\n' + JSON.stringify({ text: 'é'.repeat(100) }) + '\n');
    const reader = new JsonlReader(file), values: unknown[] = [];
    expect(reader.poll(v => values.push(v), 100)).toBe(false);
    for (let i = 0; i < 100; i++) if (reader.poll(v => values.push(v), 1024)) break;
    expect(values).toEqual([{ text: 'é'.repeat(100) }]);
    appendFileSync(file, '{"partial":'); reader.poll(v => values.push(v));
    expect(values).toHaveLength(1);
    appendFileSync(file, 'true}\n'); reader.poll(v => values.push(v));
    expect(values.at(-1)).toEqual({ partial: true });
});

it('follows external rotation and detects in-place truncation even when the replacement grows', () => {
    const file = join(directory(), 'events'); appendJsonl(file, { first: true });
    const reader = new JsonlReader(file), values: unknown[] = [];
    reader.poll(v => values.push(v));
    renameSync(file, file + '.old'); appendJsonl(file, { second: true }); reader.poll(v => values.push(v));
    writeFileSync(file, JSON.stringify({ replacement: 'longer-than-previous-cursor' }) + '\n'); reader.poll(v => values.push(v));
    expect(values).toEqual([{ first: true }, { second: true }, { replacement: 'longer-than-previous-cursor' }]);
});

it.each([
    { log: { file: '' } }, { log: { file: '\0' } }, { log: { maxBytes: 0 } }, { log: { maxBytes: Infinity } },
    { escalation: { remindAfterMs: 0 } }, { escalation: { remindAfterMs: .5 } }, { escalation: { maxReminders: -1 } }, { escalation: { maxReminders: 101 } },
])('rejects invalid logging/escalation limits: %j', options => {
    expect(() => createAgentGuard(config(options))).toThrow();
});
