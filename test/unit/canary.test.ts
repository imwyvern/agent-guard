import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCanary, verifyCanary } from '../../src/index.js';
import { Registry, loadRegistry } from '../../src/canary/registry.js';
import { scanRequest, matchesPath } from '../../src/canary/scan.js';
import { config, request } from '../helpers.js';
describe('canary format and registry', () => {
    it('generates random 60-bit IDs; checks prefix, mutation and HMAC', () => {
        const a = generateCanary({ secret: 's' }), b = generateCanary({ secret: 's' });
        expect(a.id).toHaveLength(12);
        expect(a.id).not.toBe(b.id);
        expect(verifyCanary(a.token, { secret: 's' })).toEqual({ valid: true, id: a.id });
        expect(verifyCanary(a.token.slice(0, -1) + (a.token.endsWith('0') ? '1' : '0'), { secret: 's' }).valid).toBe(false);
        expect(verifyCanary(a.token, { secret: 'wrong' }).valid).toBe(false);
        expect(verifyCanary(a.token, { secret: 's', prefix: 'ACME-CANARY-' }).valid).toBe(false);
        expect(verifyCanary('AG-CANARY-malformed', { secret: 's' }).valid).toBe(false);
        expect(verifyCanary(generateCanary({ prefix: 'ACME-CANARY-', secret: 's' }).token, { secret: 's', prefix: 'ACME-CANARY-' }).valid).toBe(true);
        expect(() => generateCanary({ secret: '' })).toThrow();
        expect(() => generateCanary({ secret: 's', prefix: 'bad' })).toThrow();
    });
    it('loads files, clones input, reuses placements and rejects malformed/duplicate records', () => {
        const input = { version: 1 as const, prefix: 'AG-CANARY-', canaries: [] };
        const r = new Registry(input, 's', 'AG-CANARY-');
        const a = r.placement('D1:token', 'demo');
        expect(r.placement('D1:token', 'demo')).toBe(a);
        expect(r.find(a.token)).toBe(a);
        expect(input.canaries).toHaveLength(0);
        const dir = mkdtempSync(join(tmpdir(), 'ag-reg-'));
        try {
            const file = join(dir, 'registry.json');
            writeFileSync(file, JSON.stringify(r.data));
            expect(loadRegistry(file)).toEqual(r.data);
            expect(new Registry(file, 's', 'AG-CANARY-').find(a.token)).toEqual(a);
        }
        finally {
            rmSync(dir, { recursive: true });
        }
        expect(() => loadRegistry({ ...r.data, version: 2 as 1 })).toThrow();
        expect(() => loadRegistry({ ...r.data, canaries: null as never })).toThrow();
        expect(() => new Registry(input, 's', 'ACME-CANARY-')).toThrow();
        for (const field of ['id', 'token', 'env', 'placement', 'createdAt'] as const)
            expect(() => loadRegistry({ ...r.data, canaries: [{ ...a, [field]: '' }] })).toThrow();
        expect(() => loadRegistry({ ...r.data, canaries: [a, a] })).toThrow();
        expect(() => loadRegistry({ ...r.data, canaries: [a, { ...a, id: 'another' }] })).toThrow();
    });
});
describe('bounded request scan', () => {
    const c = config(), r = new Registry(c.canary.registry, c.canary.secret, 'AG-CANARY-'), entry = r.placement('D3:password', 'demo');
    it('finds path/header arrays/query/body nested/form strings, and dedupes occurrences', () => {
        const token = entry.token;
        for (const [req, where] of [
            [request('/' + token), 'path'], [request('/', { headers: { a: [token, 'other'], b: undefined } }), 'header'], [request('/', { query: { a: [token] } }), 'query'],
            [request('/login', { body: { user: { credentials: [0, null, { password: token }] } } }), 'body'], [request('/login', { body: 'password=' + token }), 'body']
        ] as const)
            expect(scanRequest(req, r, c, true)[0]?.found_in).toBe(where);
        expect(scanRequest(request('/' + token, { headers: { a: token }, body: { a: token } }), r, c, true)).toHaveLength(1);
        expect(scanRequest(request('/', { query: { q: token } }), r, c, true)[0]?.entry).toEqual(entry);
    });
    it('validates unregistered signatures, ignores mutations, supports rotated registry secrets', () => {
        const fresh = generateCanary({ secret: c.canary.secret });
        expect(scanRequest(request('/', { headers: { x: fresh.token } }), r, c, false)[0]?.entry.placement).toBe('unregistered');
        const invalid = fresh.token.slice(0, -1) + (fresh.token.endsWith('0') ? '1' : '0');
        expect(scanRequest(request('/', { headers: { x: invalid } }), r, c, false)).toEqual([]);
        expect(scanRequest(request('/', { headers: { x: entry.token } }), r, { ...c, canary: { ...c.canary, secret: 'rotated' } }, false)).toHaveLength(1);
    });
    it('honors disabled and bounded scans, cycles, undefined and non-string JSON', () => {
        const token = entry.token, cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        const disabled = { ...c, canaryScan: { headers: false, query: false, maxBodyBytes: 1 } };
        expect(scanRequest(request('/', { headers: { x: token }, query: { x: token }, body: { x: token } }), r, disabled, true)).toEqual([]);
        for (const body of [cycle, () => { }, 1, null, { empty: undefined }, undefined])
            expect(scanRequest(request('/', { body }), r, c, true)).toEqual([]);
        expect(scanRequest(request('/', { body: { x: token } }), r, c, false)).toEqual([]);
        expect(matchesPath('/api/auth/login', '/api/auth/*')).toBe(true);
        expect(matchesPath('/login', '/login')).toBe(true);
        expect(matchesPath('/logout', '/login')).toBe(false);
    });
});
