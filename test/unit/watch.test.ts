import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCLI } from '../../src/cli/commands.js';
import { createWatchFromArgs, runWatch } from '../../src/cli/watch.js';
import type { AlertAdapter } from '../../src/types.js';
import { loadHoneyfiles } from '../../src/watch/files.js';
import { createLogFollower } from '../../src/watch/follower.js';
import { createWatcher, type WatchSession } from '../../src/watch/monitor.js';
import { createLogParser, type ParserOptions } from '../../src/watch/parser.js';

let base: string, root: string, manifest: string, registry: string, log: string, honeyfile: string;
let sessions: WatchSession[];

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ag-watch-'));
    root = join(base, 'seed files'); manifest = join(base, 'manifest.json'); registry = join(base, 'registry.json');
    log = join(base, 'access.log'); honeyfile = join(root, '.env.backup'); sessions = [];
    const seed = join(base, 'seed.txt');
    writeFileSync(seed, 'watch test project seed');
    writeFileSync(log, '');
    vi.stubEnv('AG_CANARY_SECRET', 'watch test secret');
    vi.stubEnv('AG_ALERT_WEBHOOK_URL', '');
    vi.stubEnv('AG_ALERT_WEBHOOK_SECRET', '');
    expect(runCLI(['seed', '--profile', 'generic', '--dir', root, '--manifest', manifest, '--registry', registry,
        '--seed-file', seed, '--env', 'test', '--write'], () => {})).toBe(0);
});

afterEach(async () => {
    await Promise.all(sessions.map(session => session.close()));
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
});

function args(extra: string[] = []): string[] {
    return ['--inotify-log', log, '--dir', root, '--manifest', manifest, '--project', 'watch-tests', '--env', 'test', ...extra];
}
function parser(source: 'auditd' | 'inotify' = 'auditd', extra: Partial<ParserOptions> = {}) {
    return createLogParser({ source, project: 'watch-tests', env: 'test', targets: loadHoneyfiles(root, manifest, 'test'), ...extra });
}
function watch(extra: string[] = [], adapters?: AlertAdapter[]) {
    const output: string[] = [];
    const session = createWatchFromArgs(args(extra), line => output.push(line), { adapters });
    sessions.push(session);
    return { session, output };
}
function syscall(serial = '73', timestamp = '1730000000.123456', fields = 'uid=1001 comm="reader" exe="/usr/bin/reader"') {
    return `type=SYSCALL msg=audit(${timestamp}:${serial}): arch=c000003e syscall=0 success=yes exit=8 ${fields}`;
}
function auditPath(path = honeyfile, serial = '73', timestamp = '1730000000.123456') {
    return `type=PATH msg=audit(${timestamp}:${serial}): item=0 name="${path}" inode=123 dev=08:01 nametype=NORMAL`;
}
function hit(suffix = '') { return `${honeyfile} ACCESS${suffix}\n`; }

it('binds an auditd SYSCALL and PATH into one medium read event with synthetic request metadata', () => {
    const reader = parser();
    expect(reader.parseLine(syscall())).toEqual([]);
    const events = reader.parseLine(auditPath());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
        v: 1, event: 'honeyfile_read', severity: 'medium', project: 'watch-tests', env: 'test', ts: '2024-10-27T03:33:20.123Z',
        req: { method: 'READ', path: '.env.backup', client_key: expect.stringMatching(/^[a-f0-9]{24}$/) },
        honeyfile: { path: '.env.backup', placement: 'honeyfile:generic:.env.backup', source: 'auditd', uid: '1001', comm: 'reader' },
    });
    expect(events[0]!.req).not.toHaveProperty('ua');
    expect(events[0]!.req).not.toHaveProperty('ip');
    expect(events[0]).not.toHaveProperty('incident');
    expect(events[0]).not.toHaveProperty('canary');
});

