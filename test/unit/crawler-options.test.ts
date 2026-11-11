import { expect, it, vi } from 'vitest';
import { createAgentGuard } from '../../src/core/inspect.js';
import type { AgentGuardConfig, AGRequest } from '../../src/types.js';
import { validateConfig } from '../../src/config.js';

const request: AGRequest = { method: 'GET', path: '/.env', headers: { 'user-agent': 'Googlebot' }, query: {}, ip: '192.0.2.1' };
function config(crawler?: AgentGuardConfig['crawler']): AgentGuardConfig {
    return { mode: 'detect', project: 'crawler-options', env: 'test', projectSeed: 'fixture', canary: { secret: 'fixture', registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } }, crawler, log: { sink: () => {} } };
}
it.each([undefined, true, 'dns'] as const)('preserves Node DNS verification for %s', async verify => {
    const resolver = { reverse: vi.fn(async () => ['crawl.googlebot.com']), resolve: vi.fn(async () => ['192.0.2.1']) };
    const g = createAgentGuard(config({ verify, resolver }));
    try {
        const d = await g.inspect(request);
        expect(resolver.reverse).toHaveBeenCalledWith('192.0.2.1'); expect(resolver.resolve).toHaveBeenCalledWith('crawl.googlebot.com');
        expect(d).toMatchObject({ action: 'respond', response: { status: 404, body: 'Not Found\n' } }); expect(d.events[0]?.crawler?.verified).toBe(true);
    } finally { await g.close(); }
});
it('honors Node ua-bypass with no resolver calls, replay escalation or trap', async () => {
    const resolver = { reverse: vi.fn(async () => []), resolve: vi.fn(async () => []) }, c = config({ verify: 'ua-bypass', resolver });
    c.mode = 'trap'; c.trap = { delay: { enabled: true, ms: 3000 }, block: { enabled: true }, maze: { enabled: true } };
    const g = createAgentGuard(c);
    try {
        for (const path of ['/.env', '/api/internal/archive/invalid', '/']) {
            const d = await g.inspect({ ...request, path });
            expect(d.events).toHaveLength(1); expect(d.events[0]).toMatchObject({ event: 'crawler_bypass', severity: 'debug', signals: [], crawler: { verified: false } });
            if (path !== '/') expect(d).toMatchObject({ action: 'respond', response: { status: 404, body: 'Not Found\n' } });
        }
        expect(resolver.reverse).not.toHaveBeenCalled(); expect(resolver.resolve).not.toHaveBeenCalled();
    } finally { await g.close(); }
});
it.each([true, false])('uses custom Node verification with result %s and no DNS', async verified => {
    const resolver = { reverse: vi.fn(async () => []), resolve: vi.fn(async () => []) }, customVerify = vi.fn(async () => verified);
    const g = createAgentGuard(config({ verify: 'custom', customVerify, resolver }));
    try {
        const d = await g.inspect(request);
        expect(customVerify).toHaveBeenCalledWith('192.0.2.1', 'Googlebot'); expect(resolver.reverse).not.toHaveBeenCalled();
        expect(d.action === 'respond' && d.response.status).toBe(verified ? 404 : 200); expect(d.events[0]?.crawler?.verified).toBe(verified);
    } finally { await g.close(); }
});
it.each([undefined, false])('honors custom Node timeout/error failOpen %s', async failOpen => {
    for (const customVerify of [async () => { throw new Error('offline'); }, () => new Promise<boolean>(() => {})]) {
        const g = createAgentGuard(config({ verify: 'custom', customVerify, timeoutMs: 1, failOpen }));
        try { const d = await g.inspect(request); expect(d.action === 'respond' && d.response.status).toBe(failOpen === false ? 200 : 404); }
        finally { await g.close(); }
    }
});
it('validates explicit crawler modes and requires a custom verifier', () => {
    expect(() => validateConfig(config({ verify: 'custom' }))).toThrow(/customVerify/);
    expect(() => validateConfig(config({ verify: 'invalid' as 'dns' }))).toThrow(/crawler.verify/);
});
