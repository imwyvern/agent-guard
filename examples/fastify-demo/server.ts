import { demoConfig, startDemo } from '../shared/site.js';
const demo = await startDemo('fastify', process.env.AGENT_GUARD === 'off' ? false : demoConfig(), Number(process.env.PORT ?? 3000));
console.log(`Fastify demo: ${demo.url}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => { void demo.close(); });
