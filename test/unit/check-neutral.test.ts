import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkNeutral, neutralBundles } from '../../scripts/check-neutral.js';

const directories: string[] = [];
function bundles(): string {
    const directory = mkdtempSync(join(tmpdir(), 'agent-guard-neutral-')); directories.push(directory);
    for (const file of neutralBundles) writeFileSync(join(directory, file), 'export const neutral = true;');
    return directory;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('checks all six neutral entries and ignores source maps and unrelated bundles', () => {
    const directory = bundles();
    expect(neutralBundles).toEqual(['web.js', 'workers.js', 'next.js', 'deno.js', 'bun.js', 'hono-web.js']);
    writeFileSync(join(directory, 'web.js.map'), 'node: require( process. Buffer');
    writeFileSync(join(directory, 'index.js'), 'import "node:crypto";');
    expect(() => checkNeutral(directory)).not.toThrow();
});
it.each(neutralBundles)('rejects forbidden references in %s with the filename and match', file => {
    const directory = bundles(); writeFileSync(join(directory, file), 'import "node:crypto";');
    expect(() => checkNeutral(directory)).toThrow(`${file}: forbidden neutral bundle reference node:`);
});
it.each([
    ['require("fs")', 'require('], ['require ("fs")', 'require ('],
    ['process.env', 'process.'], ['globalThis.process.env', 'process.'], ['process .env', 'process .'],
    ['Buffer.from("x")', 'Buffer'], ['globalThis.Buffer', 'Buffer'], ['const Buffer = 1', 'Buffer'],
])('rejects %s', (source, match) => {
    const directory = bundles(); writeFileSync(join(directory, 'web.js'), source);
    expect(() => checkNeutral(directory)).toThrow(`web.js: forbidden neutral bundle reference ${match}`);
});
it('allows unrelated identifier substrings', () => {
    const directory = bundles();
    writeFileSync(join(directory, 'web.js'), 'const ArrayBuffer = globalThis.ArrayBuffer; const myBuffer = 1, BufferSize = 2, $Buffer = 3, Buffer$ = 4; const subprocess = {env: 1}; subprocess.env;');
    expect(() => checkNeutral(directory)).not.toThrow();
});
it('fails clearly when a bundle is missing without requiring a production build in tests', () => {
    const directory = bundles(); rmSync(join(directory, 'bun.js'));
    expect(() => checkNeutral(directory)).toThrow('bun.js: cannot read neutral bundle; run npm run build first');
});
