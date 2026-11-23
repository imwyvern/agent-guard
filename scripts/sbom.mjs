import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../bench/results/sbom.json', import.meta.url);
const args = ['sbom', '--omit=dev', '--sbom-format=cyclonedx'];
// npm supplies its CLI path to npm run; direct node invocation uses PATH.
const result = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    : spawnSync('npm', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

try {
    if (result.error || result.status !== 0) {
        throw new Error('npm sbom is unavailable or failed; install npm 11 with SBOM support and dependencies (npm ci), then retry. Diagnose locally with: npm sbom --omit=dev --sbom-format=cyclonedx');
    }
    const document = JSON.parse(result.stdout);
    if (document.bomFormat !== 'CycloneDX' || !document.specVersion || !Array.isArray(document.components)) {
        throw new Error('npm sbom returned an invalid CycloneDX document');
    }
    mkdirSync(new URL('../bench/results/', import.meta.url), { recursive: true });
    writeFileSync(output, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
    console.log('Local CycloneDX SBOM written to bench/results/sbom.json (gitignored; not published)');
} catch (error) {
    // Do not echo npm output: diagnostics can contain local paths or bindings.
    console.error(error instanceof SyntaxError ? 'npm sbom returned invalid JSON' : error.message);
    process.exitCode = 1;
}
