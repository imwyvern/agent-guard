import { expect, it } from 'vitest';
import { startDemo } from '../../examples/shared/site.js';
import { config } from '../helpers.js';
import type { AgentGuardEvent } from '../../src/index.js';

it('Node demo explicitly mounts configured callbacks before inspection; the default demo leaves them unmounted', async () => {
    const c = config(), events: AgentGuardEvent[] = [];
    const demo = await startDemo('node', { ...c, canary: { ...c.canary, callback: { baseUrl: 'http://127.0.0.1' } }, onEvent: e => events.push(e) });
    const unconfigured = await startDemo('node', c);
    try {
        const decoy = await fetch(demo.url + '/.env'), body = await decoy.text();
        const url = /^CALLBACK_URL=(.+)$/m.exec(body)![1]!, path = new URL(url).pathname, token = path.slice('/ag/cb/'.length);
        for (const method of ['GET', 'HEAD']) {
            const r = await fetch(demo.url + path, { method });
            expect(r.status).toBe(204); expect(await r.text()).toBe('');
            expect(r.headers.get('cache-control')).toBe('no-store');
            expect(r.headers.has('set-cookie')).toBe(false);
        }
        expect(events.filter(e => e.event === 'canary_callback')).toHaveLength(2);
        expect(JSON.stringify(events)).not.toContain(token);
        expect((await fetch(demo.url + '/ag/cb/invalid')).status).toBe(404);
        expect((await fetch(unconfigured.url + path)).status).toBe(404);
        expect((await fetch(demo.url + '/')).status).toBe(200);
    } finally { await demo.close(); await unconfigured.close(); }
});
