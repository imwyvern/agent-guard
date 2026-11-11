import { EventEmitter } from 'node:events';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runCLI } from '../../src/cli/commands.js';
import { createWatchFromArgs } from '../../src/cli/watch.js';
import { createWatcher, type WatchSession } from '../../src/watch/monitor.js';
import type { AgentGuardEvent } from '../../src/types.js';

class Child extends EventEmitter {
    kill = vi.fn((_signal: NodeJS.Signals) => true);
}
let directory: string;
const sessions: WatchSession[] = [];
beforeEach(() => { vi.useFakeTimers(); directory = mkdtempSync(join(tmpdir(), 'ag-hooks-watch-')); });
afterEach(async () => {
    const closing = Promise.all(sessions.splice(0).map(session => session.close()));
    await vi.advanceTimersByTimeAsync(1000); await closing;
    vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});

it('dispatches watch honeyfile_read metadata with limits and closes its runner', async () => {
    const logPath = join(directory, 'access.log'), absolute = join(directory, 'honeyfile');
    writeFileSync(logPath, `${absolute} ACCESS\n`);
    const children: Child[] = [], seen: AgentGuardEvent[] = [];
    const spawn = vi.fn(() => { const child = new Child(); children.push(child); return child; });
    const send = vi.fn(async () => ({ ok: true }));
    const session = createWatcher({ source: 'inotify', targets: [{ path: '.env.backup', placement: 'honeyfile:generic:.env.backup', absolutePaths: [absolute] }],
        project: 'test', env: 'test', logPath, fromStart: true, sink: event => seen.push(event), alerts: { adapters: [{ name: 'injected', send }] },
        hooks: [{ on: 'honeyfile_read', run: ['/opt/operator/hook'], maxConcurrent: 1 }], hookDependencies: { spawn } }); sessions.push(session);
    expect(session.tick().map(event => event.event)).toEqual(['honeyfile_read']);
    expect(spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]).toEqual(['/opt/operator/hook', [], { shell: false, stdio: 'ignore', windowsHide: true,
        env: { AG_EVENT_TYPE: 'honeyfile_read', AG_CLIENT_KEY_HASH: expect.stringMatching(/^[a-f0-9]{64}$/), AG_PLACEMENT: 'honeyfile:generic:.env.backup' } }]);
    appendFileSync(logPath, `${absolute} ACCESS\n`); session.tick();
    expect(seen.filter(event => event.event === 'hook_result').map(event => event.hook?.reason)).toEqual(['concurrency_limit']);
    expect(spawn).toHaveBeenCalledTimes(1);
    await session.flush(); expect(send).toHaveBeenCalledTimes(1);
    const closing = session.close();
    expect(children[0]!.kill.mock.calls).toEqual([['SIGTERM']]);
    await vi.advanceTimersByTimeAsync(1000); await closing;
    expect(children[0]!.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(session.tick()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
});

it('supports optional hooks through watch dependencies without new CLI flags', async () => {
    const root = join(directory, 'seed'), manifest = join(directory, 'manifest.json'), registry = join(directory, 'registry.json');
    const seed = join(directory, 'seed.txt'), log = join(directory, 'access.log');
    writeFileSync(seed, 'hook-watch-project-seed'); writeFileSync(log, '');
    vi.stubEnv('AG_CANARY_SECRET', 'hook-watch-canary-secret');
    expect(runCLI(['seed', '--profile', 'generic', '--dir', root, '--manifest', manifest, '--registry', registry, '--seed-file', seed, '--env', 'test', '--write'], () => {})).toBe(0);
    appendFileSync(log, `${join(root, '.env.backup')} ACCESS\n`);
    const output: AgentGuardEvent[] = [], child = new Child(), spawn = vi.fn(() => child);
    const session = createWatchFromArgs(['--inotify-log', log, '--dir', root, '--manifest', manifest, '--project', 'test', '--env', 'test', '--from-start'],
        line => output.push(JSON.parse(line) as AgentGuardEvent), { adapters: [], hooks: [{ on: 'honeyfile_read', run: ['/opt/operator/hook'] }], hookDependencies: { spawn } }); sessions.push(session);
    expect(session.tick()).toHaveLength(1); await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(1); child.emit('exit', 0, null);
    expect(output.map(event => event.event)).toEqual(['honeyfile_read', 'hook_result']);
    expect(output[1]!.hook).toEqual({ on: 'honeyfile_read', status: 'success' });
});

it.each([undefined, []])('leaves the watch stream unchanged with disabled hooks: %j', async hooks => {
    const logPath = join(directory, 'access.log'), absolute = join(directory, 'honeyfile'); writeFileSync(logPath, `${absolute} ACCESS\n`);
    const sink = vi.fn(), spawn = vi.fn(() => new Child());
    const session = createWatcher({ source: 'inotify', targets: [{ path: '.env.backup', placement: 'placement', absolutePaths: [absolute] }],
        project: 'test', env: 'test', logPath, fromStart: true, sink, hooks, hookDependencies: { spawn } }); sessions.push(session);
    const events = session.tick(); await vi.advanceTimersByTimeAsync(10000);
    expect(events.map(event => event.event)).toEqual(['honeyfile_read']);
    expect(sink).toHaveBeenCalledTimes(1); expect(spawn).not.toHaveBeenCalled();
});
