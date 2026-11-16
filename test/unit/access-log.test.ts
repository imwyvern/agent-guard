import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { generateCanary } from '../../src/index.js';
import { createAccessLogParser, createAccessWatcher, type AccessFormat } from '../../src/watch/access.js';
import { createWatchFromArgs } from '../../src/cli/watch.js';
import { config } from '../helpers.js';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const token = generateCanary({ secret: 'access-log-test-secret' });
const cfg = () => config({ canary: { secret: 'access-log-test-secret', registry: { version: 1, prefix: 'AG-CANARY-', canaries: [{ ...token, placement: 'fixture:query', env: 'test', createdAt: '2026-11-16T00:00:00.000Z' }] } } });
function sample(format: AccessFormat, target = '/.env', ua = 'curl/8.0'): string {
    if (format === 'json') return JSON.stringify({ path: target, ip: '192.0.2.1', ua, time: '2026-11-16T01:02:03.000Z', status: 200 });
    const common = `192.0.2.1 - - [16/Nov/2026:01:02:03 +0000] "GET ${target} HTTP/1.1" 200 123`;
    return format === 'combined' ? common + ` "-" "${ua}"` : common;
}
it.each(['combined', 'common', 'json'] as const)('DI-7: parses %s decoy hits and query/path replay, with zero ordinary events', format => {
    const parser = createAccessLogParser({ format, config: cfg() });
    const hits = parser.parseLine(sample(format));
    expect(hits).toHaveLength(1); expect(hits[0]).toMatchObject({ event: 'decoy_hit', source: 'access_log', decoy: { id: 'D1', status: 200 }, ts: '2026-11-16T01:02:03.000Z' });
    for (const target of [`/normal?key=${token.token}`, `/normal/${token.token}`]) {
        const events = parser.parseLine(sample(format, target));
        expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ event: 'canary_replay', source: 'access_log', canary: { id: token.id, placement: 'fixture:query' } });
    }
    expect(parser.parseLine(sample(format, '/ordinary?q=value'))).toEqual([]);
    expect(parser.parseLine(sample(format, '/normal?key=AG-CANARY-000000000000-000000'))).toEqual([]);
});
it('recognizes authenticated unregistered canaries and rotated registry entries through the shared scanner', () => {
    const registry = cfg(), signed = generateCanary({ secret: registry.canary.secret }).token;
    const parser = createAccessLogParser({ format: 'json', config: registry });
    expect(parser.parseLine(sample('json', '/?key=' + signed))[0]?.canary?.placement).toBe('unregistered');
    const rotated = cfg(); rotated.canary.secret = 'rotated-secret';
    expect(createAccessLogParser({ format: 'json', config: rotated }).parseLine(sample('json', '/?key=' + token.token))[0]?.canary?.placement).toBe('fixture:query');
});
it('matches configured decoy paths and respects disabled routes', () => {
    const guardConfig = cfg(); guardConfig.decoys = { enabled: ['D1'], paths: { D1: '/isolated' } };
    const parser = createAccessLogParser({ format: 'json', config: guardConfig });
    expect(parser.parseLine(sample('json', '/.env'))).toEqual([]); expect(parser.parseLine(sample('json', '/isolated'))[0]?.decoy?.id).toBe('D1');
});
it('supports configurable JSON field names and full request lines', () => {
    const parser = createAccessLogParser({ format: 'json', config: cfg(), fields: { path: 'request', status: 'code', ua: 'agent', ip: 'remote', time: 'at' } });
    const events = parser.parseLine(JSON.stringify({ request: 'GET /.env HTTP/1.1', code: 403, agent: 'Googlebot', remote: '192.0.2.9', at: '2026-11-16T00:00:00Z' }));
    expect(events[0]).toMatchObject({ decoy: { status: 403 }, crawler: { claimed: 'google', verified: false }, req: { ip: '192.0.2.9' } });
    expect(events[0]?.req.ua_class).not.toBe('verified_crawler');
});
it.each(['combined', 'common', 'json'] as const)('drops malformed, overlong and hostile %s lines without throwing', format => {
    const parser = createAccessLogParser({ format, config: cfg() });
    for (const line of ['', '{', 'null', '[]', 'ordinary garbage', sample(format) + '\0', 'x'.repeat(20000), '"'.repeat(16384), sample(format).replace('200', '999')]) expect(parser.parseLine(line)).toEqual([]);
});
it('enforces the event rate budget across rotation and resets it after a minute', () => {
    let time = 1000;
    const parser = createAccessLogParser({ format: 'json', config: cfg(), maxEventsPerMinute: 2, now: () => time });
    expect(parser.parseLine(sample('json'))).toHaveLength(1); expect(parser.parseLine(sample('json'))).toHaveLength(1);
    parser.reset(); expect(parser.parseLine(sample('json'))).toEqual([]);
    time += 60000; expect(parser.parseLine(sample('json'))).toHaveLength(1);
});
it('tails from EOF, follows inode replacement and truncation, and bounds partial/overlong lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-access-')); dirs.push(dir);
    const path = join(dir, 'access.log'), initial = sample('common') + '\n'; writeFileSync(path, initial);
    const before = readFileSync(path), events: unknown[] = [];
    const watcher = createAccessWatcher({ format: 'common', config: cfg(), logPath: path, sink: event => events.push(event) });
    try {
        expect(watcher.tick()).toEqual([]); expect(readFileSync(path)).toEqual(before);
        appendFileSync(path, initial); expect(watcher.tick()).toHaveLength(1);
        renameSync(path, path + '.1'); writeFileSync(path, initial); expect(watcher.tick()).toHaveLength(1);
        writeFileSync(path, 'bad\n' + initial); expect(watcher.tick()).toHaveLength(1);
        appendFileSync(path, 'x'.repeat(20000)); expect(watcher.tick()).toEqual([]);
        appendFileSync(path, '\n' + initial); expect(watcher.tick()).toHaveLength(1);
        expect(events).toHaveLength(4);
    } finally { await watcher.close(); }
    const history = createAccessWatcher({ format: 'common', config: cfg(), logPath: path, fromStart: true, sink: () => {} });
    try { expect(history.tick()).toHaveLength(2); } finally { await history.close(); }
});
it('CLI supports access logs and rejects mixed sources, malformed field maps and limits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-access-')); dirs.push(dir); const path = join(dir, 'access.log'); writeFileSync(path, sample('json') + '\n');
    vi.stubEnv('AG_CANARY_SECRET', 'access-log-test-secret'); vi.stubEnv('AG_PROJECT_SEED', 'test-seed');
    const args = ['--log', path, '--format', 'json', '--from-start'];
    const watch = createWatchFromArgs(args, () => {});
    try { expect(watch.tick()[0]?.source).toBe('access_log'); } finally { await watch.close(); }
    for (const extra of [['--auditd', path], ['--inotify-log', path], ['--fields', '[]'], ['--max-line-bytes', '0'], ['--fields', '{"unknown":"x"}'], ['--dir', dir]]) expect(() => createWatchFromArgs([...args, ...extra], () => {})).toThrow();
});
it('emitted access-log events validate against the additive v1 schema', async () => {
    const { $schema: _draft, ...schema } = JSON.parse(readFileSync(new URL('../../schema/event.v1.json', import.meta.url), 'utf8'));
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
    app.post('/', { schema: { body: schema } }, async () => ({ ok: true }));
    try {
        const parser = createAccessLogParser({ format: 'combined', config: cfg() });
        for (const event of parser.parseLine(sample('combined', '/.env?key=' + token.token))) expect((await app.inject({ method: 'POST', url: '/', payload: event })).statusCode).toBe(200);
    } finally { await app.close(); }
});
