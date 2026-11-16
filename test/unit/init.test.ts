import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';
import { runCLI } from '../../src/cli/commands.js';
import { runInit } from '../../src/cli/init.js';
import { loadEntryConfig } from '../../src/cli/entry-config.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function project(inside = false) { const dir = mkdtempSync(join(inside ? process.cwd() : tmpdir(), 'ag-init-')); dirs.push(dir); return dir; }
it('DI-6: dry-run prints a unified diff and makes no filesystem changes', () => {
    const dir = project(), out: string[] = [];
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '*' } }));
    const before = readdirSync(dir), mtime = statSync(join(dir, 'package.json')).mtimeMs;
    expect(runCLI(['init', '--dir', dir], s => out.push(s))).toBe(0);
    expect(readdirSync(dir)).toEqual(before); expect(statSync(join(dir, 'package.json')).mtimeMs).toBe(mtime);
    expect(out.join('\n')).toContain('--- /dev/null\n+++ b/agent-guard.config.json');
    expect(out.join('\n')).toContain('agent-guard.setup.js'); expect(out.join('\n')).toContain('app.use(middleware)');
    expect(out.join('\n')).toContain('${AG_CANARY_SECRET}'); expect(out.join('\n')).not.toContain('.git/hooks');
});
it('writes the same diff before creating 0644 files and never overwrites existing files', () => {
    const dir = project(), dry: string[] = [], written: string[] = [];
    expect(runInit(['--dir', dir], s => dry.push(s))).toBe(0);
    expect(runInit(['--dir', dir, '--write'], s => written.push(s))).toBe(0);
    expect(written).toEqual(dry);
    const paths = ['agent-guard.config.json', 'agent-guard.setup.js'];
    for (const path of paths) expect(statSync(join(dir, path)).mode & 0o777).toBe(0o644);
    writeFileSync(join(dir, paths[0]!), 'operator config'); writeFileSync(join(dir, paths[1]!), 'operator setup');
    expect(runInit(['--dir', dir, '--write'], s => written.push(s))).toBe(0);
    expect(readFileSync(join(dir, paths[0]!), 'utf8')).toBe('operator config'); expect(readFileSync(join(dir, paths[1]!), 'utf8')).toBe('operator setup');
    expect(written.join('\n')).toContain('skip:');
});
it.each(['agent-guard.config.json', 'agent-guard.setup.js', 'package.json', 'tsconfig.json'])('rejects symlink %s before writing any files', path => {
    const dir = project(), outside = project(); writeFileSync(join(outside, 'target'), '{}');
    symlinkSync(join(outside, 'target'), join(dir, path));
    expect(runInit(['--dir', dir, '--write'], () => {})).toBe(2);
    expect(readdirSync(dir)).toEqual([path]); expect(readFileSync(join(outside, 'target'), 'utf8')).toBe('{}');
});
it('rejects parent traversal and symlink directory ancestors', () => {
    const dir = project(); mkdirSync(join(dir, 'real')); symlinkSync(join(dir, 'real'), join(dir, 'link'));
    expect(runInit(['--dir', join(dir, 'link'), '--write'], () => {})).toBe(2);
    expect(runInit(['--dir', dir + '/../escape', '--write'], () => {})).toBe(2);
    expect(runInit(['--dir', dir, '--framework', '../../escape', '--write'], () => {})).toBe(2);
});
it('lists multiple frameworks and requires an explicit selection', () => {
    const dir = project(), out: string[] = [];
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '*', fastify: '*' } }));
    expect(runInit(['--dir', dir], s => out.push(s))).toBe(2); expect(out.join('')).toContain('express, fastify');
    expect(runInit(['--dir', dir, '--framework', 'fastify'], () => {})).toBe(0);
});
it.each(['express', 'fastify', 'koa', 'hono', 'next', 'node'])('generates %s setup using the real adapter API', framework => {
    const dir = project(); writeFileSync(join(dir, 'tsconfig.json'), '{}');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: framework === 'node' ? {} : { [framework]: '*' } }));
    expect(runInit(['--dir', dir, '--write'], () => {})).toBe(0);
    const setup = readFileSync(join(dir, 'agent-guard.setup.ts'), 'utf8');
    expect(setup).toContain(framework === 'next' ? 'agentGuardMiddleware(guard)' : framework === 'node' ? 'agentGuardNode(guard)' : 'agentGuard(guard)');
    expect(setup).not.toContain('process.env.AG_CANARY_SECRET!');
});
it.each(['express', 'node'])('typechecks generated %s setup plus actual framework registration', framework => {
    const dir = project(true); writeFileSync(join(dir, 'tsconfig.json'), '{}');
    expect(runInit(['--dir', dir, '--framework', framework, '--write'], () => {})).toBe(0);
    const host = framework === 'express' ? "import express from 'express';\nconst app = express();\napp.use(middleware);\n" : "import { createServer } from 'node:http';\ncreateServer((req, res) => middleware(req, res, () => res.end('host')));\n";
    const path = join(dir, 'agent-guard.setup.ts'); writeFileSync(path, readFileSync(path, 'utf8') + host);
    const program = ts.createProgram([path], { strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
        typeRoots: [resolve('node_modules/@types')] });
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
});
it('rejects trap/block in entry config without weakening library validation', () => {
    const dir = project(), file = join(dir, 'config.json');
    for (const mode of ['trap', 'block']) {
        writeFileSync(file, JSON.stringify({ project: 'x', env: 'test', mode, projectSeed: 'seed', canary: { secret: 'test-secret', registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } } }));
        expect(() => loadEntryConfig(file)).toThrow();
    }
});
