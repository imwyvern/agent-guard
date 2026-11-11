import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentGuard } from '../../src/index.js';
import { Incidents } from '../../src/core/incidents.js';
import { Metrics } from '../../src/metrics.js';
import { SecondsSummary } from '../../src/metrics/prometheus-core.js';
import { config, event, request } from '../helpers.js';

afterEach(() => vi.useRealTimers());

it('adds first touch and dwell to inspect correlation without changing the first observation', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const guard = createAgentGuard(config());
    try {
        expect((await guard.inspect(request('/.env'))).events[0]?.incident).toBeUndefined();
        vi.setSystemTime(1500);
        const correlated = (await guard.inspect(request('/.env'))).events[0]!.incident!;
        expect(correlated).toMatchObject({ first_touch_at: new Date(1000).toISOString(), dwell_ms: 500 });
        expect(correlated.id).toBeTruthy();
        vi.setSystemTime(0);
        expect((await guard.inspect(request('/.env'))).events[0]?.incident).toMatchObject({ id: correlated.id, dwell_ms: 0 });
    } finally { await guard.close(); }
});

it('clamps injected-clock rollback and retains the fixed first-touch window', () => {
    let now = 1000;
    const incidents = new Incidents(1000, () => now, 2);
    incidents.observe('a', 'robots');
    now = 999;
    const incident = incidents.observe('a', 'D1', true)!;
    expect(incident).toMatchObject({ dwell_ms: 0, first_touch_at: new Date(1000).toISOString(), last_seen: new Date(1000).toISOString() });
    now = 1999;
    expect(incidents.current('a')?.dwell_ms).toBe(999);
    now = 2000;
    expect(incidents.current('a')).toBeUndefined();
    expect(incidents.observe('a', 'D2')).toBeUndefined();
});

it('records the first successful alert even when it precedes public correlation, once across adapters', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const seen: ReturnType<typeof event>[] = [];
    const guard = createAgentGuard(config({ onEvent: e => seen.push(e), alerts: { adapters: [
        { name: 'one', send: async () => ({ ok: true }) },
        { name: 'two', send: async () => ({ ok: true }) },
    ] } }));
    try {
        await guard.inspect(request('/.env'));
        await vi.advanceTimersByTimeAsync(0);
        expect(seen.filter(e => e.event === 'alert_sent')).toHaveLength(2);
        vi.setSystemTime(2000);
        const incident = (await guard.inspect(request('/.env'))).events[0]!.incident!;
        expect(incident).toMatchObject({ first_touch_at: new Date(1000).toISOString(), alerted_at: new Date(1000).toISOString(), dwell_ms: 1000 });
        expect(guard.prometheusText()).toContain('agent_guard_time_to_alert_seconds_count 1\n');
        expect(guard.prometheusText()).toContain('agent_guard_time_to_alert_seconds_sum 0\n');
        expect(guard.prometheusText()).toContain('agent_guard_incident_dwell_seconds_count 3\n');
    } finally { await guard.close(); }
});

it('measures successful delivery completion and does not count a failed channel as first alert', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const guard = createAgentGuard(config({ alerts: { adapters: [
        { name: 'fail', send: async () => ({ ok: false, status: 400 }) },
        { name: 'success', send: async () => { await new Promise(resolve => setTimeout(resolve, 500)); return { ok: true }; } },
    ] } }));
    try {
        await guard.inspect(request('/robots.txt'));
        await guard.inspect(request('/.env'));
        await vi.advanceTimersByTimeAsync(500);
        const incident = (await guard.inspect(request('/.env'))).events[0]!.incident!;
        expect(incident.alerted_at).toBe(new Date(1500).toISOString());
        expect(guard.prometheusText()).toContain('agent_guard_time_to_alert_seconds_sum 0.5\n');
    } finally { await guard.close(); }
});

it('ignores stale delivery results after an incident slot is reused', () => {
    let now = 100;
    const incidents = new Incidents(1000, () => now, 1);
    const old = incidents.observe('key', 'canary_replay')!;
    now = 1100;
    const fresh = incidents.observe('key', 'canary_replay')!;
    expect(incidents.alert(event({ ts: new Date(now).toISOString(), req: { method: 'GET', path: '/', client_key: 'key' }, incident: old }))).toBeUndefined();
    expect(incidents.current('key')?.alerted_at).toBeUndefined();
    expect(fresh.id).not.toBe(old.id);
});

it('exports bounded rolling summaries with lifetime counts and no request labels', () => {
    const metrics = new Metrics();
    expect(metrics.prometheusText(0, 0)).not.toContain('agent_guard_incident_dwell_seconds');
    for (const ms of [0, 100, 500, 60_000, 1_800_000]) metrics.timeToAlert(ms);
    const text = metrics.prometheusText(0, 0);
    expect(text).toContain('# TYPE agent_guard_time_to_alert_seconds summary');
    expect(text).toContain('agent_guard_time_to_alert_seconds{quantile="0.5"} 0.5\n');
    expect(text).toContain('agent_guard_time_to_alert_seconds{quantile="0.99"} 1800\n');
    expect(text).toContain('agent_guard_time_to_alert_seconds_count 5\n');
    expect(text).not.toMatch(/path=|ua=|ip=|client_key=/);
    const summary = new SecondsSummary();
    for (let i = 0; i < 4096; i++) summary.observe(i * 1000);
    summary.observe(-1); summary.observe(NaN);
    expect(summary.text('test_seconds', 'Test seconds.')).toContain('test_seconds_count 4096');
    expect(summary.text('test_seconds', 'Test seconds.')).toContain('test_seconds{quantile="0.5"} 3072');
});

it('validates optional incident timeline fields and appended lifecycle types without relaxing v1', async () => {
    const { $schema: _draft, ...body } = JSON.parse(readFileSync(new URL('../../schema/event.v1.json', import.meta.url), 'utf8'));
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
    app.post('/', { schema: { body } }, async () => ({ ok: true }));
    const ts = new Date(0).toISOString();
    const incident = { id: 'one', sequence: ['D1'], first_seen: ts, last_seen: ts, confidence: 'low' as const };
    try {
        for (const type of ['incident_ack', 'incident_escalated', 'incident_reminder'] as const) {
            for (const metadata of [incident, { ...incident, first_touch_at: ts, alerted_at: ts, dwell_ms: 0 }])
                expect((await app.inject({ method: 'POST', url: '/', payload: event({ event: type, incident: metadata }) })).statusCode).toBe(200);
        }
        for (const extra of [{ dwell_ms: -1 }, { dwell_ms: 0.5 }, { dwell_ms: '1' }, { dwell_ms: null }, { first_touch_at: 'invalid' }, { alerted_at: 'invalid' }, { unknown: 1 }])
            expect((await app.inject({ method: 'POST', url: '/', payload: { ...event(), incident: { ...incident, ...extra } } })).statusCode).toBe(400);
        for (const field of ['id', 'sequence', 'first_seen', 'last_seen', 'confidence']) {
            const incomplete: Record<string, unknown> = { ...incident }; delete incomplete[field];
            expect((await app.inject({ method: 'POST', url: '/', payload: { ...event(), incident: incomplete } })).statusCode).toBe(400);
        }
    } finally { await app.close(); }
});