it('validates read events and strictly rejects invalid honeyfile objects in the v1 schema', async () => {
    const { $schema: _draft, ...schema } = JSON.parse(readFileSync(new URL('../../schema/event.v1.json', import.meta.url), 'utf8'));
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
    app.post('/', { schema: { body: schema } }, async () => ({ ok: true }));
    const event = parser().parseLine(auditPath())[0]!;
    const metadata = event.honeyfile!;
    const { path: _path, ...withoutPath } = metadata;
    const { placement: _placement, ...withoutPlacement } = metadata;
    const { source: _source, ...withoutSource } = metadata;
    try {
        expect((await app.inject({ method: 'POST', url: '/', payload: event })).statusCode).toBe(200);
        for (const honeyfile of [
            { ...metadata, unknown: true }, { ...metadata, source: 'fs.watch' }, withoutPath, withoutPlacement, withoutSource,
            { ...metadata, uid: 1001 }, { ...metadata, comm: {} }, { ...metadata, path: 1 },
        ]) expect((await app.inject({ method: 'POST', url: '/', payload: { ...event, honeyfile } })).statusCode).toBe(400);
    } finally { await app.close(); }
});

it('emits a standalone PATH immediately, without inventing process metadata', () => {
    const event = parser().parseLine(auditPath())[0]!;
    expect(event.honeyfile).toEqual({ path: '.env.backup', placement: 'honeyfile:generic:.env.backup', source: 'auditd' });
});

it('accepts unquoted paths and falls back to exe when comm is unavailable', () => {
    const path = join(root, 'db-connection.txt');
    const reader = parser();
    reader.parseLine(syscall('73', undefined, 'uid=0 exe="/usr/bin/cat"'));
    // The second manifest path has a space-free alias for this parser fixture.
    const targets = loadHoneyfiles(root, manifest, 'test');
    targets[1]!.absolutePaths.push('/srv/db-connection.txt');
    const unquoted = parser('auditd', { targets });
    unquoted.parseLine(syscall('73', undefined, 'uid=0 exe="/usr/bin/cat"'));
    const event = unquoted.parseLine('type=PATH msg=audit(1730000000.123456:73): name=/srv/db-connection.txt')[0]!;
    expect(event.honeyfile).toMatchObject({ path: 'db-connection.txt', uid: '0', comm: '/usr/bin/cat' });
    expect(reader.parseLine(auditPath(path))[0]!.honeyfile?.path).toBe('db-connection.txt');
});

it.each(['hex-escape', 'octal', 'kernel-hex'] as const)('matches audit paths encoded as %s', encoding => {
    const value = encoding === 'kernel-hex' ? Buffer.from(honeyfile).toString('hex') :
        '"' + honeyfile.replaceAll(' ', encoding === 'octal' ? '\\040' : '\\x20') + '"';
    expect(parser().parseLine(`type=PATH msg=audit(1730000000.123456:73): name=${value}`)).toHaveLength(1);
});

it.each(['hex-escape', 'octal'] as const)('decodes UTF-8 bytes in audit %s paths', encoding => {
    const path = '/srv/\u8bfb\u53d6/.env.backup';
    const targets = loadHoneyfiles(root, manifest, 'test'); targets[0]!.absolutePaths.push(path);
    const encoded = [...Buffer.from(path)].map(byte => encoding === 'octal' ? '\\' + byte.toString(8).padStart(3, '0') : '\\x' + byte.toString(16).padStart(2, '0')).join('');
    expect(parser('auditd', { targets }).parseLine(`type=PATH msg=audit(1730000000.1:73): name="${encoded}"`)).toHaveLength(1);
});

it('sanitizes and bounds process metadata before emitting events', () => {
    const reader = parser();
    reader.parseLine(syscall('73', undefined, `uid=1001 comm="reader\u2028${'x'.repeat(600)}"`));
    const comm = reader.parseLine(auditPath())[0]!.honeyfile!.comm!;
    expect(comm.length).toBeLessThanOrEqual(512);
    expect(comm).not.toContain('\u2028');
});

it('keys audit correlation by timestamp and serial, preserving interleaved processes', () => {
    const reader = parser();
    reader.parseLine(syscall('73', '1730000000.1', 'uid=1 comm="first"'));
    reader.parseLine(syscall('74', '1730000000.1', 'uid=2 comm="second"'));
    expect(reader.parseLine(auditPath(honeyfile, '74', '1730000000.1'))[0]!.honeyfile?.comm).toBe('second');
    expect(reader.parseLine(auditPath(honeyfile, '73', '1730000000.1'))[0]!.honeyfile?.comm).toBe('first');
    expect(reader.parseLine(auditPath(honeyfile, '73', '1730000001.1'))[0]!.honeyfile).not.toHaveProperty('comm');
});

