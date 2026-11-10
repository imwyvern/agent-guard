import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCLI, scanFiles } from '../../src/cli/commands.js';
import { generateCanary } from '../../src/index.js';
import { event } from '../helpers.js';
it('creates/lists registry, scans with whitelist and reports event KPIs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-cli-')), registry = join(dir, 'agent-guard.canaries.json'), logs = join(dir, 'events.jsonl'), out: string[] = [];
    try {
        vi.stubEnv('AG_CANARY_SECRET', 'test-secret');
        expect(runCLI(['canary', 'new', '--env', 'demo', '--placement', 'D1:token', '--registry', registry], s => out.push(s))).toBe(0);
        expect(runCLI(['canary', 'list', '--registry', registry], s => out.push(s))).toBe(0);
        expect(out.join('')).toContain('D1:token');
        expect(runCLI(['canary', 'scan', dir, '--registry', registry], () => { })).toBe(0);
        const token = generateCanary({ secret: 's' }).token;
        writeFileSync(join(dir, 'leak.env'), 'hello\nPASSWORD=' + token + '\n');
        mkdirSync(join(dir, 'src', 'decoys'), { recursive: true });
        writeFileSync(join(dir, 'src', 'decoys', 'template.ts'), token);
        mkdirSync(join(dir, 'node_modules'));
        writeFileSync(join(dir, 'node_modules', 'ignored'), token);
        symlinkSync(join(dir, 'leak.env'), join(dir, 'symlink'));
        expect(scanFiles(dir)).toHaveLength(1);
        expect(runCLI(['canary', 'scan', dir], s => out.push(s))).toBe(1);
        expect(out.at(-1)).toContain('leak.env:2');
        writeFileSync(logs, [event(), event({ event: 'alert_sent', alert: { channel: 'test', latency_ms: 12 } }), event({ ts: '2000-01-01T00:00:00.000Z' })].map(e => JSON.stringify(e)).join('\n') + '\n');
        expect(runCLI(['report', '--since', '7d', logs], s => out.push(s))).toBe(0);
        expect(out.join('')).toContain('12 ms');
        expect(runCLI(['report', logs], () => { })).toBe(0);
        for (const args of [[], ['report'], ['report', '--since', 'invalid', logs], ['canary', 'scan'], ['canary', 'scan', '--registry', registry]])
            expect(runCLI(args, () => { })).toBe(2);
        vi.stubEnv('AG_CANARY_SECRET', '');
        expect(runCLI(['canary', 'new'], () => { })).toBe(2);
    }
    finally {
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
    }
});
