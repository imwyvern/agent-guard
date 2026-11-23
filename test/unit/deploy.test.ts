import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const read = (file: string) => readFileSync(file, 'utf8');
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('DI-8a: pins Node slim stages, keeps runtime files root-owned and runs only the detect proxy as a non-root UID', () => {
    const instructions = read('deploy/Dockerfile').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    const bases = instructions.filter(line => /^FROM /i.test(line));
    expect(bases).toHaveLength(2);
    for (const base of bases) expect(base).toMatch(/^FROM node:20\.\d+-slim AS \w+$/);
    const final = instructions.slice(instructions.lastIndexOf(bases.at(-1)!));
    expect(final.filter(line => /^USER /i.test(line))).toEqual(['USER 65532:65532']);
    expect(final.filter(line => /^COPY /i.test(line))).toEqual([
        'COPY --from=build /app/dist ./dist', 'COPY --from=build /app/package.json ./package.json',
    ]);
    expect(final.some(line => /^RUN /i.test(line))).toBe(false);
    for (const line of instructions) {
        if (/^(COPY|ADD) /i.test(line)) expect(line).not.toMatch(/(?:^|[\s/"'])\.env(?:[\s/"']|$)|\s\.\s/);
        if (/^(ENV|ARG) /i.test(line)) expect(line).not.toMatch(/(?:SECRET|TOKEN|PASSWORD|PROJECT_SEED)\s*(?:=|\s)\s*\S/i);
    }
    const entrypoint = JSON.parse(final.find(line => line.startsWith('ENTRYPOINT '))!.slice('ENTRYPOINT '.length)) as string[];
    expect(entrypoint).toEqual(['node', 'dist/cli/main.js', 'proxy', '--listen', '0.0.0.0:8080', '--allow-public-bind']);
    expect(instructions.join('\n')).not.toContain('--init-secrets');
    expect(instructions.join('\n')).not.toMatch(/:latest|--mode|--upstream/);
});

it('DI-8b: parses all Compose services for hardening, private ports and an internal fixed upstream', () => {
    const compose = read('deploy/compose.yaml').replace(/^\s*#.*$/gm, '');
    // Parse the deliberately small template's top-level service mappings and
    // JSON-compatible inline lists, without a runtime or YAML dependency.
    const services = [...compose.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:|^\S|$(?![\s\S]))/gm)];
    const serviceMap = new Map(services.filter(match => match[1] !== 'internal').map(match => [match[1]!, match[2]!]));
    expect([...serviceMap.keys()]).toEqual(['guard', 'upstream']);
    for (const service of serviceMap.values()) {
        expect(service).toMatch(/^    read_only: true$/m);
        expect(service).toMatch(/^    cap_drop: \[ALL\]$/m);
        expect(service).toMatch(/^    security_opt: \["no-new-privileges:true"\]$/m);
        expect(service).not.toMatch(/privileged:\s*true/);
        expect(service).toMatch(/^    user: "65532:65532"$/m);
        expect(service).toMatch(/^    networks: \[internal\]$/m);
        expect(service).not.toMatch(/^    volumes:/m);
        for (const ports of service.matchAll(/^    ports: (\[.*\])$/gm)) {
            for (const port of JSON.parse(ports[1]!) as string[]) expect(port).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
        }
    }
    const guard = serviceMap.get('guard')!;
    expect(guard).toContain('ports: ["127.0.0.1:8080:8080"]');
    expect(guard).toContain('env_file: .env');
    expect(guard).toContain('command: ["--upstream", "http://upstream:3000"]');
    expect(serviceMap.get('upstream')).not.toContain('ports:');
    expect(compose).toMatch(/^networks:\n  internal:\n    internal: true$/m);
    expect(compose).not.toMatch(/--init-secrets|--mode|privileged:\s*true/);
});

it('DI-8c: excludes secrets, git, modules, tests and benchmark results from the actual root build context', () => {
    const ignore = read('deploy/.dockerignore').split('\n');
    for (const pattern of ['.env', '**/.env', '**/*.pem', '.git', 'node_modules', 'test', 'bench']) expect(ignore).toContain(pattern);
    expect(read('.dockerignore')).toBe(read('deploy/.dockerignore'));
    const bindings = read('deploy/.env.example').trim().split('\n');
    for (const binding of bindings) expect(binding).toMatch(/^[A-Z_]+=$/);
    for (const name of ['AG_CANARY_SECRET', 'AG_PROJECT_SEED', 'AG_WEBHOOK_SECRET']) expect(bindings).toContain(`${name}=`);
    expect(spawnSync('git', ['check-ignore', 'deploy/.env'], { encoding: 'utf8' }).status).toBe(0);
});

it.each(['nginx.conf.example', 'Caddyfile.example', 'traefik.yaml.example'])('DI-8d: %s terminates TLS and routes to loopback without private key material or crawler/header rewriting', file => {
    const fragment = read(`deploy/${file}`);
    expect(fragment).toContain('127.0.0.1:8080');
    expect(fragment).toContain('example.com');
    expect(fragment).toMatch(/443|tls|TLS/);
    expect(fragment).toContain('noindex / robots');
    expect(fragment).toContain('Guard handles verified-crawler exemptions');
    expect(fragment).not.toMatch(/-----BEGIN .*PRIVATE KEY-----|dashboard:\s*true|api:\s*insecure/);
    expect(fragment).not.toMatch(/proxy_hide_header|header_down\s+-|customResponseHeaders/);
    expect(fragment).not.toMatch(/(?:admin|dashboard|api).*0\.0\.0\.0/);
});

it('DI-8e: generates a nonempty local CycloneDX document in a gitignored directory without copying environment secrets', () => {
    const marker = 'sbom-test-only-environment-marker';
    const result = spawnSync(process.execPath, ['scripts/sbom.mjs'], {
        encoding: 'utf8', timeout: 30000,
        env: { ...process.env, AG_CANARY_SECRET: marker, AG_PROJECT_SEED: marker, AG_WEBHOOK_SECRET: marker },
    });
    // An unavailable npm SBOM subcommand must fail explicitly, never fake output.
    if (result.status !== 0) {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('npm sbom is unavailable or failed');
        expect(result.stderr).toContain('npm 11');
        return;
    }
    const path = 'bench/results/sbom.json';
    expect(statSync(path).size).toBeGreaterThan(0);
    const source = read(path);
    expect(source).not.toContain(marker);
    expect(JSON.parse(source)).toMatchObject({ bomFormat: 'CycloneDX', components: [] });
    expect(spawnSync('git', ['check-ignore', path], { encoding: 'utf8' }).status).toBe(0);
    expect(result.stdout).toContain(path);
}, 35000);

it.each(['missing', 'unsupported', 'invalid-json', 'invalid-document'])('DI-8e: %s npm tooling exits nonzero with a clear diagnostic', kind => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-guard-sbom-')); directories.push(directory);
    const npmPath = join(directory, 'npm.cjs');
    if (kind !== 'missing') writeFileSync(npmPath, kind === 'unsupported' ? 'process.exit(1);' : `process.stdout.write(${JSON.stringify(kind === 'invalid-json' ? 'invalid' : '{}')});`);
    const result = spawnSync(process.execPath, [resolve('scripts/sbom.mjs')], { encoding: 'utf8', env: { ...process.env, npm_execpath: npmPath } });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('written');
    expect(result.stderr).toMatch(kind.startsWith('invalid') ? /invalid (JSON|CycloneDX document)/ : /npm sbom is unavailable or failed.*npm 11/);
});
