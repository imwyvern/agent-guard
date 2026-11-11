import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { receiver } from '../test/helpers.js';
import { isMain } from '../bench/common.js';

function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
export async function smokeWorkers(): Promise<void> {
    const hook = await receiver();
    let mf: Miniflare | undefined;
    try {
        const result = await build({ entryPoints: ['scripts/fixtures/smoke-worker.ts'], bundle: true, platform: 'neutral', format: 'esm', target: 'es2022', write: false });
        mf = new Miniflare({ modules: true, script: result.outputFiles[0]!.text, compatibilityDate: '2025-04-01', host: '127.0.0.1',
            bindings: { AG_CANARY_SECRET: 'workers-test-binding-secret', AG_PROJECT_SEED: 'workers-test-seed', WEBHOOK_URL: hook.url },
        });
        await mf.ready; // Startup errors are failures, never runtime skips.
        const home = await mf.dispatchFetch('http://127.0.0.1/');
        check(home.status === 200 && await home.text() === 'ok', 'worker host pass-through failed');
        check(home.headers.get('x-smoke-wait-until') === '0', 'ordinary request scheduled alert work');
        const decoy = await mf.dispatchFetch('http://127.0.0.1/.env');
        check(decoy.status === 200, 'worker decoy status');
        check(decoy.headers.get('x-robots-tag')?.includes('noindex'), 'worker decoy noindex');
        check(decoy.headers.get('cache-control') === 'no-store', 'worker decoy no-store');
        check(Number(decoy.headers.get('x-smoke-wait-until')) > 0, 'worker decoy did not use ctx.waitUntil');
        const token = /^ADMIN_API_TOKEN=(.+)$/m.exec(await decoy.text())?.[1];
        check(token, 'worker missing canary');
        const replay = await mf.dispatchFetch('http://127.0.0.1/list', { headers: { authorization: token } });
        check(replay.status === 200 && await replay.text() === 'ok', 'worker replay host pass-through');
        check(Number(replay.headers.get('x-smoke-wait-until')) > 0, 'worker replay did not use ctx.waitUntil');
        const deadline = Date.now() + 5000;
        while (!hook.deliveries.some(d => d.payload.event.event === 'canary_replay') && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 10));
        const delivery = hook.deliveries.find(d => d.payload.event.event === 'canary_replay');
        check(delivery?.valid && delivery.payload.event.severity === 'critical', 'worker replay signed loopback alert missing');
        const fallback = await mf.dispatchFetch('http://127.0.0.1/fail-open');
        check(fallback.status === 200 && await fallback.text() === 'ok', 'worker fail-open host pass-through');
        console.log('workers workerd smoke passed (loopback webhook, waitUntil, fail-open)');
    } catch (error) { throw new Error('Workers/miniflare smoke failed (workerd must start and pass)', { cause: error }); }
    finally { await mf?.dispose(); await hook.close(); }
}
if (isMain(import.meta.url)) await smokeWorkers();
