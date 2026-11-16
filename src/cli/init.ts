import { closeSync, constants, fchmodSync, openSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { absolutePath, checkDirectories, checkTarget, destination, readRegularFile, statPath } from '../seed/paths.js';
import { entryConfig } from './entry-config.js';

export const INIT_USAGE = 'agent-guard init [--dir <project>] [--framework express|fastify|koa|hono|node|next] [--write]';
const frameworks = ['express', 'fastify', 'koa', 'hono', 'node', 'next'] as const;
type Framework = typeof frameworks[number];
export function setupSnippet(framework: Framework): string {
    const guard = `import { createAgentGuard } from '@imwyvern/agent-guard';

const secret = process.env.AG_CANARY_SECRET;
const projectSeed = process.env.AG_PROJECT_SEED;
if (!secret || !projectSeed) throw new Error('Set AG_CANARY_SECRET and AG_PROJECT_SEED');
export const guard = createAgentGuard({
  project: 'local-project', env: 'local', mode: 'detect', projectSeed,
  canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
});
`;
    if (framework === 'next') return `import { createWebGuard } from '@imwyvern/agent-guard/web';
import { agentGuardMiddleware } from '@imwyvern/agent-guard/next';

const secret = process.env.AG_CANARY_SECRET;
const projectSeed = process.env.AG_PROJECT_SEED;
if (!secret || !projectSeed) throw new Error('Set AG_CANARY_SECRET and AG_PROJECT_SEED');
const guard = createWebGuard({
  project: 'local-project', env: 'local', mode: 'detect', projectSeed,
  canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
});
export const middleware = agentGuardMiddleware(guard);
`;
    if (framework === 'node') return `import { agentGuardNode } from '@imwyvern/agent-guard/node';\n${guard}\nexport const middleware = agentGuardNode(guard);\n`;
    return `import { agentGuard } from '@imwyvern/agent-guard/${framework}';\n${guard}\nexport const middleware = agentGuard(guard);\n`;
}
export function runInit(args: string[], out: (line: string) => void): number {
    try {
        const options = new Map<string, string>();
        for (let i = 0; i < args.length; i++) {
            const key = args[i]!;
            if (!['--dir', '--framework', '--write'].includes(key) || options.has(key)) throw new Error();
            if (key === '--write') options.set(key, 'true');
            else {
                const value = args[++i];
                if (!value || value.startsWith('--')) throw new Error();
                options.set(key, value);
            }
        }
        const root = absolutePath(options.get('--dir') ?? '.');
        checkDirectories(root);
        const packagePath = resolve(root, 'package.json');
        checkTarget(packagePath);
        const pkg = statPath(packagePath) ? JSON.parse(readRegularFile(packagePath).toString('utf8')) as { type?: string; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> } : {};
        const detected = frameworks.filter(name => name !== 'node' && Object.hasOwn({ ...pkg.dependencies, ...pkg.devDependencies }, name));
        let framework = options.get('--framework') as Framework | undefined;
        if (framework && !frameworks.includes(framework)) throw new Error();
        if (!framework && detected.length > 1) { out('Multiple frameworks: ' + detected.join(', ') + '. Select --framework.'); return 2; }
        framework ??= detected[0] ?? 'node';
        const tsconfig = resolve(root, 'tsconfig.json');
        checkTarget(tsconfig);
        const typescript = !!statPath(tsconfig), file = `agent-guard.setup.${typescript ? 'ts' : 'js'}`;
        const commonjs = !typescript && pkg.type !== 'module' && framework !== 'next';
        let setup = setupSnippet(framework);
        if (commonjs) setup = setup.replace(/import \{ ([^}]+) \} from '([^']+)';/g, "const { $1 } = require('$2');")
            .replaceAll('export const ', 'const ') + '\nmodule.exports = { guard, middleware };\n';
        const planned = [
            { path: 'agent-guard.config.json', body: JSON.stringify(entryConfig(), null, 2) + '\n' },
            { path: file, body: setup },
        ];
        // Preflight every target before any write, including existing symlinks.
        for (const item of planned) checkTarget(destination(root, item.path));
        for (const item of planned) {
            const target = destination(root, item.path);
            if (statPath(target)) { out(`skip: ${item.path} already exists`); continue; }
            const lines = item.body.trimEnd().split('\n');
            out(`diff --git a/${item.path} b/${item.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${item.path}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => '+' + line).join('\n'));
        }
        if (options.has('--write')) for (const item of planned) {
            const target = destination(root, item.path);
            checkTarget(target);
            let fd: number;
            try { fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
            try { fchmodSync(fd, 0o644); writeFileSync(fd, item.body); } finally { closeSync(fd); }
        }
        out(`Framework: ${framework}. Set AG_CANARY_SECRET and AG_PROJECT_SEED through your environment. The setup exports an example guard; customize it and keep agent-guard.config.json in sync.`);
        const registration = framework === 'node' ? 'middleware(req, res, () => hostHandler(req, res));' : framework === 'fastify' ? 'await app.register(middleware);' : framework === 'next' ? 'export { middleware };' : framework === 'hono' ? "app.use('*', middleware);" : 'app.use(middleware);';
        const localFile = file.replace(/\.ts$/, '.js');
        const inclusion = commonjs ? `const { middleware } = require('./${localFile}');` : `import { middleware } from './${localFile}';`;
        out(`Add these two lines at your entry point (after bounded body parsing where applicable):\n${inclusion}\n${registration}`);
        out('Optional pre-commit hook example (install manually): node /absolute/path/to/agent-guard/dist/cli/main.js canary scan ./config');
        return 0;
    } catch { out('init: invalid options or unsafe project paths\n' + INIT_USAGE); return 2; }
}
