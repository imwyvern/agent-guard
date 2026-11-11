import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAgentGuard } from '../../src/index.js';
import { HookRunner } from '../../src/hooks/runner.js';
import { createWebGuard, memoryStore } from '../../src/web/index.js';
import type { AgentGuard, AgentGuardEvent } from '../../src/types.js';
import { config, request } from '../helpers.js';
import { replayToken, webConfig } from '../helpers/web.js';

vi.mock('node:child_process', async importOriginal => {
    const original = await importOriginal<typeof childProcess>();
    return { ...original, spawn: vi.fn(original.spawn) };
});

class Child extends EventEmitter {
    kill = vi.fn((signal: NodeJS.Signals) => { this.emit('exit', null, signal); return true; });
}
const guards: AgentGuard[] = [];
beforeEach(async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const original = await vi.importActual<typeof childProcess>('node:child_process');
    vi.mocked(childProcess.spawn).mockReset().mockImplementation(original.spawn);
});
afterEach(async () => {
    const closing = Promise.all(guards.splice(0).map(guard => guard.close()));
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1000);
    await closing;
    vi.useRealTimers(); vi.unstubAllEnvs();
});
function spawnFake() {
    const children: Child[] = [];
    const spawn = vi.mocked(childProcess.spawn).mockImplementation((() => {
        const child = new Child(); children.push(child); return child;
    }) as unknown as typeof childProcess.spawn);
    return { spawn, children };
}
function tokenOf(decision: Awaited<ReturnType<AgentGuard['inspect']>>): string {
    if (decision.action !== 'respond') throw new Error('expected decoy response');
    return /^ADMIN_API_TOKEN=(.+)$/m.exec(decision.response.body)![1]!;
}

it.each([';ua-command;path-command', '`ua-command``path-command`', '$(ua-command)$(path-command)', '\nua-command\r\npath-command\n'])('keeps request syntax out of argv and the entire child environment: %j', async attack => {
    const { spawn, children } = spawnFake(), seen: AgentGuardEvent[] = [];
    vi.stubEnv('AG_PARENT_PRIVATE', 'parent-environment-private');
    vi.stubEnv('AG_ALERT_WEBHOOK_SECRET', 'webhook-private-value');
    const run: [string, ...string[]] = ['/opt/operator/hook', 'configured;literal', '`configured`', '$(configured)', 'configured\nargument'];
    const settings = config({ hooks: [{ on: 'canary_replay', run }], onEvent: event => seen.push(event) });
    const guard = createAgentGuard(settings); guards.push(guard);
    const token = tokenOf(await guard.inspect(request('/.env')));
    const path = '/request-path-' + attack, ua = 'request-ua-' + attack;
    const replay = await guard.inspect(request(path, { method: 'POST', headers: { 'user-agent': ua, authorization: token, 'x-private-header': 'header-private-value', cookie: 'cookie-private-value' },
        query: { 'private-query': 'query-private-value' }, body: { private: 'body-private-value' } }));
    expect(replay.action).toBe('pass'); expect(replay.events[0]!.event).toBe('canary_replay');
    expect(spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    const call = spawn.mock.calls[0]!;
    expect(call[0]).toBe(run[0]); expect(call[1]).toEqual(run.slice(1));
    const options = call[2] as childProcess.SpawnOptions;
    expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: 'ignore' });
    const env = options.env!;
    expect(Object.keys(env).sort()).toEqual(['AG_CANARY_ID', 'AG_CLIENT_KEY_HASH', 'AG_EVENT_TYPE', 'AG_INCIDENT_ID', 'AG_PLACEMENT']);
    expect(env.AG_CLIENT_KEY_HASH).toBe(createHash('sha256').update(replay.events[0]!.req.client_key).digest('hex'));
    expect(env.AG_CLIENT_KEY_HASH).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(env);
    // Do not include dynamic tokens in failure messages from the matcher.
    const prohibited = [attack, ua, path, 'ua-command', 'path-command', 'header-private-value', 'cookie-private-value', 'private-query', 'query-private-value', 'body-private-value',
        token, replay.events[0]!.req.client_key, settings.canary.secret, settings.projectSeed, 'parent-environment-private', 'webhook-private-value', '192.0.2.1'];
    expect(prohibited.some(value => serialized.includes(value))).toBe(false);
    expect(env).not.toHaveProperty('PATH'); expect(env).not.toHaveProperty('HOME');
    children[0]!.emit('exit', 0, null);
    const result = seen.find(event => event.event === 'hook_result')!;
    expect(result.hook).toEqual({ on: 'canary_replay', status: 'success' });
    expect(JSON.stringify(result).includes(token)).toBe(false);
    expect(guard.prometheusText()).toContain('agent_guard_events_total{type="hook_result"} 1\n');
});

