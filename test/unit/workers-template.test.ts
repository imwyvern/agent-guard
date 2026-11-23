import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { parseTOML } from 'confbox/toml';
import ts from 'typescript';
import { expect, it } from 'vitest';
import type { AgentGuardEvent } from '../../src/types.js';

const root = resolve('.');
const template = resolve(root, 'deploy/workers');
const entry = resolve(template, 'src/index.ts');
const adapter = resolve(root, 'src/adapters/workers.ts');
const read = (path: string): string => readFileSync(resolve(template, path), 'utf8');
const config = (): Record<string, unknown> => parseTOML(read('wrangler.toml.example'));

it('WT-1: parses a fixed local Wrangler config without secrets, account IDs, routes or storage bindings', () => {
    const parsed = config();
    expect(parsed.main).toBe('src/index.ts');
    expect(existsSync(resolve(template, String(parsed.main)))).toBe(true);
    expect(parsed.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const date = String(parsed.compatibility_date);
    expect(new Date(date).toISOString().slice(0, 10)).toBe(date);
    for (const key of ['account_id', 'route', 'routes', 'zone_id', 'zone_name', 'kv_namespaces', 'durable_objects'])
        expect(parsed).not.toHaveProperty(key);
    const vars = parsed.vars as Record<string, unknown>;
    expect(vars.AG_MODE).toBe('detect');
    for (const key of Object.keys(vars)) expect(key).not.toMatch(/SECRET|SEED|TOKEN|PASSWORD|KEY/i);
    expect(parsed.dev).toMatchObject({ ip: '127.0.0.1' });
    expect(parsed.workers_dev).toBe(false);
});

it('WT-2: uses the real Workers API, has no trap mode or embedded secrets, and type-checks strictly against source', () => {
    const source = read('src/index.ts');
    expect(source).toContain("from '@imwyvern/agent-guard/workers'");
    expect(source).toMatch(/\bfromEnv\s*\(/);
    expect(source).toMatch(/\bwithAgentGuard\s*\(/);
    expect(source).not.toMatch(/\btrap\b|setTrapEnabled/);
    expect(source).not.toMatch(/(?:AG_CANARY_SECRET|AG_PROJECT_SEED|\bsecret|\bprojectSeed)\s*[:=]\s*['"`]/);
    const program = ts.createProgram([entry], {
        strict: true, noUncheckedIndexedAccess: true, noUnusedLocals: true, noUnusedParameters: true,
        noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        types: ['node'], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
        paths: { '@imwyvern/agent-guard/workers': [adapter] },
    });
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
});

it('WT-3: supplies only empty secret placeholders, ignores local state and tracks no .dev.vars anywhere', () => {
    const bindings = read('.dev.vars.example').trim().split('\n');
    expect(bindings).toEqual(['AG_CANARY_SECRET=', 'AG_PROJECT_SEED=']);
    const ignore = read('.gitignore').split('\n');
    for (const pattern of ['.dev.vars', '.wrangler/', 'node_modules/']) expect(ignore).toContain(pattern);
    for (const path of ['.dev.vars', '.wrangler/state.json', 'node_modules/example/index.js'])
        expect(spawnSync('git', ['check-ignore', resolve(template, path)], { cwd: root }).status).toBe(0);
    const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    expect(tracked.status, tracked.stderr).toBe(0);
    expect(tracked.stdout.split('\0').filter(path => path.split('/').at(-1) === '.dev.vars')).toEqual([]);
});

it('WT-4: runs the locally bundled template in Miniflare: host pass-through, noindex decoy and real decoy_hit events', async context => {
    let tooling: [typeof import('esbuild'), typeof import('miniflare')];
    try { tooling = await Promise.all([import('esbuild'), import('miniflare')]); }
    catch (error) { context.skip(`WT-4 unavailable: local esbuild/miniflare could not load: ${String(error)}`); return; }
    const [{ build }, { Miniflare }] = tooling;
    const core = resolve(root, 'src/web/index.ts');
    const marker = 'WT-4-EVENT ';
    // fromEnv has no event-sink option. Observe the real core's onEvent callback
    // only in this test bundle; keep the template and its adapter unchanged.
    const bundle = await build({
        entryPoints: [entry], bundle: true, platform: 'neutral', format: 'esm', target: 'es2022', write: false,
        alias: { '@imwyvern/agent-guard/workers': adapter },
        plugins: [{ name: 'observe-template-events', setup(builder) {
            builder.onResolve({ filter: /^\.\.\/web\/index\.js$/ }, args =>
                args.importer === adapter ? { path: 'observed-core', namespace: 'wt-observer' } : undefined);
            builder.onLoad({ filter: /.*/, namespace: 'wt-observer' }, () => ({
                contents: `import { createWebGuard as create } from ${JSON.stringify(core)};
                    export function createWebGuard(config) {
                        return create({ ...config, onEvent: event => console.log(${JSON.stringify(marker)} + JSON.stringify(event)) });
                    }`,
                loader: 'js', resolveDir: root,
            }));
        } }],
    });
    const events: AgentGuardEvent[] = [];
    let output = '';
    let mf: InstanceType<typeof Miniflare> | undefined;
    let outbound = 0;
    try {
        try {
            mf = new Miniflare({
                modules: true, script: bundle.outputFiles[0]!.text,
                compatibilityDate: String(config().compatibility_date), host: '127.0.0.1', cf: false,
                bindings: { AG_CANARY_SECRET: 'local-test-only-secret', AG_PROJECT_SEED: 'local-test-only-seed' },
                outboundService: () => { outbound++; throw new Error('WT-4 forbids outbound requests'); },
                handleRuntimeStdio(stdout: Readable, stderr: Readable) {
                    stdout.setEncoding('utf8'); stderr.setEncoding('utf8');
                    stdout.on('data', (chunk: string) => { output += chunk; });
                    stderr.on('data', (chunk: string) => { output += chunk; });
                },
            });
            await mf.ready;
        } catch (error) {
            context.skip(`WT-4 unavailable: local workerd could not start: ${String(error)}`); return;
        }
        const home = await mf.dispatchFetch('http://127.0.0.1/');
        expect(home.status).toBe(200);
        expect(home.headers.get('x-robots-tag')).toBeNull();
        expect(await home.text()).toBe('Hello from the Workers template.\n');
        for (let i = 0; i < 2; i++) {
            const decoy = await mf.dispatchFetch('http://127.0.0.1/.env', {
                headers: { 'CF-Connecting-IP': '192.0.2.10', 'User-Agent': 'local-template-test' },
            });
            expect(decoy.status).toBe(200);
            expect(decoy.headers.get('x-robots-tag')).toContain('noindex');
            expect(decoy.headers.get('cache-control')).toBe('no-store');
            expect(await decoy.text()).toContain('AG-CANARY-');
        }
        await expect.poll(() => output.split('\n').filter(line => line.startsWith(marker)).length).toBe(2);
        for (const line of output.split('\n').filter(line => line.startsWith(marker)))
            events.push(JSON.parse(line.slice(marker.length)) as AgentGuardEvent);
        expect(events).toHaveLength(2);
        for (const event of events) expect(event).toMatchObject({
            event: 'decoy_hit', req: { path: '/.env', ip: '192.0.2.10' }, decoy: { id: 'D1', status: 200 },
        });
        // A single creation warning across three requests also checks isolate reuse.
        expect(output.match(/off until a StateStore is provided/g)).toHaveLength(1);
        expect(outbound).toBe(0);
    } finally { await mf?.dispose(); }
}, 30000);

it('WT-5: keeps the package files allowlist unchanged and excludes deploy/ from an offline dry-run pack', () => {
    const packagePath = resolve(root, 'package.json');
    const before = readFileSync(packagePath, 'utf8');
    const manifest = JSON.parse(before) as { files: string[]; dependencies?: Record<string, string> };
    expect(manifest.files).toEqual(['dist', 'schema', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE']);
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
    const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--offline', '--ignore-scripts'], {
        cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' },
    });
    expect(packed.error, packed.stderr).toBeUndefined();
    expect(packed.status, packed.stderr).toBe(0);
    const packs = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
    expect(packs).toHaveLength(1);
    const paths = packs[0]!.files.map(file => file.path);
    expect(paths).toContain('dist/workers.js');
    expect(paths.filter(path => path.startsWith('deploy/'))).toEqual([]);
    expect(paths.filter(path => path.split('/').at(-1) === '.dev.vars')).toEqual([]);
    expect(readFileSync(packagePath, 'utf8')).toBe(before);
}, 35000);

it('documents local operation, secret injection and degradation with resolving relative links', () => {
    const readme = read('README.md');
    for (const text of ['wrangler dev --local', 'wrangler secret put AG_CANARY_SECRET', 'wrangler secret put AG_PROJECT_SEED',
        'not a dependency', 'not published', 'not deploy or publish a Worker', 'StateStore', 'CF-Connecting-IP', 'noindex', 'inert',
        'npm run build', 'build the example\'s']) expect(readme).toContain(text);
    for (const match of readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const [path, fragment] = match[1]!.split('#');
        const target = resolve(template, path!);
        expect(existsSync(target), match[1]).toBe(true);
        if (fragment) {
            const headings = [...readFileSync(target, 'utf8').matchAll(/^#+ (.+)$/gm)].map(heading =>
                heading[1]!.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-'));
            expect(headings, match[1]).toContain(fragment);
        }
    }
});
