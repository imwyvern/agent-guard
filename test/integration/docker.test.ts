import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';

const probe = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 5000 });
const available = !probe.error && probe.status === 0;
const reason = probe.error && 'code' in probe.error && probe.error.code === 'ENOENT' ? 'Docker executable unavailable' : 'Docker daemon unavailable';

it.skipIf(!available)(`DI-8f: build, curl default Compose ordinary/decoy responses and alert, then tear down${available ? '' : ` (SKIP: ${reason})`}`, async () => {
    // A disposable source context avoids touching an operator's deploy/.env.
    const directory = mkdtempSync(join(tmpdir(), 'agent-guard-docker-'));
    const project = `agent-guard-di8-${process.pid}`;
    const compose = ['compose', '-p', project, '-f', join(directory, 'deploy/compose.yaml')];
    const docker = (args: string[], timeout = 60000) => {
        const result = spawnSync('docker', args, { encoding: 'utf8', timeout });
        if (result.error || result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
        return result.stdout;
    };
    try {
        for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsup.config.ts', '.dockerignore', 'src', 'deploy']) {
            cpSync(file, join(directory, file), { recursive: true, filter: source => !/[/\\]\.env$/.test(source) });
        }
        mkdirSync(join(directory, 'scripts'));
        cpSync('scripts/build.ts', join(directory, 'scripts/build.ts'));
        writeFileSync(join(directory, 'deploy/.env'), ['AG_CANARY_SECRET', 'AG_PROJECT_SEED', 'AG_WEBHOOK_SECRET']
            .map(name => `${name}=${randomBytes(32).toString('hex')}`).join('\n') + '\n', { mode: 0o600 });
        docker([...compose, 'build'], 240000);
        docker([...compose, 'up', '-d']);
        let ordinary = '';
        for (let attempt = 0; attempt < 50; attempt++) {
            const response = spawnSync('curl', ['-fsS', '--max-time', '2', 'http://127.0.0.1:8080/'], { encoding: 'utf8', timeout: 3000 });
            if (response.status === 0) { ordinary = response.stdout; break; }
            await setTimeout(100);
        }
        expect(ordinary).toBe('local upstream\n');
        const decoy = spawnSync('curl', ['-fsS', '-i', '--max-time', '2', 'http://127.0.0.1:8080/.env'], { encoding: 'utf8', timeout: 3000 });
        expect(decoy.status).toBe(0);
        expect(decoy.stdout).toMatch(/x-robots-tag:.*noindex/i);
        expect(decoy.stdout).toContain('AG-CANARY-');
        let logs = '';
        for (let attempt = 0; attempt < 50; attempt++) {
            logs = docker([...compose, 'logs', '--no-color', 'guard']);
            if (logs.includes('"event":"decoy_hit"')) break;
            await setTimeout(100);
        }
        expect(logs).toContain('"event":"decoy_hit"');
    } finally {
        try { docker([...compose, 'down', '--remove-orphans']); }
        finally { rmSync(directory, { recursive: true, force: true }); }
    }
}, 360000);