it('evicts the oldest audit process entries and resets bounded correlation state', () => {
    const reader = parser('auditd', { maxPending: 2 });
    for (let i = 1; i <= 100; i++) reader.parseLine(syscall(String(i)));
    expect(reader.pendingCount).toBe(2);
    expect(reader.parseLine(auditPath(honeyfile, '1'))[0]!.honeyfile).not.toHaveProperty('uid');
    expect(reader.parseLine(auditPath(honeyfile, '100'))[0]!.honeyfile?.uid).toBe('1001');
    reader.reset();
    expect(reader.pendingCount).toBe(0);
});

it.each(['invalid', '9999999999999999999999999999999999999999999999999'])('uses now for an invalid audit timestamp %s', timestamp => {
    const now = Date.UTC(2026, 0, 2);
    expect(parser('auditd', { now: () => now }).parseLine(auditPath(honeyfile, '1', timestamp))[0]!.ts).toBe(new Date(now).toISOString());
});

it.each(['directory', 'file', 'combined', 'directory-with-space'] as const)('accepts inotifywait %s ACCESS output', shape => {
    const line = shape === 'directory' ? `${root}/ ACCESS .env.backup` : shape === 'combined' ? `${honeyfile} ACCESS,OPEN` :
        shape === 'directory-with-space' ? `${root}/ ACCESS,ISDIR .env.backup` : `${honeyfile} ACCESS`;
    const events = parser('inotify').parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('medium');
    expect(events[0]!.honeyfile).toEqual({ path: '.env.backup', placement: 'honeyfile:generic:.env.backup', source: 'inotify' });
});

it.each(['MODIFY', 'CREATE', 'DELETE', 'OPEN', 'OPEN_EXEC', 'ISDIR', 'ACCESSIBLE', 'CLOSE_WRITE,CLOSE'])('ignores non-ACCESS event %s', token => {
    expect(parser('inotify').parseLine(`${honeyfile} ${token}`)).toEqual([]);
});

it('matches the resolved absolute path and an explicitly indexed realpath alias', () => {
    const targets = loadHoneyfiles(root, manifest, 'test');
    targets[0]!.absolutePaths.push('/srv/operator/.env.backup');
    const reader = parser('inotify', { targets });
    expect(reader.parseLine('/srv/operator/.env.backup ACCESS')).toHaveLength(1);
    expect(reader.parseLine(`${root}/./.env.backup ACCESS`)).toHaveLength(1);
});

it('ignores files outside the manifest and relative paths, even with a matching basename', () => {
    const inotify = parser('inotify'), audit = parser();
    for (const path of [join(base, '.env.backup'), join(root, 'other'), '/etc/passwd', '.env.backup', `${honeyfile}.other`]) {
        expect(inotify.parseLine(`${path} ACCESS`)).toEqual([]);
        expect(audit.parseLine(auditPath(path))).toEqual([]);
    }
});

it('treats an ordinary syslog, dpkg, ssh and kernel corpus as zero events', () => {
    const corpus = [
        'Nov 11 08:45:01 host CRON[1283]: (root) CMD (test -x /usr/sbin/anacron)',
        '2026-11-11 08:46:00 status installed nodejs:amd64 20.19.0',
        'Nov 11 08:47:00 host sshd[2501]: Accepted publickey for operator from 192.0.2.1 port 41234 ssh2',
        'Nov 11 08:47:01 host sshd[2501]: pam_unix(sshd:session): session opened for user operator(uid=1001)',
        '[12345.678] eth0: link becomes ready',
        'type=SERVICE_START msg=audit(1730000000.123456:73): pid=1 uid=0 comm="systemd"',
        'kernel: audit: type=1400 audit(1730000000.123:74): apparmor="DENIED" operation="open" name="/etc/hosts"',
        'Nov 11 host systemd[1]: Started Daily package upgrade and clean activities.',
        '2026-11-11 08:48:00 upgrade libssl3:amd64 3.0.0 3.0.1',
        'kernel: [12345.9] EXT4-fs (sda1): mounted filesystem with ordered data mode',
    ];
    for (const source of ['auditd', 'inotify'] as const) {
        const reader = parser(source);
        for (const line of corpus) expect(reader.parseLine(line)).toEqual([]);
    }
});

