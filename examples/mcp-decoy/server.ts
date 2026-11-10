import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createAgentGuard, inspectMcpRequest, mcpDecoyTools, type AgentGuardConfig } from '../../src/index.js';
import { agentGuardNode, toRequest, type ParsedRequest } from '../../src/adapters/node.js';
import { decoyHeaders } from '../../src/decoys/headers.js';
import { demoConfig, parseBody, site, type Demo } from '../shared/site.js';
import { listenLocal } from '../shared/loopback.js';

const realTools = [
    { name: 'echo', description: 'Echo text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
    { name: 'get_time', description: 'Current UTC time.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** Local minimal JSON-RPC HTTP example, not a full Streamable HTTP MCP transport. */
export async function startMcpDemo(config: AgentGuardConfig = demoConfig(), port = 0): Promise<Demo> {
    const guard = createAgentGuard(config), middleware = agentGuardNode(guard);
    const server = createServer((req: ParsedRequest, res) => {
        void (async () => {
            const path = new URL(req.url ?? '/', 'http://local.invalid').pathname;
            if (path !== '/mcp' || req.method !== 'POST') {
                req.body = await parseBody(req);
                middleware(req, res, () => site(req, res));
                return;
            }
            for (const [key, value] of Object.entries(decoyHeaders('application/json'))) res.setHeader(key, value);
            let id: string | number | null = null;
            const error = (code: number, message: string): void => { res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })); };
            try { req.body = await parseBody(req); }
            catch { error(-32700, 'Parse error'); return; }
            const message = req.body;
            if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
                (message.params !== undefined && !object(message.params)) ||
                ('id' in message && message.id !== null && typeof message.id !== 'string' && typeof message.id !== 'number')) {
                error(-32600, 'Invalid Request'); return;
            }
            id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
            const params = object(message.params) ? message.params : {};
            const name = message.method === 'tools/call' && typeof params.name === 'string' ? params.name : undefined;
            // Exactly one inspection: no duplicate replay events from wrapping /mcp.
            const decision = await inspectMcpRequest(guard, toRequest(req, config), name);
            if (decision.events.some(event => event.event === 'crawler_bypass')) {
                for (const header of res.getHeaderNames()) res.removeHeader(header);
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not Found\n');
                return;
            }
            if (!('id' in message)) { res.writeHead(204); res.end(); return; }
            if (decision.action === 'respond') { error(-32003, 'Permission denied'); return; }
            let result: unknown;
            if (message.method === 'initialize') {
                result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'agent-guard-local-demo', version: '0.1.0' } };
            } else if (message.method === 'tools/list') {
                result = { tools: [...realTools, ...mcpDecoyTools] };
            } else if (message.method === 'tools/call') {
                // An allowlisted client skips inspection but can never execute a decoy.
                if (mcpDecoyTools.some(tool => tool.name === name)) { error(-32003, 'Permission denied'); return; }
                if (name === 'echo') {
                    if (!object(params.arguments) || typeof params.arguments.text !== 'string') { error(-32602, 'Invalid params'); return; }
                    result = { content: [{ type: 'text', text: params.arguments.text }] };
                } else if (name === 'get_time') {
                    result = { content: [{ type: 'text', text: new Date().toISOString() }] };
                } else { error(-32602, 'Unknown tool'); return; }
            } else { error(-32601, 'Method not found'); return; }
            res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
        })().catch(() => {
            if (!res.headersSent) res.writeHead(400, decoyHeaders('application/json'));
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }));
        });
    });
    const local = await listenLocal(server, port);
    return { server, guard, url: local.url, async close() { await guard.close(); await local.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const demo = await startMcpDemo(demoConfig(), Number(process.env.PORT ?? 3000));
    console.log(`MCP decoy demo: ${demo.url}/mcp`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void demo.close(); });
}
