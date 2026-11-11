import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentGuard } from '../../src/index.js';
import type { AgentGuardEvent } from '../../src/types.js';
import { Escalation } from '../../src/incident/escalation.js';
import { runCLI } from '../../src/cli/commands.js';
import { config, event, request } from '../helpers.js';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const clock = (): void => { vi.useFakeTimers(); vi.setSystemTime(1000); };

it('alerts first once, upgrades once, reminds, then honors a CLI ack from the same log', async () => {
    clock();
    const dir = mkdtempSync(join(tmpdir(), 'ag-escalation-')); dirs.push(dir);
    const path = join(dir, 'events'), send = vi.fn(async () => ({ ok: true })), seen: AgentGuardEvent[] = [];
    const guard = createAgentGuard(config({ log: { file: path, level: 'debug' }, onEvent: e => seen.push(e),
        escalation: { enabled: true, remindAfterMs: 100 }, alerts: { adapters: [{ name: 'injected', send }] } }));
    try {
        await guard.inspect(request('/robots.txt'));
        const decoy = await guard.inspect(request('/.env'));
        if (decoy.action !== 'respond') throw new Error('expected decoy');
        await vi.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenCalledTimes(1);
        await guard.inspect(request('/api/internal/admin/users'));
        await vi.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenCalledTimes(1);
        const token = /^ADMIN_API_TOKEN=(.+)$/m.exec(decoy.response.body)![1]!;
        for (let i = 0; i < 3; i++) await guard.inspect(request('/normal', { headers: { 'user-agent': 'curl/8.0', authorization: token } }));
        await vi.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenCalledTimes(2);
        expect(seen.filter(e => e.event === 'incident_escalated')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(100);
        expect(send).toHaveBeenCalledTimes(3);
        expect(seen.filter(e => e.event === 'incident_reminder')).toHaveLength(1);
        expect(runCLI(['incident', 'ack', decoy.events[0]!.incident!.id, '--log', path], () => {})).toBe(0);
        await vi.advanceTimersByTimeAsync(1000);
        expect(send).toHaveBeenCalledTimes(3);
        expect(guard.prometheusText()).toContain('agent_guard_time_to_alert_seconds_count 1\n');
    } finally { await guard.close(); }
});

it('caps reminders at two by default even without an acknowledgement file', async () => {
    clock(); const send = vi.fn(async () => ({ ok: true }));
    const guard = createAgentGuard(config({ escalation: { enabled: true, remindAfterMs: 10 }, alerts: { adapters: [{ name: 'injected', send }] } }));
    try {
        await guard.inspect(request('/.env'));
        await vi.advanceTimersByTimeAsync(1000);
        expect(send).toHaveBeenCalledTimes(3);
        expect(send.mock.calls.map(call => (call as unknown as [{ event: AgentGuardEvent }])[0].event.event)).toEqual(['decoy_hit', 'incident_reminder', 'incident_reminder']);
    } finally { await guard.close(); }
    expect(vi.getTimerCount()).toBe(0);
});

it('is disabled by default, including when only reminder settings are supplied', async () => {
    clock();
    for (const escalation of [undefined, { remindAfterMs: 10 }, { enabled: false, remindAfterMs: 10 }]) {
        const send = vi.fn(async () => ({ ok: true })), seen: AgentGuardEvent[] = [];
        const guard = createAgentGuard(config({ escalation, onEvent: e => seen.push(e), alerts: { adapters: [{ name: 'injected', send }] } }));
        try {
            await guard.inspect(request('/.env')); await guard.inspect(request('/.env'));
            await vi.advanceTimersByTimeAsync(1000);
            expect(send).toHaveBeenCalledTimes(1);
            expect(seen.some(e => e.event === 'incident_escalated' || e.event === 'incident_reminder')).toBe(false);
        } finally { await guard.close(); }
    }
});

it('records failed escalation delivery and preserves inspect responses and reminder limits', async () => {
    clock(); let succeed = true;
    const send = vi.fn(async () => ({ ok: succeed, status: succeed ? 200 : 400 })), seen: AgentGuardEvent[] = [];
    const guard = createAgentGuard(config({ escalation: { enabled: true, remindAfterMs: 10, maxReminders: 1 }, onEvent: e => seen.push(e), alerts: { adapters: [{ name: 'injected', send }] } }));
    try {
        const decoy = await guard.inspect(request('/.env'));
        if (decoy.action !== 'respond') throw new Error('expected decoy');
        await vi.advanceTimersByTimeAsync(0); succeed = false;
        const token = /^ADMIN_API_TOKEN=(.+)$/m.exec(decoy.response.body)![1]!;
        expect((await guard.inspect(request('/normal', { headers: { 'user-agent': 'curl/8.0', authorization: token } }))).action).toBe('pass');
        await vi.advanceTimersByTimeAsync(1000);
        expect(send).toHaveBeenCalledTimes(3);
        expect(seen.filter(e => e.event === 'alert_failed')).toHaveLength(2);
        expect(seen.filter(e => e.event === 'incident_reminder')).toHaveLength(1);
    } finally { await guard.close(); }
});

it('does not remind before any successful first delivery', async () => {
    clock(); const send = vi.fn(async () => ({ ok: false, status: 400 }));
    const guard = createAgentGuard(config({ escalation: { enabled: true, remindAfterMs: 10 }, alerts: { adapters: [{ name: 'injected', send }] } }));
    try {
        await guard.inspect(request('/.env')); await vi.advanceTimersByTimeAsync(1000);
        expect(send).toHaveBeenCalledTimes(1);
        expect(guard.prometheusText()).not.toContain('agent_guard_time_to_alert_seconds');
    } finally { await guard.close(); }
});

it('caps its LRU, expires by first touch, and clamps reminder dwell on clock rollback', () => {
    let now = 1000;
    const sent: AgentGuardEvent[] = [], emitted: AgentGuardEvent[] = [];
    const coordinator = new Escalation(config({ incident: { windowMs: 500 }, escalation: { enabled: true, remindAfterMs: 10 } }), e => { sent.push(e); return true; }, e => emitted.push(e), () => now, 2);
    const sample = (id: string): AgentGuardEvent => event({ incident: { id, sequence: ['D1'], first_seen: new Date(1000).toISOString(), last_seen: new Date(1000).toISOString(), confidence: 'medium' } });
    for (const id of ['a', 'b', 'c']) { coordinator.observe(sample(id)); coordinator.delivered({ ...sample(id), ts: new Date(0).toISOString() }); }
    expect(coordinator.size).toBe(2);
    now = 900; coordinator.tick();
    expect(emitted).toHaveLength(2);
    expect(emitted.every(e => e.incident?.dwell_ms === 0)).toBe(true);
    expect(emitted.map(e => e.incident?.id)).toEqual(['b', 'c']);
    now = 1500; coordinator.tick();
    expect(coordinator.size).toBe(0);
    expect(sent).toHaveLength(5);
    coordinator.close();
});

it('handles partial acknowledgement appends and bounded polling before sending reminders', async () => {
    clock();
    const dir = mkdtempSync(join(tmpdir(), 'ag-ack-')); dirs.push(dir);
    const path = join(dir, 'events'), send = vi.fn(async () => ({ ok: true }));
    const guard = createAgentGuard(config({ log: { file: path }, escalation: { enabled: true, remindAfterMs: 100 }, alerts: { adapters: [{ name: 'injected', send }] } }));
    try {
        await guard.inspect(request('/robots.txt'));
        const result = await guard.inspect(request('/.env'));
        await vi.advanceTimersByTimeAsync(0);
        // More than one poll's budget of malformed input cannot cause an early reminder.
        appendFileSync(path, 'x'.repeat(300_000) + '\n' + JSON.stringify({ ts: new Date().toISOString(), event: 'incident_ack', incident: { id: result.events[0]!.incident!.id } }));
        await vi.advanceTimersByTimeAsync(100);
        expect(send).toHaveBeenCalledTimes(1);
        appendFileSync(path, '\n'); await vi.advanceTimersByTimeAsync(1000);
        expect(send).toHaveBeenCalledTimes(1);
    } finally { await guard.close(); }
});