it('drops malformed, binary and huge lines without throwing or consuming the hit rate', () => {
    const lines = ['', ' ', '{"type":"PATH"}', '\0', '\ufffd', 'x'.repeat(20000),
        `${honeyfile}\0 ACCESS`, `${honeyfile} ACCESS\u001b`, 'type=PATH name="unterminated',
        `type=PATH msg=audit(1730000000.1:1): name="${honeyfile}\\x{999999999999999999999999}"`,
        `type=PATH msg=audit(1730000000.1:1): name="${honeyfile}\\777"`,
        'type=PATH msg=audit(1730000000.1:1): name="\\x00"',
        'type=PATH msg=audit(1730000000.1:1): name="\\xZZ"',
        `type=PATH msg=audit(1730000000.1:1): name="${honeyfile}" name="${honeyfile}"`,
    ];
    for (const source of ['auditd', 'inotify'] as const) {
        const reader = parser(source, { maxEventsPerMinute: 1 });
        for (const line of lines) expect(reader.parseLine(line)).toEqual([]);
        expect(reader.parseLine(source === 'auditd' ? auditPath() : hit().trimEnd())).toHaveLength(1);
    }
});

it('enforces the UTF-8 byte line cap including at the exact boundary', () => {
    const line = hit().trimEnd();
    expect(parser('inotify', { maxLineBytes: Buffer.byteLength(line) }).parseLine(line)).toHaveLength(1);
    expect(parser('inotify', { maxLineBytes: Buffer.byteLength(line) - 1 }).parseLine(line)).toEqual([]);
    expect(parser('inotify', { maxLineBytes: line.length + 2 }).parseLine(line + '\u00e9\u00e9')).toEqual([]);
});

it('caps matching events per minute using arrival time and tolerates clock rollback', () => {
    let now = 100000;
    const reader = parser('auditd', { maxEventsPerMinute: 2, now: () => now });
    expect(reader.parseLine(auditPath())).toHaveLength(1);
    expect(reader.parseLine(auditPath(honeyfile, '74', '1.0'))).toHaveLength(1);
    expect(reader.parseLine(auditPath())).toEqual([]);
    now -= 1000;
    expect(reader.parseLine(auditPath())).toEqual([]);
    now = 160000;
    expect(reader.parseLine(auditPath())).toHaveLength(1);
});

it('defaults to at most sixty accepted reads per minute', () => {
    const reader = parser('inotify', { now: () => 100000 });
    for (let i = 0; i < 60; i++) expect(reader.parseLine(hit().trimEnd())).toHaveLength(1);
    expect(reader.parseLine(hit().trimEnd())).toEqual([]);
});

it('starts at EOF by default and only emits appended complete lines', () => {
    writeFileSync(log, hit());
    const { session, output } = watch();
    expect(session.tick()).toEqual([]);
    appendFileSync(log, hit());
    expect(session.tick()).toHaveLength(1);
    expect(output).toHaveLength(1);
    expect(session.tick()).toEqual([]);
});

it('discards the existing partial line at EOF before accepting a fresh line', () => {
    writeFileSync(log, honeyfile);
    const { session } = watch();
    appendFileSync(log, ' ACCESS\n' + hit());
    expect(session.tick()).toHaveLength(1);
});

it('retains partial lines across ticks and handles CRLF', () => {
    const { session } = watch(['--from-start']);
    appendFileSync(log, honeyfile);
    expect(session.tick()).toEqual([]);
    appendFileSync(log, ' ACCESS\r\n');
    expect(session.tick()).toHaveLength(1);
    expect(session.tick()).toEqual([]);
});

it('drops a huge line across multiple bounded ticks and recovers on the next newline', () => {
    const { session } = watch(['--from-start', '--max-line-bytes', '512']);
    writeFileSync(log, 'x'.repeat(2 * 1024 * 1024 + 100));
    for (let i = 0; i < 3; i++) expect(session.tick()).toEqual([]);
    appendFileSync(log, '\n' + hit());
    expect(session.tick()).toHaveLength(1);
});

