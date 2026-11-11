import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('Workers smoke executes in workerd via miniflare', async () => {
    try { const { smokeWorkers } = await import('../../scripts/smoke-workers.js'); await smokeWorkers(); }
    catch (error) { throw new Error('Workers smoke failed: miniflare/workerd must be installed and start successfully', { cause: error }); }
}, 30000);
for (const runtime of ['bun', 'deno'] as const) {
    const binary = runtime === 'bun' && spawnSync('/usr/local/bin/bun', ['--version']).status === 0 ? '/usr/local/bin/bun' : runtime;
    const available = spawnSync(binary, ['--version']).status === 0;
    const reason = `${runtime} binary not found; run npm run smoke:${runtime} locally`;
    it.skipIf(!available)(available ? `${runtime} serve smoke` : reason, () => {
        const args = runtime === 'bun' ? ['scripts/smoke-bun.ts'] : ['run', '--allow-net=127.0.0.1', 'scripts/smoke-deno.ts'];
        const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 15000 });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain(`${runtime} serve smoke passed`);
    }, 20000);
}
