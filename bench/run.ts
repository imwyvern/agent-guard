import { mkdirSync } from 'node:fs';
import { simulate } from './simulate.js';
import { latency } from './latency.js';
import { lighthouse } from './lighthouse.js';
import { save, report } from './common.js';
mkdirSync('bench/results', { recursive: true });
let failed = false;
for (const [name, run] of [['simulate', simulate], ['latency', latency], ['lighthouse', lighthouse]] as const) {
    try {
        console.log(`Running ${name}…`);
        const result = await run();
        console.log(JSON.stringify(result, null, 2));
        if (result.status === 'failed')
            failed = true;
    }
    catch (error) {
        failed = true;
        const result = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
        save(name, result);
        console.error(result);
    }
    finally {
        report();
    }
}
if (failed)
    process.exitCode = 1;
