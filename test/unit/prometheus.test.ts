import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createAgentGuard, prometheusHandler } from '../../src/index.js';
import { listenLocal } from '../../examples/shared/loopback.js';
import { config, request, verifiedResolver } from '../helpers.js';

function parse(text: string) {
    const help = new Map<string, string>(), types = new Map<string, string>(), samples = new Map<string, number>();
    expect(text.endsWith('\n')).toBe(true);
    for (const line of text.trimEnd().split('\n')) {
        if (line.startsWith('# HELP ')) {
            const match = /^# HELP ([a-z_]+) (.+)$/.exec(line);
            expect(match).not.toBeNull();
            expect(help.has(match![1]!)).toBe(false);
            help.set(match![1]!, match![2]!);
        }
        else if (line.startsWith('# TYPE ')) {
            const match = /^# TYPE ([a-z_]+) (counter|gauge|summary|histogram|untyped)$/.exec(line);
            expect(match).not.toBeNull();
            expect(types.has(match![1]!)).toBe(false);
            types.set(match![1]!, match![2]!);
        }
        else {
            const match = /^([a-z_]+)(\{[a-z_]+="[^"\\\n]*"(?:,[a-z_]+="[^"\\\n]*")*\})? (\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/.exec(line);
            expect(match).not.toBeNull();
            expect(help.has(match![1]!)).toBe(true);
            expect(types.has(match![1]!)).toBe(true);
            const key = match![1]! + (match![2] ?? '');
            expect(samples.has(key)).toBe(false);
            expect(Number.isFinite(Number(match![3]))).toBe(true);
            samples.set(key, Number(match![3]));
        }
    }
    expect([...help.keys()]).toEqual([...types.keys()]);
    return { help, types, samples };
}

it('exports documented Prometheus 0.0.4 counters and gauges before any requests', async () => {
    const guard = createAgentGuard(config());
    try {
        const { help, types, samples } = parse(guard.prometheusText());
        for (const name of ['requests_inspected', 'events', 'alerts_sent', 'alerts_failed'])
            expect(types.get(`agent_guard_${name}_total`)).toBe('counter');
        for (const name of ['client_state_size', 'timing_state_size', 'trap_enabled', 'trap_blocked', 'trap_delayed', 'trap_maze_active']) {
            expect(types.get(`agent_guard_${name}`)).toBe('gauge');
            expect(samples.get(`agent_guard_${name}`)).toBe(0);
        }
        expect(help.get('agent_guard_inspect_latency_seconds')).toContain('seconds');
        expect(samples.get('agent_guard_inspect_latency_seconds{quantile="0.5"}')).toBe(0);
        expect(samples.get('agent_guard_inspect_latency_seconds{quantile="0.99"}')).toBe(0);
        expect([...samples.values()].every(value => value === 0)).toBe(true);
    } finally { await guard.close(); }
});