it('reads from zero after truncation and accepts both generations', () => {
    writeFileSync(log, hit(',OPEN') + 'unrelated log line\n');
    const { session, output } = watch(['--from-start']);
    expect(session.tick()).toHaveLength(1);
    truncateSync(log, 0);
    appendFileSync(log, hit());
    expect(session.tick()).toHaveLength(1);
    expect(output.map(line => JSON.parse(line).event)).toEqual(['honeyfile_read', 'honeyfile_read']);
});

it('detects copytruncate when a rewrite is already larger than the prior offset', () => {
    writeFileSync(log, hit());
    const { session } = watch(['--from-start']);
    expect(session.tick()).toHaveLength(1);
    writeFileSync(log, hit(',OPEN') + 'a longer new generation\n');
    expect(session.tick()).toHaveLength(1);
});

it('follows inode replacement and waits through missing files at runtime', () => {
    writeFileSync(log, hit());
    const { session } = watch(['--from-start']);
    expect(session.tick()).toHaveLength(1);
    renameSync(log, log + '.1');
    expect(session.tick()).toEqual([]);
    writeFileSync(log, hit());
    expect(session.tick()).toHaveLength(1);
});

it('clears audit correlation and partial line state on rotation', () => {
    writeFileSync(log, syscall() + '\n' + 'partial');
    const output: string[] = [];
    const argv = args(['--from-start']); argv[0] = '--auditd';
    const session = createWatchFromArgs(argv, line => output.push(line)); sessions.push(session);
    expect(session.tick()).toEqual([]);
    renameSync(log, log + '.1');
    writeFileSync(log, auditPath() + '\n');
    expect(session.tick()).toHaveLength(1);
    expect(JSON.parse(output[0]!).honeyfile).not.toHaveProperty('uid');
});

it('does not follow a symlink substituted for the log during polling', () => {
    const { session } = watch(['--from-start']);
    const outside = join(base, 'outside.log'); writeFileSync(outside, hit());
    unlinkSync(log); symlinkSync(outside, log);
    expect(session.tick()).toEqual([]);
    unlinkSync(log); writeFileSync(log, hit());
    expect(session.tick()).toHaveLength(1);
});

it('enforces the watcher rate cap before JSONL output and alert delivery', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    writeFileSync(log, hit() + hit(',OPEN') + hit());
    const { session, output } = watch(['--from-start', '--max-events-per-minute', '1'], [{ name: 'fake', send }]);
    expect(session.tick()).toHaveLength(1);
    await session.flush();
    expect(output).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
});

it('delivers a medium read once through the dispatcher and isolates alert status from hit output', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const { session, output } = watch(['--from-start'], [{ name: 'injected', send }]);
    writeFileSync(log, hit() + hit());
    expect(session.tick()).toHaveLength(2);
    await session.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([expect.objectContaining({ event: expect.objectContaining({ event: 'honeyfile_read', severity: 'medium' }) }), expect.any(AbortSignal)]);
    expect(output.map(line => JSON.parse(line).event)).toEqual(['honeyfile_read', 'honeyfile_read']);
});

it('uses the configured webhook adapter through the dispatcher without any network', async () => {
    vi.stubEnv('AG_ALERT_WEBHOOK_URL', 'https://alerts.operator.example/receive');
    vi.stubEnv('AG_ALERT_WEBHOOK_SECRET', 'alert test secret');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    const { session, output } = watch(['--from-start']);
    writeFileSync(log, hit()); session.tick(); await session.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0]![1]!;
    expect(JSON.parse(request.body as string).event.event).toBe('honeyfile_read');
    expect(request.headers).toHaveProperty('X-AgentGuard-Signature');
    expect(output.join('')).not.toContain('alert test secret');
});

it('preserves dispatcher severity filtering for an injected watcher configuration', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const session = createWatcher({ source: 'inotify', targets: loadHoneyfiles(root, manifest, 'test'), project: 'test', env: 'test',
        logPath: log, fromStart: true, sink: () => {}, alerts: { adapters: [{ name: 'fake', send }], minSeverity: 'high' } });
    sessions.push(session);
    writeFileSync(log, hit()); expect(session.tick()).toHaveLength(1); await session.flush();
    expect(send).not.toHaveBeenCalled();
});

