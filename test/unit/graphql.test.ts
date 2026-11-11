import { afterEach, describe, expect, it } from 'vitest';
import { getIntrospectionQuery, parse } from 'graphql';
import { readFileSync } from 'node:fs';
import { createAgentGuard, graphqlDecoys, inspectGraphqlRequest, lintMcpDecoyDescription, type AgentGuard } from '../../src/index.js';
import { config, request } from '../helpers.js';

const guards: AgentGuard[] = [];
afterEach(async () => { await Promise.all(guards.splice(0).map(guard => guard.close())); });
function guard(): AgentGuard {
    const value = createAgentGuard(config()); guards.push(value); return value;
}
function inspect(query: unknown, operationName?: string) {
    return inspectGraphqlRequest(guard(), request('/graphql', { method: 'POST', body: { query, operationName } }));
}

it('returns deeply frozen GraphQL metadata with neutral descriptions and a matching field type', () => {
    const metadata = graphqlDecoys();
    const check = (value: unknown): void => {
        if (typeof value !== 'object' || value === null) return;
        expect(Object.isFrozen(value)).toBe(true);
        if ('description' in value) expect(lintMcpDecoyDescription(String(value.description))).toEqual([]);
        for (const child of Object.values(value)) check(child);
    };
    check(metadata);
    expect(metadata[0]!.field.name).toBe('internalAdminUsers');
    expect(metadata[0]!.field.type).toContain(metadata[0]!.type.name);
});