it('keeps disabled inspect decisions, alert deliveries, logs and counters equivalent', async () => {
    const { spawn } = spawnFake();
    const collected: Array<{ responses: unknown[]; logs: AgentGuardEvent[]; alerts: string[]; metrics: unknown; prometheus: string }> = [];
    for (const hooks of [undefined, []]) {
        const logs: AgentGuardEvent[] = [], alerts: string[] = [];
        const guard = createAgentGuard(config({ ...webConfig(), hooks, log: { sink: event => logs.push(event), level: 'debug' },
            alerts: { adapters: [{ name: 'injected', send: async payload => { alerts.push(payload.event.event); return { ok: true }; } }] } })); guards.push(guard);
        const responses: unknown[] = [];
        for (const path of ['/ordinary', '/robots.txt', '/.env', '/wp-admin']) {
            const result = await guard.inspect(request(path));
            responses.push({ action: result.action, ...(result.action === 'respond' ? { response: { ...result.response, body: createHash('sha256').update(result.response.body).digest('hex') } } : {}) });
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(logs.some(event => event.event === 'hook_result')).toBe(false);
        expect(guard.prometheusText()).not.toContain('type="hook_result"');
        const { inspect_ns_p50: _p50, inspect_ns_p99: _p99, ...metrics } = guard.metrics();
        const prometheus = guard.prometheusText().split('\n').filter(line => !line.startsWith('agent_guard_inspect_latency_seconds{')).join('\n');
        // Event IDs and process-local incident IDs intentionally differ between guards.
        const normalized = JSON.parse(JSON.stringify(logs, (key, value: unknown) => ['event_id', 'id'].includes(key) ? '[id]' : value)) as AgentGuardEvent[];
        collected.push({ responses, logs: normalized, alerts, metrics, prometheus });
    }
    expect(collected[1]).toEqual(collected[0]);
    expect(spawn).not.toHaveBeenCalled();
});

it('fires incident_high once per correlated incident independently of repeated canary replays or alert acceptance', async () => {
    const { spawn, children } = spawnFake();
    const guard = createAgentGuard(config({ hooks: [{ on: 'incident_high', run: ['/opt/operator/high'] }, { on: 'canary_replay', run: ['/opt/operator/replay'] }],
        incident: { windowMs: 100 }, alerts: { adapters: [], minSeverity: 'critical' } })); guards.push(guard);
    await guard.inspect(request('/robots.txt'));
    const token = tokenOf(await guard.inspect(request('/.env')));
    await guard.inspect(request('/api/internal/admin/users')); await vi.advanceTimersByTimeAsync(0);
    expect(spawn).not.toHaveBeenCalled();
    const incidents: string[] = [];
    for (let i = 0; i < 3; i++) {
        const decision = await guard.inspect(request('/normal', { headers: { 'user-agent': 'curl/8.0', authorization: token } }));
        incidents.push(decision.events[0]!.incident!.id);
        await vi.advanceTimersByTimeAsync(0);
        children.forEach(child => child.emit('exit', 0, null));
    }
    expect(new Set(incidents).size).toBe(1);
    expect(spawn.mock.calls.map(call => call[0])).toEqual(['/opt/operator/high', '/opt/operator/replay', '/opt/operator/replay', '/opt/operator/replay']);
    await guard.inspect(request('/.env')); await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(100);
    const next = await guard.inspect(request('/normal', { headers: { 'user-agent': 'curl/8.0', authorization: token } }));
    expect(next.events[0]!.incident!.id).not.toBe(incidents[0]); await vi.advanceTimersByTimeAsync(0);
    expect(spawn.mock.calls.filter(call => call[0] === '/opt/operator/high')).toHaveLength(2);
    children.forEach(child => child.emit('exit', 0, null));
});

it('never retries incident_high on later events after its first attempt fails', async () => {
    const { spawn, children } = spawnFake();
    const seen: AgentGuardEvent[] = [];
    const guard = createAgentGuard(config({ hooks: [{ on: 'incident_high', run: ['/opt/operator/missing'] }], onEvent: event => seen.push(event) })); guards.push(guard);
    const token = tokenOf(await guard.inspect(request('/.env')));
    for (let i = 0; i < 3; i++) {
        await guard.inspect(request('/normal', { headers: { authorization: token } }));
        await vi.advanceTimersByTimeAsync(0);
        if (i === 0) children[0]!.emit('error', new Error('missing executable'));
    }
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(seen.filter(event => event.event === 'hook_result').map(event => event.hook?.reason)).toEqual(['spawn_error']);
});

it.each(['detect', 'trap'] as const)('preserves normal decoy and canary decisions on spawn failure in %s mode', async mode => {
    const spawn = vi.mocked(childProcess.spawn).mockImplementation(() => { throw new Error('private native failure'); });
    const seen: AgentGuardEvent[] = [];
    const guard = createAgentGuard(config({ mode, hooks: [{ on: 'canary_replay', run: ['/opt/operator/missing'] }], onEvent: event => seen.push(event) })); guards.push(guard);
    const decoy = await guard.inspect(request('/.env')); const token = tokenOf(decoy);
    const replay = await guard.inspect(request('/.env', { headers: { authorization: token } }));
    expect(replay.action).toBe('respond');
    if (replay.action !== 'respond' || decoy.action !== 'respond') throw new Error('expected decoy');
    expect(JSON.stringify(replay.response) === JSON.stringify(decoy.response)).toBe(true);
    expect(replay.events.map(event => event.event)).toEqual(['canary_replay', 'decoy_hit']);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(seen.filter(event => event.event === 'hook_result').map(event => event.hook)).toEqual([{ on: 'canary_replay', status: 'failure', reason: 'spawn_error' }]);
});

it('runs a real absolute executable with literal argv and records success', async () => {
    vi.useRealTimers();
    let complete!: (event: AgentGuardEvent) => void;
    const result = new Promise<AgentGuardEvent>(resolve => { complete = resolve; });
    const runner = new HookRunner([{ on: 'canary_replay', run: [process.execPath, '-e', 'process.exit(0)'] }], complete);
    try {
        runner.dispatch({ v: 1, ts: new Date().toISOString(), event_id: '01K00000000000000000000000', event: 'canary_replay', severity: 'critical', project: 'test', env: 'test', req: { method: 'GET', path: '', client_key: 'key' } });
        expect((await result).hook).toEqual({ on: 'canary_replay', status: 'success' });
    } finally { await runner.close(); }
    vi.useFakeTimers();
});

it('keeps Web inspection hook-free even when shared configuration contains hooks', async () => {
    const { spawn } = spawnFake(), seen: AgentGuardEvent[] = [];
    const guard = createWebGuard(webConfig({ store: memoryStore(), hooks: [{ on: 'canary_replay', run: ['/opt/operator/hook'] }], onEvent: event => seen.push(event) }));
    try {
        const replay = await guard.inspect(request('/ordinary', { headers: { authorization: replayToken } }));
        expect(replay.action).toBe('pass'); expect(replay.events[0]!.event).toBe('canary_replay');
        await vi.advanceTimersByTimeAsync(10000);
        expect(spawn).not.toHaveBeenCalled(); expect(seen.some(event => event.event === 'hook_result')).toBe(false);
        expect(guard.prometheusText()).not.toContain('type="hook_result"');
    } finally { await guard.close(); }
});

it('records a real missing-executable error without affecting the completed inspect response', async () => {
    vi.useRealTimers();
    let complete!: (event: AgentGuardEvent) => void;
    const result = new Promise<AgentGuardEvent>(resolve => { complete = resolve; });
    const guard = createAgentGuard(config({ hooks: [{ on: 'canary_replay', run: ['/agent-guard-unit-missing/executable'] }], onEvent: event => { if (event.event === 'hook_result') complete(event); } }));
    try {
        const token = tokenOf(await guard.inspect(request('/.env')));
        const replay = await guard.inspect(request('/ordinary', { headers: { authorization: token } }));
        expect(replay.action).toBe('pass'); expect(replay.events[0]!.event).toBe('canary_replay');
        expect((await result).hook).toEqual({ on: 'canary_replay', status: 'failure', reason: 'spawn_error' });
    } finally { await guard.close(); }
    vi.useFakeTimers();
});
