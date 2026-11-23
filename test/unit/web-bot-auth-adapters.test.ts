import { Hono } from 'hono';
import Fastify from 'fastify';
import type { ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { agentGuardNode, toRequest, type ParsedRequest } from '../../src/adapters/node.js';
import { agentGuard as honoGuard } from '../../src/adapters/hono.js';
import { agentGuard as fastifyGuard } from '../../src/adapters/fastify.js';
import { agentGuard as koaGuard } from '../../src/adapters/koa.js';
import { withAgentGuard } from '../../src/adapters/workers.js';
import { agentGuardMiddleware } from '../../src/adapters/next.js';
import { denoHandler } from '../../src/adapters/deno.js';
import { bunHandler } from '../../src/adapters/bun.js';
import { honoWeb } from '../../src/adapters/hono-web.js';
import { createAgentGuard } from '../../src/core/inspect.js';
import { createWebGuard, memoryStore, type WebGuard } from '../../src/web/index.js';
import type { AgentGuardEvent } from '../../src/types.js';
import { agent, now, testKey, trustedOptions } from '../fixtures/web-bot-auth.js';
import { webConfig } from '../helpers/web.js';

// Independently sign every supported URL component, to catch lost query or scheme in adapters.
async function fullSignature(origin = 'https://origin.test'): Promise<Request> {
    const { keyid, privateKey } = await testKey(), url = origin + '/.env?x=1';
    const covered = '"@method" "@authority" "@scheme" "@target-uri" "@path" "@query" "signature-agent";key="sig1"';
    const input = '(' + covered + ');created=' + (now - 100) + ';expires=' + (now + 300) + ';keyid="' + keyid + '";alg="ed25519";tag="web-bot-auth"';
    const parsed = new URL(url), base = '"@method": GET\n"@authority": ' + parsed.host + '\n"@scheme": ' + parsed.protocol.slice(0, -1)
        + '\n"@target-uri": ' + url + '\n"@path": /.env\n"@query": ?x=1\n"signature-agent";key="sig1": "' + agent + '"\n"@signature-params": ' + input;
    const signature = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(base));
    return new Request(url, { headers: { host: parsed.host, 'Signature-Input': 'sig1=' + input,
        'Signature-Agent': 'sig1="' + agent + '"', Signature: 'sig1=:' + Buffer.from(signature).toString('base64') + ':' } });
}
function incoming(req: Request): ParsedRequest {
    const url = new URL(req.url);
    return { url: url.pathname + url.search, method: req.method, headers: Object.fromEntries(req.headers),
        socket: { remoteAddress: '192.0.2.1', encrypted: url.protocol === 'https:' } } as unknown as ParsedRequest;
}
async function options(events: AgentGuardEvent[]) {
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    return webConfig({ webBotAuth: await trustedOptions(), onEvent: event => events.push(event) });
}

it('Node/Express delegation keeps origin URL components and never sends decoy bytes', async () => {
    const events: AgentGuardEvent[] = [], c = await options(events), guard = createAgentGuard(c), signed = await fullSignature();
    try {
        const raw = incoming(signed), writeHead = vi.fn(), end = vi.fn();
        expect(toRequest(raw, c).url).toBe(signed.url);
        expect(toRequest(raw, { ...c, webBotAuth: undefined })).not.toHaveProperty('url');
        await new Promise<void>(resolve => agentGuardNode(guard)(raw, { writeHead, end } as unknown as ServerResponse, resolve));
        expect(writeHead).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled();
        expect(events.map(e => e.event)).toEqual(['crawler_bypass']);
        expect(events[0]?.web_bot_auth).toMatchObject({ verified: true, trusted: true });
    } finally { await guard.close(); }
});

it('the Node Hono adapter preserves the signed URL and delegates to the host', async () => {
    const events: AgentGuardEvent[] = [], c = await options(events), guard = createAgentGuard(c), app = new Hono();
    app.use('*', honoGuard(guard)); app.get('/.env', context => context.text('host'));
    try {
        const response = await app.request(await fullSignature());
        expect(response.status).toBe(200); expect(await response.text()).toBe('host');
        expect(events.map(e => e.event)).toEqual(['crawler_bypass']);
    } finally { await guard.close(); }
});

it('the Fastify adapter preserves the signed URL and delegates to the host', async () => {
    const events: AgentGuardEvent[] = [], c = await options(events), guard = createAgentGuard(c), app = Fastify();
    await app.register(fastifyGuard(guard)); app.get('/.env', async () => 'host');
    try {
        const signed = await fullSignature('http://origin.test');
        const response = await app.inject({ method: 'GET', url: '/.env?x=1', headers: Object.fromEntries(signed.headers) });
        expect(response.statusCode).toBe(200); expect(response.body).toBe('host');
        expect(events.map(e => e.event)).toEqual(['crawler_bypass']);
    } finally { await app.close(); await guard.close(); }
});

it('the Koa adapter preserves the signed URL and delegates to the host', async () => {
    const events: AgentGuardEvent[] = [], c = await options(events), guard = createAgentGuard(c), middleware = koaGuard(guard), next = vi.fn(async () => {});
    try {
        const ctx = { req: incoming(await fullSignature()), request: {} } as Parameters<typeof middleware>[0];
        await middleware(ctx, next);
        expect(next).toHaveBeenCalledTimes(1); expect(events.map(e => e.event)).toEqual(['crawler_bypass']);
    } finally { await guard.close(); }
});

const webAdapters: Array<[string, (guard: WebGuard, request: Request) => Promise<Response | undefined>]> = [
    ['workers', (guard, request) => withAgentGuard(guard, { fetch: () => new Response('host') }).fetch(request, {}, {})],
    ['next', (guard, request) => agentGuardMiddleware(guard)(request)],
    ['deno', (guard, request) => denoHandler(guard, () => new Response('host'))(request)],
    ['bun', (guard, request) => bunHandler(guard, () => new Response('host'))(request)],
    ['honoWeb', async (guard, request) => {
        const ctx = { req: { raw: request }, res: undefined as Response | undefined };
        await honoWeb(guard)(ctx, async () => { ctx.res = new Response('host'); }); return ctx.res;
    }],
];
it.each(webAdapters)('the %s adapter shares Web signature trust and returns no decoy', async (_name, handle) => {
    const events: AgentGuardEvent[] = [], c = await options(events), guard = createWebGuard({ ...c, store: memoryStore() });
    try {
        const response = await handle(guard, await fullSignature());
        expect(response?.status).toBe(404); expect(await response?.text()).toBe('Not Found\n');
        expect(events.map(e => e.event)).toEqual(['crawler_bypass']);
        expect(events[0]?.web_bot_auth).toMatchObject({ verified: true, trusted: true });
    } finally { await guard.close(); }
});
