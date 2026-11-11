import { mkdtempSync, writeFileSync, readFileSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runCLI } from '../../src/cli/commands.js';
import { INCIDENT_ERROR } from '../../src/cli/incident.js';
import { event } from '../helpers.js';

const dirs: string[] = [];
const file = (): string => { const dir = mkdtempSync(join(tmpdir(), 'ag-incident-')); dirs.push(dir); return join(dir, 'events.jsonl'); };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const first = '2026-01-01T00:00:00.000Z';
const incident = { id: 'case-one', sequence: ['robots', 'D1'], first_seen: first, last_seen: first, confidence: 'medium' as const, first_touch_at: first, dwell_ms: 0 };
function fixture(path: string): void {
    writeFileSync(path, [
        event({ ts: first, incident }),
        event({ event: 'canary_replay', ts: '2026-01-01T00:00:01.000Z', incident: { ...incident, confidence: 'high', dwell_ms: 1000 } }),
        event({ event: 'honeyfile_read', ts: '2026-01-01T00:00:02.000Z', honeyfile: { path: '.env.backup', placement: 'host', source: 'auditd' } }),
        event({ event: 'trap_block', ts: '2026-01-01T00:00:03.000Z', incident }),
        event({ event: 'incident_ack', ts: '2026-01-01T00:00:04.000Z', incident }),
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
}

it('lists a bounded timeline and keeps uncorrelated honeyfile records adjacent in JSON', () => {
    const path = file(); fixture(path);
    const before = readFileSync(path), out: string[] = [];
    expect(runCLI(['incident', 'list', '--log', path, '--json'], s => out.push(s))).toBe(0);
    const view = JSON.parse(out[0]!);
    expect(view.incidents).toHaveLength(1);
    expect(view.incidents[0]).toMatchObject({ id: incident.id, first_touch_at: first, acknowledged: true });
    expect(view.incidents[0].timeline.map((e: { event: string }) => e.event)).toEqual(['decoy_hit', 'canary_replay', 'trap_block', 'incident_ack']);
    expect(view.adjacent).toMatchObject([{ event: 'honeyfile_read', path: '.env.backup' }]);
    expect(readFileSync(path)).toEqual(before);
});

it('shows the requested incident as JSON and a human-readable timeline with first touch', () => {
    const path = file(); fixture(path);
    const out: string[] = [];
    expect(runCLI(['incident', 'show', incident.id, '--json', '--log', path], s => out.push(s))).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ id: incident.id, acknowledged: true, first_touch_at: first, adjacent: [{ event: 'honeyfile_read' }] });
    out.length = 0;
    expect(runCLI(['incident', 'show', incident.id, '--log', path], s => out.push(s))).toBe(0);
    expect(out.join('\n')).toContain(first + ' first_touch');
    for (const name of ['canary_replay', 'honeyfile_read', 'trap_block', 'incident_ack']) expect(out.join('\n')).toContain(name);
});

it('appends exactly one valid acknowledgement without changing earlier bytes', () => {
    const path = file(); fixture(path);
    const before = readFileSync(path, 'utf8');
    expect(runCLI(['incident', 'ack', incident.id, '--log', path], () => {})).toBe(0);
    const after = readFileSync(path, 'utf8');
    expect(after.slice(0, before.length)).toBe(before);
    const appended = after.slice(before.length).trim().split('\n');
    expect(appended).toHaveLength(1);
    expect(JSON.parse(appended[0]!)).toMatchObject({ v: 1, event: 'incident_ack', incident: { id: incident.id, first_seen: first }, ts: expect.any(String) });
    expect(statSync(path).mode & 0o777).toBe(0o600);
});

it('creates a 0600 acknowledgement log without requiring a running guard or prior incident', () => {
    const path = file();
    expect(runCLI(['incident', 'ack', 'unknown-id', '--log', path], () => {})).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ event: 'incident_ack', incident: { id: 'unknown-id', sequence: ['incident_ack'] } });
});

it('separates an existing record without a newline and parses partial ack metadata', () => {
    const path = file(), original = JSON.stringify(event({ incident }));
    writeFileSync(path, original);
    expect(runCLI(['incident', 'ack', incident.id, '--log', path], () => {})).toBe(0);
    expect(readFileSync(path, 'utf8').startsWith(original + '\n')).toBe(true);
    writeFileSync(path, original + '\n' + JSON.stringify({ ts: first, event: 'incident_ack', incident: { id: incident.id } }));
    const out: string[] = [];
    expect(runCLI(['incident', 'show', incident.id, '--log', path, '--json'], s => out.push(s))).toBe(0);
    expect(JSON.parse(out[0]!).acknowledged).toBe(true);
});

it('skips malicious or malformed records and bounds retained observations', () => {
    const path = file();
    writeFileSync(path, '{private-invalid-content}\n' + 'x'.repeat(70_000) + '\n' + Array.from({ length: 100 }, () => JSON.stringify(event({ incident }))).join('\n'));
    const out: string[] = [];
    expect(runCLI(['incident', 'list', '--log', path, '--json'], s => out.push(s))).toBe(0);
    const result = JSON.parse(out[0]!);
    expect(result.incidents[0].timeline).toHaveLength(32);
    expect(result.truncated).toBe(true);
    expect(out[0]).not.toContain('private-invalid-content');
});

it('shows rate-limit statuses already recorded in a log and redacts canary pathnames', () => {
    const path = file();
    writeFileSync(path, JSON.stringify(event({ incident, decoy: { id: 'D1', status: 429 }, req: { method: 'GET', path: '/AG-CANARY-' + 'A'.repeat(12) + '-' + 'A'.repeat(6), client_key: 'client' } })) + '\n');
    const out: string[] = [];
    expect(runCLI(['incident', 'show', incident.id, '--log', path], s => out.push(s))).toBe(0);
    expect(out.join('\n')).toContain('rate-limit');
    expect(out.join('\n')).not.toContain('-CANARY-');
});

it.each([
    [], ['list'], ['show'], ['ack'], ['list', '--json', '--json'], ['list', '--unknown'],
    ['show', 'absent'], ['ack', 'one', '--json'], ['list', 'extra'], ['show', '--json'],
].map(args => ({ args })))('uses a fixed exit-2 diagnostic for invalid options: %j', ({ args }) => {
    const out: string[] = [];
    expect(runCLI(['incident', ...args, '--log', file()], s => out.push(s))).toBe(2);
    expect(out).toEqual([INCIDENT_ERROR]);
});

it('refuses missing read targets, symlink writes and directories with a fixed diagnostic', () => {
    const target = file(), link = target + '.link';
    for (const args of [['list', '--log', target], ['show', 'absent', '--log', target]]) {
        const out: string[] = [];
        expect(runCLI(['incident', ...args], s => out.push(s))).toBe(2); expect(out).toEqual([INCIDENT_ERROR]);
    }
    writeFileSync(target, 'unchanged'); symlinkSync(target, link);
    const out: string[] = [];
    expect(runCLI(['incident', 'ack', 'one', '--log', link], s => out.push(s))).toBe(2);
    expect(out).toEqual([INCIDENT_ERROR]); expect(readFileSync(target, 'utf8')).toBe('unchanged');
});