it('counts inspected requests and every event type without exporting paths or client labels', async () => {
    const guard = createAgentGuard(config({ project: '/private-project', env: '/private-env', crawler: { resolver: verifiedResolver } }));
    try {
        const before = parse(guard.prometheusText()).samples;
        await guard.inspect(request('/ordinary'));
        const env = await guard.inspect(request('/.env'));
        if (env.action !== 'respond') throw new Error('expected decoy');
        const token = /^ADMIN_API_TOKEN=(.+)$/m.exec(env.response.body)![1]!;
        await guard.inspect(request('/normal', { headers: { 'user-agent': 'curl/8.0', authorization: token } }));
        await guard.inspect(request('/api/internal/admin/users'));
        await guard.inspect(request('/wp-admin'));
        await guard.inspect(request('/llms.txt'));
        await guard.inspect(request('/.env', { headers: { 'user-agent': 'Googlebot' }, ip: '66.249.66.1' }));
        const text = guard.prometheusText(), { samples } = parse(text), snapshot = guard.metrics();
        expect(samples.get('agent_guard_requests_inspected_total')! - before.get('agent_guard_requests_inspected_total')!).toBe(7);
        expect(samples.get('agent_guard_events_total{type="decoy_hit"}')).toBe(2);
        for (const type of ['canary_replay', 'probe', 'ai_discovery', 'crawler_bypass'])
            expect(samples.get(`agent_guard_events_total{type="${type}"}`)).toBe(1);
        expect(samples.get('agent_guard_client_state_size')).toBe(2);
        expect(samples.get('agent_guard_timing_state_size')).toBe(2);
        expect(samples.get('agent_guard_inspect_latency_seconds{quantile="0.5"}')).toBe(snapshot.inspect_ns_p50 / 1e9);
        expect(samples.get('agent_guard_inspect_latency_seconds{quantile="0.99"}')).toBe(snapshot.inspect_ns_p99 / 1e9);
        for (const value of ['/.env', '/api/internal', '/wp-admin', '/private-project', '/private-env', token, '192.0.2.1', 'client_key', env.events[0]!.req.client_key])
            expect(text).not.toContain(value);
        for (const line of text.split('\n').filter(line => line.includes('{'))) {
            const labels = line.slice(line.indexOf('{') + 1, line.indexOf('}'));
            expect(labels).toMatch(/^(type="(?:decoy_hit|canary_replay|probe|ai_discovery|crawler_bypass|alert_sent|alert_failed)"|quantile="0\.(?:5|99)")$/);
        }
    } finally { await guard.close(); }
});

it('exports successful and failed alert delivery counters and their event counts', async () => {
    const guard = createAgentGuard(config({ alerts: { adapters: [
        { name: 'sent', send: async () => ({ ok: true, status: 200 }) },
        { name: 'failed', send: async () => ({ ok: false, status: 400 }) },
    ] } }));
    try {
        await guard.inspect(request('/.env'));
        await guard.close();
        const { samples } = parse(guard.prometheusText());
        expect(samples.get('agent_guard_alerts_sent_total')).toBe(1);
        expect(samples.get('agent_guard_alerts_failed_total')).toBe(1);
        expect(samples.get('agent_guard_events_total{type="alert_sent"}')).toBe(1);
        expect(samples.get('agent_guard_events_total{type="alert_failed"}')).toBe(1);
    } finally { await guard.close(); }
});

it('serves the same text over loopback with the Prometheus content type', async () => {
    const guard = createAgentGuard(config());
    const server = await listenLocal(createServer(prometheusHandler(guard)));
    try {
        await guard.inspect(request('/.env'));
        const expected = guard.prometheusText(), count = guard.metrics().requests_inspected;
        const response = await fetch(server.url);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
        expect(await response.text()).toBe(expected);
        expect(guard.metrics().requests_inspected).toBe(count);
    } finally { await server.close(); await guard.close(); }
});

it.each(['POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'])('rejects %s with 405 and allows only GET', async method => {
    const guard = createAgentGuard(config());
    const exporter = vi.spyOn(guard, 'prometheusText');
    const server = await listenLocal(createServer(prometheusHandler(guard)));
    try {
        const response = await fetch(server.url, { method });
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('GET');
        await response.text();
        expect(exporter).not.toHaveBeenCalled();
    } finally { await server.close(); await guard.close(); }
});

it('isolates exporter errors and returns a generic 500 response', async () => {
    const guard = createAgentGuard(config());
    vi.spyOn(guard, 'prometheusText').mockImplementation(() => { throw new Error('private failure'); });
    const server = await listenLocal(createServer(prometheusHandler(guard)));
    try {
        const response = await fetch(server.url);
        expect(response.status).toBe(500);
        expect(await response.text()).toBe('Internal Server Error\n');
    } finally { await server.close(); await guard.close(); }
});

it('isolates response failures from the host request listener', async () => {
    const guard = createAgentGuard(config());
    try {
        const req = { method: 'GET' } as IncomingMessage;
        const res = { writeHead() { throw new Error('closed response'); }, end() { throw new Error('closed response'); } } as unknown as ServerResponse;
        expect(() => prometheusHandler(guard)(req, res)).not.toThrow();
    } finally { await guard.close(); }
});
