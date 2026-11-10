import { createServer, type ServerResponse } from 'node:http';
import { listenLocal } from '../examples/shared/loopback.js';
import { demoConfig } from '../examples/shared/site.js';
import { verifyWebhookSignature, type AGRequest, type AgentGuardConfig, type AgentGuardEvent, type AlertPayload } from '../src/index.js';
export function config(overrides: Partial<AgentGuardConfig> = {}): AgentGuardConfig { return demoConfig({ log: { sink: () => { }, level: 'debug' }, alerts: { adapters: [] }, lures: { robots: 'off', htmlComment: false }, ...overrides }); }
export function request(path = '/', overrides: Partial<AGRequest> = {}): AGRequest { return { method: 'GET', path, query: {}, headers: { 'user-agent': 'curl/8.0' }, ip: '192.0.2.1', ...overrides }; }
export const verifiedResolver = { reverse: async () => ['crawl-66-249-66-1.googlebot.com'], resolve: async () => ['127.0.0.1', '66.249.66.1'] };
export const spoofResolver = { reverse: async () => ['googlebot.com.attacker.invalid'], resolve: async () => [] };
export const decoyPaths = ['/.env', '/api/internal/admin/users', '/internal/ops-notes', '/api/internal/openapi.json', '/api/internal/auth/login'];
export async function receiver(statuses: number[] = [200], hang = false) {
    const pending = new Set<ServerResponse>();
    let failed = false;
    const fail = (res: ServerResponse) => { res.writeHead(503); res.end('receiver unavailable'); };
    const deliveries: Array<{
        payload: AlertPayload;
        time: number;
        valid: boolean;
    }> = [];
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            deliveries.push({ payload: JSON.parse(body) as AlertPayload, time: performance.now(), valid: verifyWebhookSignature({ body, timestamp: String(req.headers['x-agentguard-timestamp']), signature: String(req.headers['x-agentguard-signature']), secret: 'webhook-test-secret' }) });
            if (failed) {
                fail(res);
            }
            else if (!hang) {
                res.writeHead(statuses.shift() ?? 200);
                res.end('ok');
            }
            else {
                pending.add(res);
                res.once('close', () => pending.delete(res));
            }
        });
    });
    const local = await listenLocal(server);
    return { deliveries, url: local.url, close: local.close, failPending() {
        failed = true;
        for (const res of pending) fail(res);
        pending.clear();
    } };
}
export function event(overrides: Partial<AgentGuardEvent> = {}): AgentGuardEvent { return { v: 1, ts: new Date().toISOString(), event_id: '01K00000000000000000000000', event: 'decoy_hit', severity: 'high', project: 'test', env: 'test', req: { method: 'GET', path: '/.env', client_key: 'key', ip: '192.0.2.1' }, decoy: { id: 'D1', status: 200 }, ...overrides }; }
