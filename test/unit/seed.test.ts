import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCLI } from '../../src/cli/commands.js';
import { generateCanary, verifyCanary } from '../../src/canary/format.js';
import { DECOY_CAP_BYTES, lintSample } from '../../src/canary/lint-rules.js';
import { contentHash, profiles, type SeedManifest, type SeedProfile } from '../../src/seed/plan.js';
import { destination } from '../../src/seed/paths.js';
import type { CanaryRegistry } from '../../src/types.js';

const secret = 'seed-test-secret-not-a-credential', projectSeed = 'private-project-seed-unit-fixture';
interface Fixture { base: string; dir: string; seed: string; registry: string; manifest: string }
let fixture: Fixture;
function makeFixture(base: string): Fixture {
    mkdirSync(base, { recursive: true });
    const result = { base, dir: join(base, 'honeyfiles'), seed: join(base, 'seed.txt'), registry: join(base, 'registry.json'), manifest: join(base, 'manifest.json') };
    writeFileSync(result.seed, `  ${projectSeed}\n`);
    return result;
}
function args(profile: SeedProfile = 'node', extra: string[] = [], f = fixture): string[] {
    return ['seed', '--profile', profile, '--dir', f.dir, '--seed-file', f.seed, '--registry', f.registry, '--manifest', f.manifest, '--env', 'test', ...extra];
}
function run(argv: string[]): { code: number; output: string } {
    const lines: string[] = [];
    return { code: runCLI(argv, line => lines.push(line)), output: lines.join('\n') };
}
function registry(f = fixture): CanaryRegistry { return JSON.parse(readFileSync(f.registry, 'utf8')) as CanaryRegistry; }
function manifest(f = fixture): SeedManifest { return JSON.parse(readFileSync(f.manifest, 'utf8')) as SeedManifest; }
function bodies(profile: SeedProfile, f = fixture): string[] { return profiles[profile].map(path => readFileSync(join(f.dir, path), 'utf8')); }
function snapshot(root: string): unknown[] {
    const stat = lstatSync(root), details = [root, stat.mode, stat.mtimeMs];
    if (stat.isSymbolicLink()) return [...details, readlinkSync(root)];
    if (stat.isFile()) return [...details, contentHash(readFileSync(root))];
    return [...details, readdirSync(root).sort().map(name => snapshot(join(root, name)))];
}
function noSensitiveOutput(output: string, f = fixture): void {
    expect(output).not.toContain('AG-CANARY-');
    expect(output).not.toContain(projectSeed);
    expect(output).not.toContain(secret);
    if (existsSync(f.registry)) for (const entry of registry(f).canaries) expect(output).not.toContain(entry.token);
}
beforeEach(() => {
    fixture = makeFixture(mkdtempSync(join(tmpdir(), 'ag-seed-')));
    vi.stubEnv('AG_CANARY_SECRET', secret);
});
afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fixture.base, { recursive: true, force: true });
});

it.each(Object.keys(profiles) as SeedProfile[])('dry-run for %s prints the plan and writes nothing', profile => {
    mkdirSync(fixture.dir);
    const before = snapshot(fixture.base), result = run(args(profile));
    expect(result.code).toBe(0);
    expect(snapshot(fixture.base)).toEqual(before);
    expect(readdirSync(fixture.dir)).toEqual([]);
    expect(existsSync(fixture.registry)).toBe(false);
    expect(existsSync(fixture.manifest)).toBe(false);
    for (const path of profiles[profile]) {
        expect(result.output).toContain(`plan: ${path} 0600`);
    }
    expect(result.output.match(/\d+ lines id=[0-9A-HJKMNP-TV-Z]{6}\b/g)).toHaveLength(profiles[profile].length);
    noSensitiveOutput(result.output);
});

