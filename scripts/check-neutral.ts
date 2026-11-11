import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const neutralBundles = ['web.js', 'workers.js', 'next.js', 'deno.js', 'bun.js', 'hono-web.js'];
export function checkNeutral(directory = fileURLToPath(new URL('../dist/', import.meta.url))): void {
    for (const file of neutralBundles) {
        let source: string;
        try { source = readFileSync(resolve(directory, file), 'utf8'); }
        catch { throw new Error(`${file}: cannot read neutral bundle; run npm run build first`); }
        const match = /node:|(?<![\w$])require\s*\(|(?<![\w$])process\s*\.|(?<![\w$])Buffer(?![\w$])/.exec(source);
        if (match) throw new Error(`${file}: forbidden neutral bundle reference ${match[0]}`);
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { checkNeutral(); console.log(`Neutrality check passed (${neutralBundles.length} bundles)`); }
    catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
