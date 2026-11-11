import { dirname, isAbsolute, relative, sep } from 'node:path';
import { DEFAULT_PREFIX } from '../canary/format.js';
import { loadRegistry } from '../canary/registry.js';
import { validateConfig } from '../config.js';
import { alphabet } from '../core/ulid-core.js';
import type { CanaryRegistry } from '../types.js';
import { SeedError } from '../seed/errors.js';
import { buildSeedPlan, contentHash, profiles, seedManifest, type SeedInputs, type SeedManifest, type SeedProfile } from '../seed/plan.js';
import { absolutePath, checkDirectories, checkTarget, createHoneyfile, destination, readRegularFile, seedRoot, statPath, writeMetadata } from '../seed/paths.js';

export const SEED_USAGE = 'agent-guard seed --profile <node|python|k8s|generic> --dir <path> --seed-file <path> [--env <name>] [--write | --verify] [--callback-base <https-url>] [--registry <file>] [--manifest <file>]';

function parseOptions(args: string[]): Map<string, string> {
    const values = new Set(['profile', 'dir', 'seed-file', 'callback-base', 'registry', 'env', 'manifest']);
    const flags = new Set(['write', 'verify']), options = new Map<string, string>();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!, key = arg.slice(2);
        if (!arg.startsWith('--') || options.has(key) || (!flags.has(key) && !values.has(key))) throw new SeedError(SEED_USAGE);
        if (flags.has(key)) options.set(key, 'true');
        else {
            const value = args[++i];
            if (!value?.trim() || value.startsWith('--')) throw new SeedError(SEED_USAGE);
            options.set(key, value);
        }
    }
    if (options.has('write') && options.has('verify')) throw new SeedError('seed --write and --verify are mutually exclusive');
    return options;
}

function within(root: string, path: string): boolean {
    const rel = relative(root, path);
    return !isAbsolute(rel) && !rel.split(sep).includes('..');
}

function readManifest(path: string, input: Pick<SeedInputs, 'profile' | 'callbackBase'> & { env?: string }, root: string): SeedManifest {
    const value = JSON.parse(readRegularFile(path).toString('utf8')) as SeedManifest;
    const expected = profiles[input.profile];
    if (value?.version !== 1 || value.profile !== input.profile || typeof value.env !== 'string' || !value.env.trim() ||
        (input.env !== undefined && value.env !== input.env) ||
        value.callbackHost !== (input.callbackBase ? new URL(input.callbackBase).hostname : undefined) ||
        !Array.isArray(value.files) || value.files.length !== expected.length)
        throw new SeedError('seed manifest does not match the supplied profile, env or callback host');
    const paths = new Set<string>();
    for (const file of value.files) {
        if (!file || typeof file.path !== 'string') throw new SeedError('invalid seed manifest file');
        destination(root, file.path);
        if (!(expected as readonly string[]).includes(file.path) || paths.has(file.path) || file.mode !== '0600' ||
            typeof file.canaryId !== 'string' || file.canaryId.length !== 12 || ![...file.canaryId].every(char => alphabet.includes(char)) ||
            typeof file.sha256 !== 'string' || file.sha256.length !== 64 || ![...file.sha256].every(char => '0123456789abcdef'.includes(char)))
            throw new SeedError('invalid seed manifest file');
        paths.add(file.path);
    }
    return value;
}

function verify(root: string, manifest: SeedManifest, files: ReturnType<typeof buildSeedPlan>, out: (s: string) => void): number {
    // Validate recomputation before inspecting disk, so missing/wrong inputs are
    // usage errors rather than misleading inventory findings.
    for (const file of files) {
        const recorded = manifest.files.find(item => item.path === file.path)!;
        if (recorded.canaryId !== file.entry.id || recorded.sha256 !== contentHash(file.body))
            throw new SeedError('seed inputs do not reproduce the manifest; check seed-file, secret, callback-base and registry');
    }
    let findings = 0;
    for (const file of files) {
        const target = destination(root, file.path);
        try {
            if (!checkDirectories(dirname(target), false, true) || !statPath(target)) {
                out(`missing: ${file.path}`); findings++; continue;
            }
        } catch (error) {
            if (!(error instanceof SeedError)) throw error;
            out(`modified: ${file.path} (unsafe directory)`); findings++; continue;
        }
        const stat = statPath(target)!;
        if (stat.isSymbolicLink() || !stat.isFile()) {
            out(`modified: ${file.path} (not a regular file)`); findings++; continue;
        }
        if (!readRegularFile(target).equals(Buffer.from(file.body, 'utf8'))) { out(`modified: ${file.path}`); findings++; }
        if ((stat.mode & 0o7777) !== 0o600) { out(`mode: ${file.path} (expected 0600)`); findings++; }
    }
    if (!findings) out(`verified: ${files.length} files intact, mode 0600`);
    return findings ? 1 : 0;
}

