import { createWebGuard } from '../dist/web.js';
import type { AgentGuardEvent } from '../src/types.js';

export function smokeGuard() {
    const events: AgentGuardEvent[] = [];
    const guard = createWebGuard({ project: 'runtime-smoke', env: 'test', projectSeed: 'runtime-smoke-seed',
        canary: { secret: 'runtime-smoke-test-secret', registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
        onEvent: event => events.push(event),
    });
    return { guard, events };
}
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
export async function smokeRequests(port: number, events: AgentGuardEvent[]): Promise<void> {
    const base = `http://127.0.0.1:${port}`;
    const home = await fetch(base + '/');
    check(home.status === 200 && await home.text() === 'ok', 'host pass-through failed');
    const decoy = await fetch(base + '/.env');
    check(decoy.status === 200, 'decoy status');
    check(decoy.headers.get('x-robots-tag')?.includes('noindex'), 'decoy noindex');
    check(decoy.headers.get('cache-control') === 'no-store', 'decoy no-store');
    const token = /^ADMIN_API_TOKEN=(.+)$/m.exec(await decoy.text())?.[1];
    check(token, 'missing canary');
    const replay = await fetch(base + '/list', { headers: { authorization: token } });
    check(replay.status === 200 && await replay.text() === 'ok', 'real path replay pass-through');
    const event = events.find(e => e.event === 'canary_replay');
    check(event?.severity === 'critical' && event.canary?.found_in === 'header', 'canary replay missing');
}
