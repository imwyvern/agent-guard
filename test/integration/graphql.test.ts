import { describe, expect, it } from 'vitest';
import { getIntrospectionQuery } from 'graphql';
import { startGraphqlDemo } from '../../examples/graphql-demo/server.js';
import { graphqlDecoys, webhookAdapter, type AgentGuardConfig, type AgentGuardEvent } from '../../src/index.js';
import { config, receiver, spoofResolver, verifiedResolver } from '../helpers.js';

async function using(fn: (url: string, events: AgentGuardEvent[], close: () => Promise<void>) => Promise<void>, overrides: Partial<AgentGuardConfig> = {}) {
    const events: AgentGuardEvent[] = [];
    const demo = await startGraphqlDemo(config({ ...overrides, onEvent: event => events.push(event) }));
    try { await fn(demo.url, events, () => demo.guard!.close()); } finally { await demo.close(); }
}
async function query(url: string, source: string, options: { ua?: string; variables?: unknown; operationName?: string } = {}) {
    return fetch(url + '/graphql', {
        method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': options.ua ?? 'curl/8.0' },
        body: JSON.stringify({ query: source, variables: options.variables, operationName: options.operationName }),
    });
}

describe('GraphQL HTTP schema and decoy', () => {
    it('serves real introspection including neutral decoy fields and types without an alert', async () => {
        await using(async (url, events) => {
            const response = await query(url, getIntrospectionQuery());
            expect(response.status).toBe(200);
            const result = await response.json();
            expect(result.errors).toBeUndefined();
            for (const decoy of graphqlDecoys()) {
                expect(result.data.__schema.types.find((type: { name: string }) => type.name === 'Query').fields).toContainEqual(expect.objectContaining({ name: decoy.field.name, description: decoy.field.description }));
                expect(result.data.__schema.types).toContainEqual(expect.objectContaining({ name: decoy.type.name, description: decoy.type.description }));
            }
            expect(events).toEqual([]);
        });
    });

    it('executes a real field and its selected operation without an alert', async () => {
        await using(async (url, events) => {
            expect(await (await query(url, '{ hello }')).json()).toEqual({ data: { hello: 'Hello from the local demo.' } });
            const source = 'query Real { greeting: hello } query Other { internalAdminUsers { id } }';
            expect(await (await query(url, source, { operationName: 'Real' })).json()).toEqual({ data: { greeting: 'Hello from the local demo.' } });
            expect(events).toEqual([]);
        });
    });

    it('returns only FORBIDDEN for mixed real/decoy selections and uses the signed alert pipeline', async () => {
        const r = await receiver();
        try {
            await using(async (url, events, close) => {
                const response = await query(url, '{ hello accounts: internalAdminUsers { id } }');
                expect(response.status).toBe(200);
                expect(response.headers.get('x-robots-tag')).toContain('noindex');
                expect(response.headers.get('cache-control')).toBe('no-store');
                expect(await response.json()).toEqual({ errors: [{ message: 'Permission denied', extensions: { code: 'FORBIDDEN' } }] });
                await close();
                expect(events.find(event => event.event === 'decoy_hit')).toMatchObject({ severity: 'medium', decoy: { id: 'GQL', status: 200 }, req: { path: '/graphql', method: 'POST' } });
                expect(r.deliveries).toHaveLength(1);
                expect(r.deliveries[0]!.valid).toBe(true);
                expect(r.deliveries[0]!.payload.event.decoy!.id).toBe('GQL');
            }, { alerts: { adapters: [webhookAdapter({ url: r.url, secret: 'webhook-test-secret' })] } });
        } finally { await r.close(); }
    });

    it('keeps the demo site, D1–D5 and alert-only canary replay working', async () => {
        await using(async (url, events) => {
            expect((await fetch(url + '/')).status).toBe(200);
            const env = await (await fetch(url + '/.env')).text();
            const token = /ADMIN_API_TOKEN=(\S+)/.exec(env)![1]!;
            for (const [path, status] of [['/api/internal/admin/users', 401], ['/internal/ops-notes', 200], ['/api/internal/openapi.json', 200], ['/api/internal/auth/login', 405]] as const) {
                expect((await fetch(url + path)).status).toBe(status);
            }
            // Variables are scanned after body parsing even for a real query.
            const replay = await query(url, 'query($marker: String) { hello }', { variables: { marker: token } });
            // The host validator owns unused variables; use a header replay for a
            // valid real query as well, proving that detection does not block it.
            expect(replay.status).toBe(400);
            const real = await fetch(url + '/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ query: '{ hello }' }) });
            expect(await real.json()).toEqual({ data: { hello: 'Hello from the local demo.' } });
            expect(events.filter(event => event.event === 'canary_replay')).toHaveLength(2);
            expect(events.find(event => event.event === 'canary_replay')!.canary).toMatchObject({ found_in: 'body', field: 'variables.marker', placement: 'D1:/.env#ADMIN_API_TOKEN' });
            expect(events.filter(event => event.event === 'decoy_hit').map(event => event.decoy!.id)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
        });
    });

    it('maps crawler bypass to the same native 404 as MCP, including introspection and real queries', async () => {
        await using(async (url, events) => {
            for (const source of [getIntrospectionQuery(), '{ hello }', '{ internalAdminUsers { id } }']) {
                const response = await query(url, source, { ua: 'Googlebot' });
                expect(response.status).toBe(404);
                expect(await response.text()).toBe('Not Found\n');
                expect(response.headers.get('x-robots-tag')).toBeNull();
                expect(response.headers.get('cache-control')).toBeNull();
            }
            expect(events.filter(event => event.event === 'crawler_bypass')).toHaveLength(3);
            expect(events.some(event => event.event === 'decoy_hit')).toBe(false);
        }, { crawler: { resolver: verifiedResolver } });
    });

    it('denies spoofed and allowlisted decoy selections without exposing real data', async () => {
        for (const allowlist of [undefined, { ips: ['127.0.0.1'] }]) {
            await using(async (url, events) => {
                const response = await query(url, '{ hello internalAdminUsers { id } }', { ua: 'Googlebot' });
                expect(await response.json()).toEqual({ errors: [{ message: 'Permission denied', extensions: { code: 'FORBIDDEN' } }] });
                expect(response.headers.get('cache-control')).toBe('no-store');
                expect(response.headers.get('x-robots-tag')).toContain('noindex');
                expect(events.some(event => event.event === 'decoy_hit')).toBe(!allowlist);
            }, { allowlist, crawler: { resolver: spoofResolver } });
        }
    });

    it('rejects malformed, excessive and invalid host requests without crashing or alerting', async () => {
        await using(async (url, events) => {
            for (const source of ['{', '{ internalAdminUsers { id }', '{ internalAdminUsers { id } }'.padEnd(20000), '{ ' + 'a '.repeat(4096) + 'internalAdminUsers { id } }']) {
                const response = await query(url, source);
                expect(response.status).toBe(400);
                expect((await response.json()).errors).toBeDefined();
            }
            for (const body of ['{', 'null', '[]', '{}', '{"query":3}', '{"query":"{hello}","variables":[]}']) {
                const response = await fetch(url + '/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
                expect(response.status).toBe(400);
            }
            expect(await (await query(url, '{ hello }')).json()).toEqual({ data: { hello: 'Hello from the local demo.' } });
            expect(events).toEqual([]);
        });
    });
});