it.each(Object.keys(profiles) as SeedProfile[])('writes %s files, permissions, verifiable canaries and a token-free manifest', profile => {
    const result = run(args(profile, ['--write']));
    expect(result.code).toBe(0);
    expect(statSync(fixture.dir).mode & 0o7777).toBe(0o700);
    const data = registry(), inventory = manifest(), text = readFileSync(fixture.manifest, 'utf8');
    expect(data).toMatchObject({ version: 1, prefix: 'AG-CANARY-' });
    expect(data.canaries).toHaveLength(profiles[profile].length);
    expect(inventory).toMatchObject({ version: 1, profile, env: 'test' });
    expect(inventory.files).toHaveLength(profiles[profile].length);
    expect(statSync(fixture.registry).mode & 0o7777).toBe(0o600);
    expect(statSync(fixture.manifest).mode & 0o7777).toBe(0o600);
    for (const path of profiles[profile]) {
        const file = join(fixture.dir, path), body = readFileSync(file, 'utf8');
        expect(statSync(file).mode & 0o7777).toBe(0o600);
        expect(statSync(dirname(file)).mode & 0o7777).toBe(0o700);
        const entry = data.canaries.find(item => item.placement === `honeyfile:${profile}:${path}`)!;
        expect(entry.env).toBe('test');
        expect(entry.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
        expect(verifyCanary(entry.token, { secret })).toEqual({ valid: true, id: entry.id });
        expect(body).toContain(entry.token);
        expect(body.match(/AG-CANARY-[0-9A-HJKMNP-TV-Z]{12}-[0-9A-HJKMNP-TV-Z]{6}/g)).toEqual([entry.token]);
        expect(body).not.toContain(entry.createdAt);
        expect(text).not.toContain(entry.token);
        expect(inventory.files.find(item => item.path === path)).toEqual({ path, mode: '0600', canaryId: entry.id, sha256: contentHash(body) });
    }
    for (const sensitive of [projectSeed, secret, 'AG-CANARY-']) expect(text).not.toContain(sensitive);
    noSensitiveOutput(result.output);
});

it('is idempotent and only fills missing files, preserving registry and inventory', () => {
    expect(run(args('node', ['--write'])).code).toBe(0);
    for (const path of profiles.node) utimesSync(join(fixture.dir, path), 1000, 1000);
    const before = snapshot(fixture.base), entries = registry(), oldManifest = manifest();
    expect(run(args('node', ['--write'])).code).toBe(0);
    expect(snapshot(fixture.base)).toEqual(before);
    const missing = join(fixture.dir, '.aws/credentials');
    const expected = readFileSync(missing);
    unlinkSync(missing);
    const existing = profiles.node.filter(path => path !== '.aws/credentials').map(path => snapshot(join(fixture.dir, path)));
    const result = run(args('node', ['--write']));
    expect(result.code).toBe(0);
    expect(readFileSync(missing)).toEqual(expected);
    expect(profiles.node.filter(path => path !== '.aws/credentials').map(path => snapshot(join(fixture.dir, path)))).toEqual(existing);
    expect(registry()).toEqual(entries);
    expect(manifest()).toEqual(oldManifest);
    expect(result.output).toContain('created: .aws/credentials');
    expect(result.output).toContain('skip: .env.backup');
});

it('leaves pre-existing contents, mode and mtime unchanged and reports a skip', () => {
    mkdirSync(fixture.dir);
    const file = join(fixture.dir, '.env.backup');
    writeFileSync(file, 'operator-owned content\n', { mode: 0o644 });
    utimesSync(file, 1000, 1000);
    const before = snapshot(file), result = run(args('generic', ['--write']));
    expect(result.code).toBe(0);
    expect(snapshot(file)).toEqual(before);
    expect(result.output).toContain('skip: .env.backup left unchanged');
    expect(run(args('generic', ['--verify']))).toMatchObject({ code: 1 });
});

it('does not repair permissions on a pre-existing honeyfile', () => {
    expect(run(args('generic', ['--write'])).code).toBe(0);
    chmodSync(join(fixture.dir, '.env.backup'), 0o644);
    const before = snapshot(fixture.base);
    expect(run(args('generic', ['--write'])).code).toBe(0);
    expect(snapshot(fixture.base)).toEqual(before);
});

describe('path safety', () => {
    it.each(['../escape', '/escape', '.aws/../../escape', 'a/../escape', '.', '', 'a//b', 'a\\b', 'C:/escape', 'a\0b'])('rejects crafted destination %j', path => {
        const before = snapshot(fixture.base);
        expect(() => destination(fixture.dir, path)).toThrow();
        expect(snapshot(fixture.base)).toEqual(before);
    });

    it('rejects a parent traversal in --dir before resolving it', () => {
        const argv = args('node', ['--write']);
        argv[argv.indexOf('--dir') + 1] = join(fixture.base, 'parent') + '/../escape';
        const before = snapshot(fixture.base), result = run(argv);
        expect(result.code).toBe(2);
        expect(result.output).toContain('traversal');
        expect(snapshot(fixture.base)).toEqual(before);
    });

    it.each([false, true])('skips an existing symlink destination (dangling=%s)', dangling => {
        mkdirSync(fixture.dir);
        const outside = join(fixture.base, 'outside.txt');
        if (!dangling) writeFileSync(outside, 'outside contents');
        symlinkSync(outside, join(fixture.dir, '.env.backup'));
        const result = run(args('generic', ['--write']));
        expect(result.code).toBe(0);
        expect(result.output).toContain('skip: .env.backup');
        expect(lstatSync(join(fixture.dir, '.env.backup')).isSymbolicLink()).toBe(true);
        if (!dangling) expect(readFileSync(outside, 'utf8')).toBe('outside contents');
        else expect(existsSync(outside)).toBe(false);
    });

    it.each(['root', 'ancestor', 'intermediate'] as const)('rejects a symlink at the %s without any write', kind => {
        const outside = join(fixture.base, 'outside');
        mkdirSync(outside);
        const argv = args('node', ['--write']);
        if (kind === 'root') symlinkSync(outside, fixture.dir);
        if (kind === 'ancestor') {
            symlinkSync(outside, join(fixture.base, 'linked'));
            argv[argv.indexOf('--dir') + 1] = join(fixture.base, 'linked', 'missing');
        }
        if (kind === 'intermediate') {
            mkdirSync(fixture.dir);
            symlinkSync(outside, join(fixture.dir, '.aws'));
        }
        const before = snapshot(fixture.base), result = run(argv);
        expect(result.code).toBe(2);
        expect(result.output).toContain('symlink');
        expect(snapshot(fixture.base)).toEqual(before);
        expect(readdirSync(outside)).toEqual([]);
    });

    it.each(['registry', 'manifest'] as const)('rejects a symlinked %s without modifying its target', name => {
        const outside = join(fixture.base, 'outside.json');
        writeFileSync(outside, 'operator contents');
        symlinkSync(outside, fixture[name]);
        const before = snapshot(fixture.base);
        expect(run(args('node', ['--write'])).code).toBe(2);
        expect(snapshot(fixture.base)).toEqual(before);
    });

    it.each(['registry', 'manifest'] as const)('rejects %s collisions with a honeyfile before writing', name => {
        const argv = args('node', ['--write']);
        argv[argv.indexOf(`--${name}`) + 1] = join(fixture.dir, '.env.backup');
        const before = snapshot(fixture.base);
        expect(run(argv).code).toBe(2);
        expect(snapshot(fixture.base)).toEqual(before);
    });
});

it('produces identical bytes and ids in separate roots and changes them for a different seed', () => {
    const second = makeFixture(join(fixture.base, 'second')), different = makeFixture(join(fixture.base, 'different'));
    writeFileSync(different.seed, 'different project seed');
    expect(run(args('node', ['--write'])).code).toBe(0);
    expect(run(args('node', ['--write'], second)).code).toBe(0);
    expect(run(args('node', ['--write'], different)).code).toBe(0);
    expect(bodies('node', second)).toEqual(bodies('node'));
    expect(registry(second).canaries.map(entry => entry.id)).toEqual(registry().canaries.map(entry => entry.id));
    for (const [i, body] of bodies('node').entries()) {
        expect(bodies('node', different)[i]).not.toBe(body);
        expect(registry(different).canaries[i]!.id).not.toBe(registry().canaries[i]!.id);
    }
});

it('reuses an existing placement token and preserves unrelated registry entries', () => {
    const reused = { ...generateCanary({ secret }), env: 'test', placement: 'honeyfile:generic:.env.backup', createdAt: '2000-01-01T00:00:00.000Z' };
    const unrelated = { ...generateCanary({ secret }), env: 'other', placement: 'D1:token', createdAt: reused.createdAt };
    writeFileSync(fixture.registry, JSON.stringify({ version: 1, prefix: 'AG-CANARY-', canaries: [reused, unrelated] }));
    expect(run(args('generic', ['--write'])).code).toBe(0);
    expect(readFileSync(join(fixture.dir, '.env.backup'), 'utf8')).toContain(reused.token);
    expect(registry().canaries).toHaveLength(3);
    expect(registry().canaries.slice(0, 2)).toEqual([reused, unrelated]);
    expect(run(args('generic', ['--verify'])).code).toBe(0);
});

it('keeps canaries for distinct environments separate in a shared registry', () => {
    expect(run(args('generic', ['--write'])).code).toBe(0);
    const second = makeFixture(join(fixture.base, 'second')), argv = args('generic', ['--write'], second);
    argv[argv.indexOf('--env') + 1] = 'other';
    argv[argv.indexOf('--registry') + 1] = fixture.registry;
    expect(run(argv).code).toBe(0);
    const entries = registry().canaries;
    expect(entries).toHaveLength(4);
    expect(entries.filter(entry => entry.env === 'test')).toHaveLength(2);
    expect(entries.filter(entry => entry.env === 'other')).toHaveLength(2);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(4);
    expect(bodies('generic', second)).not.toEqual(bodies('generic'));
});

it.each(['wrong-secret', 'duplicate-placement', 'wrong-prefix'] as const)('refuses an incompatible registry (%s) before writing', kind => {
    const entry = { ...generateCanary({ secret: kind === 'wrong-secret' ? 'other secret' : secret }), env: 'test', placement: 'honeyfile:generic:.env.backup', createdAt: '2000-01-01T00:00:00.000Z' };
    const canaries = [entry];
    if (kind === 'duplicate-placement') canaries.push({ ...entry, ...generateCanary({ secret }) });
    writeFileSync(fixture.registry, JSON.stringify({ version: 1, prefix: kind === 'wrong-prefix' ? 'TEST-CANARY-' : 'AG-CANARY-', canaries }));
    const before = snapshot(fixture.base), result = run(args('generic', ['--write']));
    expect(result.code).toBe(2);
    expect(snapshot(fixture.base)).toEqual(before);
    noSensitiveOutput(result.output);
});

for (const profile of Object.keys(profiles) as SeedProfile[]) {
    it.each([undefined, 'https://honeycb.example', 'https://callbacks.operator.test/prefix/'])(`${profile} stays inert with callback %s`, callback => {
        const extra = callback ? ['--callback-base', callback] : [];
        expect(run(args(profile, ['--write', ...extra])).code).toBe(0);
        const allowedHosts = callback ? [new URL(callback).hostname] : [];
        for (const [i, body] of bodies(profile).entries()) {
            expect(lintSample({ name: profiles[profile][i]!, body, capBytes: DECOY_CAP_BYTES, allowedHosts })).toEqual([]);
            expect(body).not.toMatch(/(?:AKIA|ASIA|ghp_|github_pat_|sk-|xox[bpas]-|AIza|eyJ|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----)/);
            expect(body).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/u);
            if (callback) expect(body).toContain(callback);
        }
        if (callback) expect(manifest().callbackHost).toBe(new URL(callback).hostname);
        else expect(manifest()).not.toHaveProperty('callbackHost');
        expect(run(args(profile, ['--verify', ...extra])).code).toBe(0);
    });
}

