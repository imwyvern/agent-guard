import { createAgentGuard } from '../src/index.js';
import { demoConfig } from '../examples/shared/site.js';
const guard = createAgentGuard(demoConfig({ log: { sink: () => { } }, alerts: { adapters: [] } }));
const req = { method: 'GET', path: '/', query: {}, headers: { 'user-agent': 'Mozilla/5.0' }, ip: '192.0.2.1' };
for (let i = 0; i < 10000; i++)
    await guard.inspect(req);
global.gc?.();
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < 50000; i++)
    await guard.inspect({ ...req, headers: { 'user-agent': 'Mozilla/5.0 memory-client-' + i } });
global.gc?.();
console.log(JSON.stringify({ clients: 50000, heapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - before), gc: !!global.gc }));
await guard.close();
