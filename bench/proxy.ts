import { Agent, createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import { createAgentGuard } from '../src/index.js';
import { createProxy } from '../src/proxy/server.js';
import { demoConfig } from '../examples/shared/site.js';
import { isMain, save } from './common.js';

async function listen(server: Server): Promise<string> {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
/** Informational, one in-flight keep-alive GET; no acceptance threshold. */
export async function proxyLatency() {
    const config = demoConfig({ crawler: { verify: 'ua-bypass' }, log: { sink: () => {} }, alerts: { adapters: [] } });
    const guard = createAgentGuard(config), upstream = createServer((_req, res) => res.end('ordinary page\n'));
    const origin = await listen(upstream), proxy = createProxy({ upstream: origin, config, guard });
    const via = await listen(proxy.server), agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const measure = async (url: string) => {
        const samples: number[] = [];
        for (let i = 0; i < 1100; i++) {
            const begin = process.hrtime.bigint();
            await new Promise<void>((resolve, reject) => {
                const req = request(url, { agent, headers: { 'user-agent': 'Mozilla/5.0' } }, res => {
                    res.resume(); res.on('error', reject);
                    res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('non-200 response')));
                });
                req.on('error', reject); req.end();
            });
            if (i >= 100) samples.push(Number(process.hrtime.bigint() - begin) / 1000);
        }
        samples.sort((a, b) => a - b);
        return { p50Us: samples[499]!, p99Us: samples[989]! };
    };
    try {
        const rows: Array<{ direct: Awaited<ReturnType<typeof measure>>; proxy: Awaited<ReturnType<typeof measure>> }> = [];
        for (let i = 0; i < 3; i++) {
            if (i % 2) { const proxy = await measure(via); rows.push({ proxy, direct: await measure(origin) }); }
            else { const direct = await measure(origin); rows.push({ direct, proxy: await measure(via) }); }
        }
        const median = (values: number[]) => values.sort((a, b) => a - b)[1]!;
        const result = { generatedAt: new Date().toISOString(), node: process.version,
            method: 'local HTTP, one in-flight keep-alive GET; 100 warmup + 1000 measured requests/mode/run, 3 interleaved runs; same-process upstream/proxy/client; informational only', rows,
            medianDeltaUs: { p50: median(rows.map(r => r.proxy.p50Us - r.direct.p50Us)), p99: median(rows.map(r => r.proxy.p99Us - r.direct.p99Us)) },
            threshold: null };
        save('proxy-latency', result); return result;
    } finally {
        agent.destroy(); await proxy.close(); await guard.close();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
}
if (isMain(import.meta.url)) console.log(JSON.stringify(await proxyLatency(), null, 2));