export function runSeed(args: string[], out: (s: string) => void): number {
    try {
        const options = parseOptions(args);
        const writing = options.has('write'), verifying = options.has('verify');
        const profile = options.get('profile'), directory = options.get('dir'), seedFile = options.get('seed-file');
        const requestedEnv = options.get('env'), secret = process.env.AG_CANARY_SECRET;
        if (!profile || !directory || !seedFile || !secret || (!verifying && !requestedEnv))
            throw new SeedError('seed requires --profile, --dir, --seed-file and AG_CANARY_SECRET; generation also requires --env');
        if (!Object.hasOwn(profiles, profile)) throw new SeedError('seed profile must be node, python, k8s or generic');
        const root = seedRoot(directory, writing), seedPath = absolutePath(seedFile);
        const registryPath = absolutePath(options.get('registry') ?? 'agent-guard.canaries.json');
        const manifestPath = absolutePath(options.get('manifest') ?? 'agent-guard.seed.json');
        if (!options.has('manifest') && within(root, manifestPath)) throw new SeedError('default seed manifest must be outside --dir; select an explicit --manifest');
        const metadata = [seedPath, registryPath, manifestPath];
        if (new Set(metadata).size !== metadata.length) throw new SeedError('seed-file, registry and manifest paths must be distinct');
        const targets = profiles[profile as SeedProfile].map(path => destination(root, path));
        if (metadata.some(path => within(path, root) || targets.some(target => within(path, target))))
            throw new SeedError('seed metadata paths must not conflict with honeyfile destinations');
        for (const path of metadata) checkTarget(path);
        const projectSeed = new TextDecoder('utf-8', { fatal: true }).decode(readRegularFile(seedPath)).trim();
        if (!projectSeed) throw new SeedError('seed-file must contain a nonempty UTF-8 projectSeed');
        const callbackBase = options.get('callback-base');
        // Reuse the exact existing callback policy, including loopback HTTP.
        if (callbackBase) {
            try { validateConfig({ mode: 'detect', project: 'seed', env: requestedEnv ?? 'seed-verification', projectSeed, canary: { secret, registry: registryPath, callback: { baseUrl: callbackBase } } }); }
            catch { throw new SeedError('seed callback-base must be HTTPS without credentials, query or fragment (HTTP loopback allowed)'); }
        }
        const manifest = verifying ? readManifest(manifestPath, { profile: profile as SeedProfile, env: requestedEnv, callbackBase }, root) : undefined;
        const env = requestedEnv ?? manifest?.env;
        if (!env) throw new SeedError('seed generation requires --env');
        const registry: CanaryRegistry = statPath(registryPath)
            ? loadRegistry(JSON.parse(readRegularFile(registryPath).toString('utf8')) as CanaryRegistry)
            : { version: 1, prefix: DEFAULT_PREFIX, canaries: [] };
        const input: SeedInputs = { profile: profile as SeedProfile, env, secret, projectSeed, callbackBase, registry };
        const files = buildSeedPlan(input, verifying);
        if (manifest) return verify(root, manifest, files, out);
        // Preflight every intermediate directory before the first mutation.
        for (const target of targets) checkDirectories(dirname(target), false, true);
        if (writing) {
            const updated = loadRegistry({ ...registry, canaries: [...registry.canaries, ...files.filter(file => !registry.canaries.includes(file.entry)).map(file => file.entry)] });
            checkDirectories(root, true);
            for (const file of files) {
                const target = destination(root, file.path);
                if (statPath(target) || !createHoneyfile(target, file.body)) out(`skip: ${file.path} left unchanged (existing path, including symlinks)`);
                else out(`created: ${file.path} 0600 id=${file.entry.id.slice(0, 6)}`);
            }
            writeMetadata(registryPath, updated);
            writeMetadata(manifestPath, seedManifest(input, files));
        } else {
            for (const file of files) out(`plan: ${file.path} 0600 ${file.body.split('\n').length - 1} lines id=${file.entry.id.slice(0, 6)}`);
        }
        return 0;
    } catch (error) {
        // Native fs/JSON errors can include input bytes or absolute paths. Keep
        // them private, even when a malformed registry happens to contain tokens.
        out(error instanceof SeedError ? error.message : 'seed: unable to read or validate inputs (usage or I/O error)');
        return 2;
    }
}