it('starts and stops the polling loop without doing more work after close', async () => {
    vi.useFakeTimers();
    const { session, output } = watch(['--from-start', '--interval-ms', '250']);
    session.start(); session.start();
    appendFileSync(log, hit());
    await vi.advanceTimersByTimeAsync(250);
    expect(output).toHaveLength(1);
    await session.close();
    appendFileSync(log, hit());
    await vi.advanceTimersByTimeAsync(500);
    expect(session.tick()).toEqual([]);
    expect(output).toHaveLength(1);
});

it.each(['log', 'manifest', 'honeyfile', 'registry', 'root', 'log-ancestor', 'honeyfile-ancestor'] as const)('rejects a startup symlink in %s with exit 2', kind => {
    let argv = args(['--registry', registry]);
    const outside = join(base, 'outside');
    if (kind === 'root') {
        renameSync(root, outside); symlinkSync(outside, root);
    } else if (kind === 'log-ancestor') {
        mkdirSync(outside); writeFileSync(join(outside, 'access.log'), hit());
        const alias = join(base, 'log-alias'); symlinkSync(outside, alias);
        argv[1] = join(alias, 'access.log');
    } else if (kind === 'honeyfile-ancestor') {
        const nestedRoot = join(base, 'nested'); mkdirSync(nestedRoot); renameSync(root, outside); symlinkSync(outside, join(nestedRoot, 'alias'));
        argv[argv.indexOf('--dir') + 1] = join(nestedRoot, 'alias');
    } else {
        const path = { log, manifest, honeyfile, registry }[kind];
        renameSync(path, outside); symlinkSync(outside, path);
    }
    const output: string[] = [];
    expect(runCLI(['watch', ...argv], line => output.push(line))).toBe(2);
    expect(output.join('')).not.toContain('AG-CANARY-');
});

it.each(['../outside', '/outside', '.aws/../../outside', 'nested/../.env.backup', 'nested\\file', 'C:outside'])('rejects manifest destination %s with exit 2', path => {
    const value = JSON.parse(readFileSync(manifest, 'utf8'));
    value.files[0].path = path; writeFileSync(manifest, JSON.stringify(value));
    expect(runCLI(['watch', ...args()], () => {})).toBe(2);
});

it.each(['--inotify-log', '--manifest', '--dir', '--registry'])('rejects lexical path traversal in %s with exit 2', key => {
    const argv = args(['--registry', registry]);
    const index = argv.indexOf(key);
    argv[index + 1] = `${root}/../${key === '--manifest' ? 'manifest.json' : key === '--registry' ? 'registry.json' : 'access.log'}`;
    expect(runCLI(['watch', ...argv], () => {})).toBe(2);
});

it.each(['log', 'manifest', 'honeyfile', 'registry'] as const)('rejects a missing startup %s without hanging', kind => {
    unlinkSync({ log, manifest, honeyfile, registry }[kind]);
    expect(runCLI(['watch', ...args(['--registry', registry])], () => {})).toBe(2);
});

it('rejects non-regular startup log and honeyfile paths', () => {
    unlinkSync(log); mkdirSync(log);
    expect(runCLI(['watch', ...args()], () => {})).toBe(2);
    rmSync(log, { recursive: true }); writeFileSync(log, '');
    unlinkSync(honeyfile); mkdirSync(honeyfile);
    expect(runCLI(['watch', ...args()], () => {})).toBe(2);
});

it('validates the supplied registry against manifest placements without exposing tokens', () => {
    const value = JSON.parse(readFileSync(registry, 'utf8'));
    value.canaries[0].placement = 'different'; writeFileSync(registry, JSON.stringify(value));
    const output: string[] = [];
    expect(runCLI(['watch', ...args(['--registry', registry])], line => output.push(line))).toBe(2);
    expect(output.join('')).not.toContain('AG-CANARY-');
});