describe('bounded GraphQL selections', () => {
    it.each([
        '{ internalAdminUsers { id } }',
        '{ result: internalAdminUsers { id } }',
        'query Accounts { internalAdminUsers { id } }',
        'query Accounts($limit: Int = 2) { internalAdminUsers(limit: $limit) { id } }',
        '{ internalAdminUsers @skip(if: false) { id } }',
        'query { ...Accounts } fragment Accounts on Query { internalAdminUsers { id } }',
        'fragment Accounts on Query { internalAdminUsers { id } } query { ...Accounts }',
        '{ ... on Query { internalAdminUsers { id } } }',
        '{ ... @include(if: true) { internalAdminUsers { id } } }',
        'query { ...A ...A } fragment A on Query { ...B } fragment B on Query { internalAdminUsers { id } }',
        '# internalAdminUsers\r{ internalAdminUsers { id } }',
        '\uFEFF{, internalAdminUsers, { id, }, }',
        '{ hello(arg: {nested: [1, -2, 3.4e+5, null, true, ENUM]}) internalAdminUsers { id } }',
    ])('detects selected fields in %s', async query => {
        expect(() => parse(query)).not.toThrow();
        const result = await inspect(query);
        expect(result.action).toBe('respond');
        expect(result.events.filter(event => event.event === 'decoy_hit')).toMatchObject([{ severity: 'medium', decoy: { id: 'GQL', status: 200 } }]);
        if (result.action !== 'respond') throw new Error('expected decoy response');
        expect(JSON.parse(result.response.body)).toEqual({ errors: [{ message: 'Permission denied', extensions: { code: 'FORBIDDEN' } }] });
        expect(result.response.headers['X-Robots-Tag']).toContain('noindex');
        expect(result.response.headers['Cache-Control']).toBe('no-store');
    });

    it.each([
        '{ hello }',
        '{ internalAdminUsers: hello }',
        'query internalAdminUsers { hello }',
        'query($internalAdminUsers: String) { hello(arg: $internalAdminUsers) }',
        '{ hello(arg: "internalAdminUsers { id }") }',
        String.raw`{ hello(arg: "escaped \" internalAdminUsers") }`,
        '{ hello(arg: """internalAdminUsers { id }""") }',
        '{ hello(arg: """escaped \\""" internalAdminUsers""") }',
        '{ hello(arg: {internalAdminUsers: true}) }',
        '{ hello @internalAdminUsers }',
        '{ hello } # internalAdminUsers { id }',
        'query { hello } fragment Unused on Query { internalAdminUsers { id } }',
        '{ __type(name: "internalAdminUsers") { name description } }',
        '{ __typename }',
        getIntrospectionQuery(),
        // Even an invalid introspection selection is for the host to reject.
        '{ __schema { internalAdminUsers } }',
        '{ __type(name: "Query") { ...Fields } } fragment Fields on __Type { internalAdminUsers }',
    ])('passes mentions outside decoy selections in %s', async query => {
        expect(() => parse(query)).not.toThrow();
        expect(await inspect(query)).toEqual({ action: 'pass', events: [] });
    });

    it.each([
        '', '{', '{ internalAdminUsers { id }', '{ internalAdminUsers { id } } }',
        '{ internalAdminUsers() { id } }', '{ internalAdminUsers(arg:) { id } }',
        '{ internalAdminUsers(arg: 01) { id } }', '{ internalAdminUsers(arg: 1e) { id } }',
        '{ internalAdminUsers(arg: 1name) { id } }', '{ internalAdminUsers(arg: -) { id } }',
        '{ internalAdminUsers(arg: "unterminated) { id } }',
        '{ internalAdminUsers(arg: "bad\\x") { id } }',
        '{ internalAdminUsers(arg: "bad\nline") { id } }',
        '{ internalAdminUsers(arg: "\\uD800") { id } }',
        '{ internalAdminUsers(arg: """unterminated) { id } }',
        '{ internalAdminUsers(arg: """\u0001""") { id } }',
        '{ internalAdminUsers { id } ; }', '{ internalAdminUsers {} }',
        '{ alias: }', '{ ... }', '{ ...on { internalAdminUsers { id } } }',
        'query() { internalAdminUsers { id } }',
        'query($x: [Int) { internalAdminUsers { id } }',
        'query($x: Int = $y) { internalAdminUsers { id } }',
        'type Query { internalAdminUsers: String }',
        'fragment on on Query { internalAdminUsers { id } }',
    ])('fails open on malformed syntax in %s', async query => {
        expect(await inspect(query)).toEqual({ action: 'pass', events: [] });
    });

    it('fails open on missing or cyclic fragments and ambiguous or unknown operations', async () => {
        for (const query of [
            '{ internalAdminUsers { id } ...Missing }',
            'query { internalAdminUsers { id } ...Loop } fragment Loop on Query { ...Loop }',
            'query A { internalAdminUsers { id } } query A { hello }',
            '{ hello } query A { internalAdminUsers { id } }',
            'query { internalAdminUsers { id } } fragment A on Query { hello } fragment A on Query { hello }',
        ]) expect(await inspect(query), query).toEqual({ action: 'pass', events: [] });
        const query = 'query Real { hello } query Decoy { internalAdminUsers { id } }';
        expect(await inspect(query)).toEqual({ action: 'pass', events: [] });
        expect(await inspect(query, 'Real')).toEqual({ action: 'pass', events: [] });
        expect(await inspect(query, 'Missing')).toEqual({ action: 'pass', events: [] });
        expect((await inspect(query, 'Decoy')).action).toBe('respond');
    });

    it('caps query length, token count, selection/value/type depth and fragment expansion', async () => {
        const decoy = '{ internalAdminUsers { id } }';
        expect((await inspect(decoy.padEnd(16384))).action).toBe('respond');
        for (const query of [
            decoy.padEnd(16385),
            '{ ' + 'a '.repeat(4096) + 'internalAdminUsers { id } }',
            '{ x '.repeat(70) + decoy + ' }'.repeat(70),
            '{ internalAdminUsers(arg:' + '['.repeat(70) + '0' + ']'.repeat(70) + ') { id } }',
            'query($x: ' + '['.repeat(70) + 'Int' + ']'.repeat(70) + ') { internalAdminUsers { id } }',
            'query { ...F0 } ' + Array.from({ length: 70 }, (_, i) => `fragment F${i} on Query { ${i === 69 ? 'internalAdminUsers { id }' : `...F${i + 1}`} }`).join(' '),
        ]) expect(await inspect(query)).toEqual({ action: 'pass', events: [] });
        const shared = 'query { ...F0 } ' + Array.from({ length: 30 }, (_, i) => `fragment F${i} on Query { ${i === 29 ? 'internalAdminUsers { id }' : `...F${i + 1} ...F${i + 1}`} }`).join(' ');
        expect((await inspect(shared)).action).toBe('respond');
    });

    it('accepts parsed query parameters and fails open on non-string or exotic query inputs', async () => {
        const value = guard();
        expect((await inspectGraphqlRequest(value, request('/graphql', { query: { query: '{ internalAdminUsers { id } }' } }))).action).toBe('respond');
        for (const body of [undefined, null, [], 3, { query: null }, { query: [] }, { query: 12 }, { query: '{ internalAdminUsers { id } }', operationName: [] }]) {
            expect(await inspectGraphqlRequest(value, request('/graphql', { body }))).toEqual({ action: 'pass', events: [] });
        }
        const body = Object.defineProperty({}, 'query', { get() { throw new Error('host getter'); } });
        expect(await inspectGraphqlRequest(value, request('/graphql', { body }))).toEqual({ action: 'pass', events: [] });
    });
});

it('emits schema-compatible GQL events and increments the additive metric without losing MCP', async () => {
    const value = guard();
    const result = await inspectGraphqlRequest(value, request('/graphql', { body: { query: '{ internalAdminUsers { id } }' } }));
    const schema = JSON.parse(readFileSync(new URL('../../schema/event.v1.json', import.meta.url), 'utf8'));
    expect(schema.properties.decoy.properties.id.enum).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'MCP', 'GQL']);
    expect(schema.properties.decoy.properties.id.enum).toContain(result.events[0]!.decoy!.id);
    expect(value.metrics().decoy_hits.GQL).toBe(1);
    expect(value.metrics().decoy_hits.MCP).toBe(0);
    const mcp = await value.inspect(request('/mcp'), { mcp: { toolName: 'export_customer_records' } });
    expect(mcp.events[0]!.decoy!.id).toBe('MCP');
    expect(value.metrics().decoy_hits.MCP).toBe(1);
});
