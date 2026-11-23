import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { AgentGuardConfigError } from '../../src/config.js';
import { createAgentGuard } from '../../src/core/inspect.js';
import { createWebGuard, memoryStore } from '../../src/web/index.js';
import type { WebBotAuthOptions } from '../../src/crawler/web-bot-auth-types.js';
import { agent, jsonResponse, testKey, trustedOptions } from '../fixtures/web-bot-auth.js';
import { event } from '../helpers.js';
import { webConfig } from '../helpers/web.js';

const fetcher = async () => jsonResponse({ keys: [] });
const discovery = { fetcher, allowHosts: ['agent.test'] };
const invalid: Array<[string, unknown]> = [
    ['object', null], ['object', []], ['object', true], ['enabled', { enabled: 'true' }],
    ['trustedAgents', { trustedAgents: {} }], ['trustedAgents', { trustedAgents: [null] }],
    ...['http://agent.test/jwks', 'https://user@agent.test/jwks', 'https://agent.test:444/jwks', 'https://agent.test/jwks#fragment'].map(url => ['trustedAgents', { trustedAgents: [{ url }] }] as [string, unknown]),
    ['trustedAgents', { trustedAgents: [{ url: agent, keys: { keys: [] } }] }],
    ['trustedAgents', { trustedAgents: [{ url: agent, keys: { keys: [{ kty: 'oct', k: 'inert' }] } }] }],
    ['fetchKeys', { fetchKeys: null }], ['fetchKeys', { fetchKeys: {} }],
    ['fetchKeys', { fetchKeys: { fetcher } }], ['fetchKeys', { fetchKeys: { allowHosts: [] } }],
    ['allowHosts', { fetchKeys: { ...discovery, allowHosts: 'agent.test' } }],
    ...['*.test', 'https://agent.test', 'agent.test/path', 'agent.test:443', 'user@agent.test', 'agent.test?x', 'agent.test#x', '', 42].map(host => ['allowHosts', { fetchKeys: { ...discovery, allowHosts: [host] } }] as [string, unknown]),
    ['cache', { fetchKeys: { ...discovery, cache: {} } }],
    ['clockSkewSeconds', { clockSkewSeconds: -1 }], ['clockSkewSeconds', { clockSkewSeconds: Infinity }],
    ['maxSignatureAgeSeconds', { maxSignatureAgeSeconds: 0 }], ['maxSignatureAgeSeconds', { maxSignatureAgeSeconds: .5 }],
    ['timeoutMs', { fetchKeys: { ...discovery, timeoutMs: 5001 } }],
    ['maxBytes', { fetchKeys: { ...discovery, maxBytes: 262145 } }],
    ['maxTtlSeconds', { fetchKeys: { ...discovery, maxTtlSeconds: 86401 } }],
];

it.each(invalid)('validates webBotAuth.%s in both constructors (%#)', (field, options) => {
    const c = webConfig({ webBotAuth: options as WebBotAuthOptions });
    for (const create of [() => createAgentGuard(c), () => createWebGuard({ ...c, store: memoryStore() })]) {
        expect(create).toThrow(AgentGuardConfigError);
        expect(create).toThrow(field);
    }
});

it('accepts public static keys, exact hosts, empty allowHosts, boundary options and a StateStore', async () => {
    const options = await trustedOptions();
    for (const allowHosts of [[], ['AGENT.test', '[::1]']]) {
        const c = webConfig({ webBotAuth: { ...options, clockSkewSeconds: 0, maxSignatureAgeSeconds: 86400,
            fetchKeys: { fetcher, allowHosts, timeoutMs: 5000, maxBytes: 262144, maxTtlSeconds: 0, cache: memoryStore() } } });
        const node = createAgentGuard(c), web = createWebGuard({ ...c, store: memoryStore() });
        await node.close(); await web.close();
    }
});

it('appends optional signature observation schema without permitting raw signatures', async () => {
    const { $schema: _draft, ...body } = JSON.parse(readFileSync(new URL('../../schema/event.v1.json', import.meta.url), 'utf8'));
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
    app.post('/', { schema: { body } }, async () => ({ ok: true }));
    try {
        for (const web_bot_auth of [
            { agent_url: agent, keyid: (await testKey()).keyid, verified: true, trusted: true },
            { agent_url: agent, keyid: (await testKey()).keyid, verified: true, trusted: false },
            { verified: false, trusted: false, reason: 'expired' },
            { verified: false, trusted: false, reason: 'unsupported' },
        ] as const) expect((await app.inject({ method: 'POST', url: '/', payload: event({ web_bot_auth }) })).statusCode).toBe(200);
        for (const web_bot_auth of [{ verified: true }, { verified: 'true', trusted: true }, { verified: false, trusted: false, reason: 'unknown' }, { verified: true, trusted: true, signature: 'raw' }])
            expect((await app.inject({ method: 'POST', url: '/', payload: { ...event(), web_bot_auth } })).statusCode).toBe(400);
    } finally { await app.close(); }
});