it('refuses a registry containing a filename instead of an object without following it', () => {
    const alias = join(base, 'registry-alias.json'), indirect = join(base, 'indirect.json');
    symlinkSync(registry, alias); writeFileSync(indirect, JSON.stringify(alias));
    expect(runWatch(args(['--registry', indirect]), () => {}, { start: session => { sessions.push(session); } })).toBe(2);
});

describe('startup usage', () => {
    it.each(['--inotify-log', '--dir', '--manifest', '--project', '--env'])('requires %s', key => {
        const argv = args(); argv.splice(argv.indexOf(key), 2);
        expect(runCLI(['watch', ...argv], () => {})).toBe(2);
    });

    it.each([['--auditd', 'other.log'], ['--unknown'], ['--from-start', '--from-start'], ['--dir'],
        ['--project', 'duplicate'], ['positional'], ['--interval-ms', '0'], ['--interval-ms', '-1'],
        ['--interval-ms', 'NaN'], ['--interval-ms', '1.5'], ['--interval-ms', '60001'],
        ['--max-line-bytes', '0'], ['--max-line-bytes', '1048577'], ['--max-events-per-minute', '100001']])('rejects invalid options %j', (...extra) => {
        expect(runCLI(['watch', ...args(extra)], () => {})).toBe(2);
    });

    it('lists watch in the top-level usage', () => {
        const output: string[] = [];
        expect(runCLI([], line => output.push(line))).toBe(2);
        expect(output.join('')).toContain('agent-guard watch');
    });

    it('returns 2 for malformed metadata without reflecting its input', () => {
        writeFileSync(manifest, 'malformed operator-sensitive-value');
        const output: string[] = [];
        expect(runCLI(['watch', ...args()], line => output.push(line))).toBe(2);
        expect(output.join('')).not.toContain('operator-sensitive-value');
    });

    it('allows a test driver to run the CLI once without a long-running timer', () => {
        writeFileSync(log, hit());
        const output: string[] = [];
        expect(runWatch(args(['--from-start']), line => output.push(line), { start: session => { sessions.push(session); session.tick(); } })).toBe(0);
        expect(output).toHaveLength(1);
        expect(JSON.parse(output[0]!).event).toBe('honeyfile_read');
    });
});

it.each(['auditd', 'inotify'] as const)('seed --write plus watch --from-start accepts exactly one realistic %s read', source => {
    const argv = args(['--from-start', '--registry', registry]);
    if (source === 'auditd') argv[0] = '--auditd';
    const realistic = source === 'auditd' ? syscall() + '\n' + auditPath() + '\n' : `${root}/ ACCESS .env.backup\n`;
    writeFileSync(log, realistic + 'Nov 11 host sshd[42]: session closed for user operator\n');
    const output: string[] = [];
    const session = createWatchFromArgs(argv, line => output.push(line)); sessions.push(session);
    expect(session.tick()).toHaveLength(1);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ event: 'honeyfile_read', honeyfile: { source, path: '.env.backup' } });
    expect(session.tick()).toEqual([]);
});

it('runs the real watch CLI and stops cleanly after emitting a seeded read', async () => {
    writeFileSync(log, hit() + '/unrelated/file MODIFY\n');
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'watch', ...args(['--from-start', '--interval-ms', '50'])], {
        cwd: join(import.meta.dirname, '../..'), stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    try {
        const code = await new Promise<number | null>((resolve, reject) => {
            const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('watch CLI timed out')); }, 8000);
            let buffer = '';
            child.stdout.on('data', chunk => {
                buffer += String(chunk);
                if (buffer.includes('\n')) {
                    lines.push(...buffer.trimEnd().split('\n')); buffer = '';
                    child.kill('SIGTERM');
                }
            });
            child.once('error', error => { clearTimeout(timeout); reject(error); });
            child.once('close', code => { clearTimeout(timeout); resolve(code); });
        });
        expect(code).toBe(0);
        expect(stderr).toBe('');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!).event).toBe('honeyfile_read');
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});

it('frames ordinary lines and drops overlong lines independently of the parser', () => {
    const follower = createLogFollower(log, { fromStart: true, maxLineBytes: 64 });
    const lines: string[] = [];
    writeFileSync(log, 'first\n' + 'x'.repeat(65) + '\nlast\n');
    follower.tick(line => lines.push(line));
    expect(lines).toEqual(['first', 'last']);
});
