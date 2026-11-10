import { describe, it, expect } from 'vitest';
import { startMcpDemo } from '../../examples/mcp-decoy/server.js';
import { mcpDecoyTools, webhookAdapter, type AgentGuardEvent, type AgentGuardConfig } from '../../src/index.js';
import { config, verifiedResolver, spoofResolver, receiver } from '../helpers.js';

async function using(fn: (url: string, events: AgentGuardEvent[], close: () => Promise<void>) => Promise<void>, overrides: Partial<AgentGuardConfig> = {}) {
    const events: AgentGuardEvent[] = [];
    const demo = await startMcpDemo(config({ ...overrides, onEvent: event => events.push(event) }));
    try { await fn(demo.url, events, () => demo.guard!.close()); } finally { await demo.close(); }
}
async function rpc(url: string, method: string, params?: unknown, ua = 'curl/8.0') {
    return fetch(url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ua }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}
describe('minimal MCP over HTTP decoy', () => {
    it('initializes and lists the neutral decoy without alerting; all responses are noindex', async () => {
        await using(async (url, events) => {
            const init = await (await rpc(url, 'initialize', {})).json();
            expect(init.result.capabilities).toEqual({ tools: {} });
            const response = await rpc(url, 'tools/list');
            expect(response.headers.get('x-robots-tag')).toContain('noindex');
            expect(response.headers.get('cache-control')).toBe('no-store');
            expect((await response.json()).result.tools).toContainEqual(mcpDecoyTools[0]);
            expect(events).toEqual([]);
        });
    });
    it('executes a harmless real tool without an alert', async () => {
        await using(async (url, events) => {
            expect(await (await rpc(url, 'tools/call', { name: 'echo', arguments: { text: 'hello' } })).json()).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'hello' }] } });
            expect(events).toEqual([]);
        });
    });
    it('decoy call emits an MCP decoy_hit through the signed alert pipeline and returns only permission error', async () => {
        const r = await receiver();
        try {
            await using(async (url, events, close) => {
                const response = await rpc(url, 'tools/call', { name: mcpDecoyTools[0]!.name, arguments: {} });
                expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32003, message: 'Permission denied' } });
                expect(response.headers.get('x-robots-tag')).toContain('noindex');
                await close();
                expect(events.find(event => event.event === 'decoy_hit')).toMatchObject({ severity: 'medium', req: { path: '/mcp', method: 'POST' }, decoy: { id: 'MCP', status: 200 } });
                expect(r.deliveries).toHaveLength(1);
                expect(r.deliveries[0]?.valid).toBe(true);
            }, { alerts: { adapters: [webhookAdapter({ url: r.url, secret: 'webhook-test-secret' })] } });
        } finally { await r.close(); }
    });
    it('normal canary replay in MCP arguments alerts once and still executes the real tool', async () => {
        await using(async (url, events) => {
            const env = await (await fetch(url + '/.env')).text();
            const token = /ADMIN_API_TOKEN=(\S+)/.exec(env)![1]!;
            const reply = await (await rpc(url, 'tools/call', { name: 'echo', arguments: { text: token } })).json();
            expect(reply.result.content[0].text).toBe(token);
            expect(events.filter(event => event.event === 'canary_replay')).toHaveLength(1);
            expect(events.find(event => event.event === 'canary_replay')?.canary).toMatchObject({ found_in: 'body', field: 'params.arguments.text', placement: 'D1:/.env#ADMIN_API_TOKEN' });
        });
    });
    it('verified Googlebot never sees tool discovery or enters the decoy', async () => {
        await using(async (url, events) => {
            for (const method of ['initialize', 'tools/list', 'tools/call']) {
                const response = await rpc(url, method, { name: mcpDecoyTools[0]!.name }, 'Googlebot');
                expect(response.status).toBe(404);
                expect(await response.text()).toBe('Not Found\n');
            }
            expect(events.filter(event => event.event === 'crawler_bypass')).toHaveLength(3);
            expect(events.some(event => event.event === 'decoy_hit')).toBe(false);
        }, { crawler: { resolver: verifiedResolver } });
    });
    it('spoofed crawler calls still alert and allowlisted clients still receive permission errors', async () => {
        for (const allowlist of [undefined, { ips: ['127.0.0.1'] }]) {
            await using(async (url, events) => {
                expect((await (await rpc(url, 'tools/call', { name: mcpDecoyTools[0]!.name }, 'Googlebot')).json()).error.code).toBe(-32003);
                expect(events.some(event => event.event === 'decoy_hit')).toBe(!allowlist);
            }, { crawler: { resolver: spoofResolver }, allowlist });
        }
    });
    it('malformed JSON-RPC, unknown methods/tools and notifications do not throw or alert', async () => {
        await using(async (url, events) => {
            for (const body of ['{', 'null', '[]', '{}', '{"jsonrpc":"1.0","method":"tools/list"}', '{"jsonrpc":"2.0","id":{},"method":"tools/list"}']) {
                const response = await fetch(url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
                expect((await response.json()).error.code).toBe(body === '{' ? -32700 : -32600);
            }
            expect((await (await rpc(url, 'unknown')).json()).error.code).toBe(-32601);
            expect((await (await rpc(url, 'tools/call', { name: 'missing' })).json()).error.code).toBe(-32602);
            expect((await (await rpc(url, 'tools/call', { name: 'echo' })).json()).error.code).toBe(-32602);
            const notification = await fetch(url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
            expect(notification.status).toBe(204);
            expect(events).toEqual([]);
        });
    });
});
