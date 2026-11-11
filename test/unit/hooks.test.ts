import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HookRunner, type HookSpawn } from '../../src/hooks/runner.js';
import type { AgentGuardEvent, ResponseHook } from '../../src/types.js';
import { event } from '../helpers.js';

class Child extends EventEmitter {
    kill = vi.fn((_signal: NodeJS.Signals) => true);
    unref = vi.fn();
}
const runners: HookRunner[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(async () => {
    const closing = Promise.all(runners.splice(0).map(runner => runner.close()));
    await vi.advanceTimersByTimeAsync(1000);
    await closing;
    vi.useRealTimers();
});
const hook = (overrides: Partial<ResponseHook> = {}): ResponseHook => ({ on: 'canary_replay', run: ['/opt/operator/hook', 'literal'], ...overrides });
const replay = (overrides: Partial<AgentGuardEvent> = {}): AgentGuardEvent => event({ event: 'canary_replay', ...overrides });
function setup(hooks: ResponseHook[] | undefined = [hook()], spawnOverride?: HookSpawn) {
    const results: AgentGuardEvent[] = [], children: Child[] = [];
    const spawn = vi.fn<HookSpawn>(spawnOverride ?? (() => { const child = new Child(); children.push(child); return child; }));
    const runner = new HookRunner(hooks, result => results.push(result), { spawn });
    runners.push(runner);
    return { runner, spawn, results, children };
}

it('does no work and emits no results for unconfigured or empty hooks', async () => {
    for (const hooks of [undefined, []]) {
        const spawn = vi.fn<HookSpawn>(), results: AgentGuardEvent[] = [];
        const runner = new HookRunner(hooks, result => results.push(result), { spawn }); runners.push(runner);
        runner.dispatch(replay()); runner.dispatch(event({ event: 'honeyfile_read' }));
        await vi.advanceTimersByTimeAsync(0);
        expect(spawn).not.toHaveBeenCalled();
        expect(results).toEqual([]);
    }
    expect(vi.getTimerCount()).toBe(0);
});

it('copies fixed argv and only whitelist metadata before the deferred spawn', async () => {
    const configured = hook({ run: ['/opt/operator/hook', ';`literal`$(literal)\n', ''] });
    const { runner, spawn, children, results } = setup([configured]);
    const source = replay({ req: { method: 'POST', path: '/private;`path`$(path)\n', client_key: 'raw-client-key', ip: '192.0.2.9', ua: 'raw-ua;`ua`$(ua)\n', query_keys: ['private-query'] },
        incident: { id: 'incident-id', sequence: ['canary_replay'], first_seen: new Date(1000).toISOString(), last_seen: new Date(1000).toISOString(), confidence: 'high' },
        canary: { id: 'canary-id', placement: 'operator-placement', env: 'test', found_in: 'header', field: 'private-header' } });
    runner.dispatch(source);
    configured.run[0] = '/opt/changed'; source.req.client_key = 'changed'; source.canary!.placement = 'changed';
    expect(spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledExactlyOnceWith('/opt/operator/hook', [';`literal`$(literal)\n', ''], {
        shell: false, windowsHide: true, stdio: 'ignore', env: {
            AG_INCIDENT_ID: 'incident-id', AG_EVENT_TYPE: 'canary_replay',
            AG_CLIENT_KEY_HASH: createHash('sha256').update('raw-client-key').digest('hex'), AG_CANARY_ID: 'canary-id', AG_PLACEMENT: 'operator-placement',
        },
    });
    const env = spawn.mock.calls[0]![2].env;
    expect(Object.getPrototypeOf(env)).toBeNull();
    children[0]!.emit('exit', 0, null);
    expect(results[0]!.hook).toEqual({ on: 'canary_replay', status: 'success' });
    expect(results[0]!.req).toEqual({ method: 'HOOK', path: '', client_key: env.AG_CLIENT_KEY_HASH });
    const serialized = JSON.stringify(results);
    for (const value of ['/opt/operator/hook', 'literal', 'raw-client-key', 'private-header', 'private-query', 'raw-ua', '192.0.2.9', '/private'])
        expect(serialized).not.toContain(value);
});

it('omits unavailable metadata and uses honeyfile placement without its path or process fields', async () => {
    const { runner, spawn, children } = setup([hook({ on: 'honeyfile_read' })]);
    runner.dispatch(event({ event: 'honeyfile_read', req: { method: 'READ', path: '/private/path', client_key: '' },
        honeyfile: { path: '/private/path', placement: 'honeyfile:test', source: 'auditd', uid: '123', comm: '/bin/private' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn.mock.calls[0]![2].env).toEqual({ AG_EVENT_TYPE: 'honeyfile_read', AG_PLACEMENT: 'honeyfile:test' });
    children[0]!.emit('exit', 0, null);
});

it('ignores unrelated events and its own results, including high-confidence results', async () => {
    const { runner, spawn, results } = setup([hook(), hook({ on: 'incident_high' })]);
    runner.dispatch(event());
    runner.dispatch(event({ event: 'hook_result', incident: { id: 'id', sequence: ['canary_replay'], first_seen: new Date(0).toISOString(), last_seen: new Date(0).toISOString(), confidence: 'high' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).not.toHaveBeenCalled(); expect(results).toEqual([]);
});

it('enforces per-entry rate windows, retains limits on clock rollback, and resets at one hour', async () => {
    const { runner, spawn, children, results } = setup([hook({ maxPerHour: 2 })]);
    for (let i = 0; i < 2; i++) { runner.dispatch(replay()); await vi.advanceTimersByTimeAsync(0); children[i]!.emit('exit', 0, null); }
    runner.dispatch(replay()); runner.dispatch(replay());
    vi.setSystemTime(0); runner.dispatch(replay());
    vi.setSystemTime(3_600_999); runner.dispatch(replay());
    expect(results.filter(result => result.hook?.reason === 'rate_limit')).toHaveLength(4);
    expect(spawn).toHaveBeenCalledTimes(2);
    vi.setSystemTime(3_601_000); runner.dispatch(replay()); await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(3); children[2]!.emit('exit', 0, null);
});

it('keeps separate per-hour allowances for entries with the same trigger', async () => {
    const { runner, spawn, children, results } = setup([hook({ maxPerHour: 1 }), hook({ maxPerHour: 1 })]);
    runner.dispatch(replay()); await vi.advanceTimersByTimeAsync(0);
    children.forEach(child => child.emit('exit', 0, null));
    runner.dispatch(replay()); await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(results.filter(result => result.hook?.reason === 'rate_limit')).toHaveLength(2);
});

it('caps pending and running work without queuing excess attempts', async () => {
    const { runner, spawn, children, results } = setup([hook({ maxConcurrent: 1 })]);
    for (let i = 0; i < 20; i++) runner.dispatch(replay());
    expect(spawn).not.toHaveBeenCalled();
    expect(results).toHaveLength(19);
    expect(results.every(result => result.hook?.status === 'refused' && result.hook.reason === 'concurrency_limit')).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    runner.dispatch(replay()); expect(results).toHaveLength(20);
    children[0]!.emit('exit', 0, null);
    runner.dispatch(replay()); await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(2); children[1]!.emit('exit', 0, null);
});

it('caps total work across many entries and runner instances, and releases reservations', async () => {
    const samples = Array.from({ length: 3 }, () => setup(Array.from({ length: 8 }, () => hook())));
    for (const sample of samples) sample.runner.dispatch(replay());
    expect(samples[2]!.results.map(result => result.hook?.reason)).toEqual(Array(8).fill('global_concurrency_limit'));
    await vi.advanceTimersByTimeAsync(0);
    expect(samples.map(sample => sample.spawn.mock.calls.length)).toEqual([8, 8, 0]);
    for (const sample of samples.slice(0, 2)) sample.children.forEach(child => child.emit('exit', 0, null));
    samples[2]!.runner.dispatch(replay()); await vi.advanceTimersByTimeAsync(0);
    expect(samples[2]!.spawn).toHaveBeenCalledTimes(8);
    samples[2]!.children.forEach(child => child.emit('exit', 0, null));
});

it('records timeout once, sends SIGTERM then SIGKILL, and holds concurrency through the grace period', async () => {
    const { runner, children, results, spawn } = setup([hook({ timeoutMs: 5, maxConcurrent: 1 })]);
    runner.dispatch(replay()); await vi.advanceTimersByTimeAsync(5);
    const child = children[0]!;
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
    expect(results.map(result => result.hook?.status)).toEqual(['timeout']);
    runner.dispatch(replay()); expect(spawn).toHaveBeenCalledTimes(1);
    expect(results[1]!.hook?.reason).toBe('concurrency_limit');
    await vi.advanceTimersByTimeAsync(999); expect(child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(vi.getTimerCount()).toBe(0);
    child.emit('exit', null, 'SIGKILL'); child.emit('error', new Error('late private error'));
    expect(results).toHaveLength(2);
    await runner.close();
});

it('cancels escalation to SIGKILL when SIGTERM ends the child', async () => {
    const { runner, children, results } = setup([hook({ timeoutMs: 5 })]);
    runner.dispatch(replay()); await vi.advanceTimersByTimeAsync(0);
    children[0]!.kill.mockImplementation(signal => { children[0]!.emit('exit', null, signal); return true; });
    await vi.advanceTimersByTimeAsync(1005);
    expect(children[0]!.kill.mock.calls).toEqual([['SIGTERM']]);
    expect(results.map(result => result.hook?.status)).toEqual(['timeout']);
    expect(vi.getTimerCount()).toBe(0);
});

it('uses the default 5000ms timeout and two-child per-entry concurrency', async () => {
    const { runner, children, results } = setup();
    runner.dispatch(replay()); runner.dispatch(replay()); runner.dispatch(replay());
    await vi.advanceTimersByTimeAsync(4999);
    expect(children).toHaveLength(2); expect(children.every(child => child.kill.mock.calls.length === 0)).toBe(true);
    expect(results[0]!.hook?.reason).toBe('concurrency_limit');
    await vi.advanceTimersByTimeAsync(1);
    expect(children.every(child => child.kill.mock.calls[0]?.[0] === 'SIGTERM')).toBe(true);
});

it('uses the default ten admissions per hour', async () => {
    const { runner, spawn, children, results } = setup();
    for (let i = 0; i < 10; i++) { runner.dispatch(replay()); await vi.advanceTimersByTimeAsync(0); children[i]!.emit('exit', 0, null); }
    runner.dispatch(replay()); await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(10); expect(results[10]!.hook?.reason).toBe('rate_limit');
});

it.each([[0, null, 'success', undefined], [17, null, 'failure', 'exit_nonzero'], [null, 'SIGTERM', 'failure', 'signal']] as const)('records child exit %s / %s without exposing exit details', async (code, signal, status, reason) => {
    const { runner, children, results } = setup();
    runner.dispatch(replay()); await vi.advanceTimersByTimeAsync(0); children[0]!.emit('exit', code, signal);
    expect(results).toHaveLength(1);
    expect(results[0]!.hook).toEqual({ on: 'canary_replay', status, ...(reason ? { reason } : {}) });
    expect(vi.getTimerCount()).toBe(0);
});

it.each(['throw', 'error'] as const)('records %s spawn failure once and releases concurrency', async mode => {
    const child = new Child();
    const { runner, spawn, results } = setup([hook({ maxConcurrent: 1 })], () => { if (mode === 'throw') throw new Error('/private argv secret'); return child; });
    runner.dispatch(replay()); await vi.advanceTimersByTimeAsync(0);
    if (mode === 'error') { child.emit('error', new Error('/private argv secret')); child.emit('error', new Error('late')); }
    expect(results[0]!.hook).toEqual({ on: 'canary_replay', status: 'failure', reason: 'spawn_error' });
    expect(JSON.stringify(results)).not.toContain('/private argv secret');
    runner.dispatch(replay()); await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    if (mode === 'error') child.emit('error', new Error('second failure'));
    expect(results).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
});

it('cancels pending starts on close and refuses to schedule any more work', async () => {
    const { runner, spawn, results } = setup(); runner.dispatch(replay());
    await runner.close(); runner.dispatch(replay()); await vi.advanceTimersByTimeAsync(10000);
    expect(spawn).not.toHaveBeenCalled();
    expect(results.map(result => result.hook)).toEqual([{ on: 'canary_replay', status: 'cancelled', reason: 'closed' }]);
    expect(vi.getTimerCount()).toBe(0);
});

it('has a bounded, idempotent close even when children ignore signals or kill throws', async () => {
    const { runner, children, results } = setup(); runner.dispatch(replay()); await vi.advanceTimersByTimeAsync(0);
    children[0]!.kill.mockImplementation(() => { throw new Error('kill failure'); });
    const closing = runner.close(); expect(runner.close()).toBe(closing);
    await vi.advanceTimersByTimeAsync(1000); await expect(closing).resolves.toBeUndefined();
    expect(children[0]!.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(results.map(result => result.hook?.status)).toEqual(['cancelled']);
    expect(vi.getTimerCount()).toBe(0);
});

it('isolates result observer failures during spawn errors and close', async () => {
    const child = new Child();
    const runner = new HookRunner([hook()], () => { throw new Error('observer failure'); }, { spawn: () => child }); runners.push(runner);
    expect(() => runner.dispatch(replay())).not.toThrow(); await vi.advanceTimersByTimeAsync(0);
    expect(() => child.emit('error', new Error('spawn error'))).not.toThrow();
    runner.dispatch(replay()); await vi.advanceTimersByTimeAsync(0);
    const closing = runner.close(); await vi.advanceTimersByTimeAsync(1000);
    await expect(closing).resolves.toBeUndefined();
});