it.each(['node', 'k8s'] as const)('creates an SSH-style placeholder for %s that is never a real key', profile => {
    expect(run(args(profile, ['--write'])).code).toBe(0);
    const path = join(fixture.dir, '.ssh/id_rsa'), body = readFileSync(path, 'utf8');
    expect(body).toContain('not a real key');
    expect(body).not.toMatch(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/);
    expect(body).not.toContain('openssh-key-v1');
    expect(() => createPrivateKey(body)).toThrow();
    const parsed = spawnSync('ssh-keygen', ['-y', '-P', '', '-f', path], { encoding: 'utf8', timeout: 3000, env: { PATH: process.env.PATH } });
    if ((parsed.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        expect(parsed.error).toBeUndefined();
        expect(parsed.status).not.toBe(0);
        expect(parsed.stdout).toBe('');
    }
});

describe('verification', () => {
    beforeEach(() => { expect(run(args('node', ['--write'])).code).toBe(0); });

    it('is read-only when the inventory is intact', () => {
        const before = snapshot(fixture.base), result = run(args('node', ['--verify']));
        expect(result.code).toBe(0);
        expect(result.output).toContain('verified: 4 files intact');
        expect(snapshot(fixture.base)).toEqual(before);
        noSensitiveOutput(result.output);
    });

    it.each(['missing', 'modified', 'mode'] as const)('reports %s as an inventory finding without repairing or writing', finding => {
        const path = join(fixture.dir, '.env.backup');
        if (finding === 'missing') unlinkSync(path);
        if (finding === 'modified') writeFileSync(path, readFileSync(path, 'utf8').replace('Synthetic', 'Edited'));
        if (finding === 'mode') chmodSync(path, 0o644);
        const before = snapshot(fixture.base), result = run(args('node', ['--verify']));
        expect(result.code).toBe(1);
        expect(result.output).toContain(`${finding}: .env.backup`);
        expect(result.output).not.toMatch(/alert|"event"/i);
        expect(snapshot(fixture.base)).toEqual(before);
        noSensitiveOutput(result.output);
    });

    it('reports multiple findings together, including missing intermediate directories', () => {
        rmSync(join(fixture.dir, '.ssh'), { recursive: true });
        writeFileSync(join(fixture.dir, '.npmrc'), 'changed\n');
        chmodSync(join(fixture.dir, '.env.backup'), 0o644);
        const before = snapshot(fixture.base), result = run(args('node', ['--verify']));
        expect(result.code).toBe(1);
        expect(result.output).toContain('missing: .ssh/id_rsa');
        expect(result.output).toContain('modified: .npmrc');
        expect(result.output).toContain('mode: .env.backup');
        expect(snapshot(fixture.base)).toEqual(before);
    });

    it.each(['file', 'directory'] as const)('does not follow a symlink substituted for a %s', kind => {
        const outside = join(fixture.base, 'outside');
        if (kind === 'file') {
            writeFileSync(outside, 'outside');
            unlinkSync(join(fixture.dir, '.env.backup'));
            symlinkSync(outside, join(fixture.dir, '.env.backup'));
        } else {
            mkdirSync(outside);
            rmSync(join(fixture.dir, '.ssh'), { recursive: true });
            symlinkSync(outside, join(fixture.dir, '.ssh'));
        }
        const before = snapshot(fixture.base), result = run(args('node', ['--verify']));
        expect(result.code).toBe(1);
        expect(result.output).toContain('modified:');
        expect(snapshot(fixture.base)).toEqual(before);
    });

    it.each(['seed', 'secret', 'registry', 'manifest', 'env', 'profile'] as const)('returns usage/IO error when required %s input is missing or mismatched', input => {
        const argv = args('node', ['--verify']);
        if (input === 'seed') writeFileSync(fixture.seed, 'different seed');
        if (input === 'secret') vi.stubEnv('AG_CANARY_SECRET', 'wrong secret');
        if (input === 'registry') unlinkSync(fixture.registry);
        if (input === 'manifest') unlinkSync(fixture.manifest);
        if (input === 'env') argv[argv.indexOf('--env') + 1] = 'other';
        if (input === 'profile') argv[argv.indexOf('--profile') + 1] = 'python';
        const before = snapshot(fixture.base), result = run(argv);
        expect(result.code).toBe(2);
        expect(snapshot(fixture.base)).toEqual(before);
        noSensitiveOutput(result.output);
    });

    it('reads env from the manifest when verification omits --env', () => {
        const argv = args('node', ['--verify']);
        argv.splice(argv.indexOf('--env'), 2);
        const before = snapshot(fixture.base);
        expect(run(argv).code).toBe(0);
        expect(snapshot(fixture.base)).toEqual(before);
    });

    it('requires seed-file and secret to recompute verification bytes', () => {
        const argv = args('node', ['--verify']);
        argv.splice(argv.indexOf('--seed-file'), 2);
        expect(run(argv).code).toBe(2);
        vi.stubEnv('AG_CANARY_SECRET', '');
        expect(run(args('node', ['--verify'])).code).toBe(2);
    });

    it('requires the original callback base, including its path, for verification', () => {
        const second = makeFixture(join(fixture.base, 'callbacks'));
        const callback = 'https://honeycb.example/prefix/';
        expect(run(args('generic', ['--write', '--callback-base', callback], second)).code).toBe(0);
        for (const extra of [[], ['--callback-base', 'https://honeycb.example/other/']]) {
            const before = snapshot(fixture.base);
            expect(run(args('generic', ['--verify', ...extra], second)).code).toBe(2);
            expect(snapshot(fixture.base)).toEqual(before);
        }
    });

    it.each(['../outside', '/outside', '.aws/../../outside'])('rejects a manifest path escape %j without reading or writing it', path => {
        const inventory = manifest();
        inventory.files[0]!.path = path;
        writeFileSync(fixture.manifest, JSON.stringify(inventory));
        const before = snapshot(fixture.base), result = run(args('node', ['--verify']));
        expect(result.code).toBe(2);
        expect(result.output).toContain('relative path');
        expect(snapshot(fixture.base)).toEqual(before);
    });
});

describe('usage and defaults', () => {
    it.each(['--profile', '--dir', '--seed-file', '--env'])('requires %s', key => {
        const argv = args('generic', ['--write']);
        argv.splice(argv.indexOf(key), 2);
        const before = snapshot(fixture.base), result = run(argv);
        expect(result.code).toBe(2);
        expect(snapshot(fixture.base)).toEqual(before);
        noSensitiveOutput(result.output);
    });

    it('requires AG_CANARY_SECRET', () => {
        vi.stubEnv('AG_CANARY_SECRET', '');
        const result = run(args('generic', ['--write']));
        expect(result.code).toBe(2);
        expect(result.output).toContain('AG_CANARY_SECRET');
        expect(existsSync(fixture.dir)).toBe(false);
    });

    it.each(['unknown', '__proto__', 'constructor'])('rejects unknown profile %s', profile => {
        const argv = args('generic', ['--write']);
        argv[argv.indexOf('--profile') + 1] = profile;
        expect(run(argv).code).toBe(2);
        expect(existsSync(fixture.dir)).toBe(false);
    });

    it.each(['', '   \n\t'])('rejects an empty seed file %j', seed => {
        writeFileSync(fixture.seed, seed);
        expect(run(args('generic', ['--write'])).code).toBe(2);
        expect(existsSync(fixture.dir)).toBe(false);
    });

    it('rejects invalid UTF-8 seed bytes', () => {
        writeFileSync(fixture.seed, Buffer.from([0xc3, 0x28]));
        expect(run(args('generic', ['--write'])).code).toBe(2);
    });

    it('requires an existing directory for dry-run', () => {
        expect(run(args('generic')).code).toBe(2);
        expect(existsSync(fixture.dir)).toBe(false);
    });

    it.each([['--write', '--verify'], ['--unknown'], ['--dir'], ['--profile', 'node'], ['positional'], ['--write', '--write']])('rejects invalid options %j', (...extra) => {
        expect(run(args('node', extra)).code).toBe(2);
        expect(existsSync(fixture.dir)).toBe(false);
    });

    it.each(['http://remote.example', 'ftp://honeycb.example', 'https://user:password@honeycb.example', 'https://@honeycb.example', 'https://honeycb.example?x', 'https://honeycb.example#fragment', 'https://honeycb.example/\nhidden'])('rejects an unsafe callback base %j', callback => {
        const before = snapshot(fixture.base), result = run(args('generic', ['--write', '--callback-base', callback]));
        expect(result.code).toBe(2);
        expect(snapshot(fixture.base)).toEqual(before);
        expect(result.output).not.toContain(callback);
        noSensitiveOutput(result.output);
    });

    it.each(['http://127.0.0.1:1234', 'http://localhost:1234', 'http://[::1]:1234'])('reuses callback loopback policy for %s without networking', callback => {
        expect(run(args('generic', ['--write', '--callback-base', callback])).code).toBe(0);
        for (const body of bodies('generic')) expect(lintSample({ name: 'loopback', body, capBytes: DECOY_CAP_BYTES, allowedHosts: [new URL(callback).hostname] })).toEqual([]);
        expect(run(args('generic', ['--verify', '--callback-base', callback])).code).toBe(0);
    });

    it('uses cwd registry and manifest defaults, without writing on dry-run', () => {
        vi.spyOn(process, 'cwd').mockReturnValue(fixture.base);
        mkdirSync(fixture.dir);
        const argv = args('generic');
        argv.splice(argv.indexOf('--registry'), 2);
        argv.splice(argv.indexOf('--manifest'), 2);
        const before = snapshot(fixture.base);
        expect(run(argv).code).toBe(0);
        expect(snapshot(fixture.base)).toEqual(before);
        expect(run([...argv, '--write']).code).toBe(0);
        expect(existsSync(join(fixture.base, 'agent-guard.canaries.json'))).toBe(true);
        expect(existsSync(join(fixture.base, 'agent-guard.seed.json'))).toBe(true);
        expect(run([...argv, '--verify']).code).toBe(0);
    });

    it('creates nested root and metadata directories with private permissions', () => {
        const argv = args('generic', ['--write']);
        argv[argv.indexOf('--dir') + 1] = join(fixture.base, 'parent', 'nested', 'honeyfiles');
        argv[argv.indexOf('--manifest') + 1] = join(fixture.base, 'metadata', 'inventory', 'manifest.json');
        expect(run(argv).code).toBe(0);
        for (const path of ['parent', 'parent/nested', 'parent/nested/honeyfiles', 'metadata', 'metadata/inventory'])
            expect(statSync(join(fixture.base, path)).mode & 0o7777).toBe(0o700);
        expect(run([...argv.filter(arg => arg !== '--write'), '--verify']).code).toBe(0);
    });

    it('requires explicit placement of a manifest inside --dir', () => {
        vi.spyOn(process, 'cwd').mockReturnValue(fixture.dir);
        const argv = args('generic', ['--write']);
        argv.splice(argv.indexOf('--manifest'), 2);
        expect(run(argv).code).toBe(2);
        expect(existsSync(fixture.dir)).toBe(false);
        expect(run([...argv, '--manifest', join(fixture.dir, 'inventory.json')]).code).toBe(0);
        expect(existsSync(join(fixture.dir, 'inventory.json'))).toBe(true);
    });

    it('keeps malformed registry input and native error paths out of output', () => {
        writeFileSync(fixture.registry, `malformed ${secret} ${projectSeed} AG-CANARY-SENSITIVE`);
        const result = run(args('generic', ['--write']));
        expect(result.code).toBe(2);
        expect(result.output).not.toContain('AG-CANARY-');
        expect(result.output).not.toContain(secret);
        expect(result.output).not.toContain(projectSeed);
        expect(existsSync(fixture.dir)).toBe(false);
    });
});
