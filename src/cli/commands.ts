import { readFileSync, writeFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { resolve, relative, basename } from 'node:path';
import { generateCanary } from '../canary/format.js';
import { loadRegistry } from '../canary/registry.js';
import { lintPlacement } from '../canary/lint.js';
import { runSeed, SEED_USAGE } from './seed.js';
import type { AgentGuardEvent, CanaryRegistry } from '../types.js';
export function scanFiles(root: string, registry?: CanaryRegistry): string[] {
    const findings: string[] = [];
    const walk = (file: string): void => {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink())
            return;
        if (stat.isDirectory()) {
            for (const name of readdirSync(file))
                if (!['node_modules', '.git', 'dist', 'coverage'].includes(name))
                    walk(resolve(file, name));
            return;
        }
        const normalized = file.replaceAll('\\', '/');
        if (basename(file) === 'agent-guard.canaries.json' || /\/src\/decoys\/[^/]+\.ts$/.test(normalized))
            return;
        const text = readFileSync(file, 'utf8');
        text.split('\n').forEach((line, i) => {
            if (/[A-Z][A-Z0-9]{1,15}-CANARY-/.test(line) || registry?.canaries.some(e => line.includes(e.token)))
                findings.push(`${relative(process.cwd(), file)}:${i + 1}`);
        });
    };
    walk(resolve(root));
    return findings;
}
export function runCLI(args: string[], out: (s: string) => void = console.log): number {
    try {
        const option = (name: string): string | undefined => { const i = args.indexOf('--' + name); return i < 0 ? undefined : args[i + 1]; };
        const registryPath = option('registry') ?? 'agent-guard.canaries.json';
        const [command, sub] = args;
        if (command === 'seed') return runSeed(args.slice(1), out);
        if (command === 'lint') {
            if (!sub || sub.startsWith('--') || args.length !== 2)
                throw new Error('usage: agent-guard lint <path>');
            const findings = lintPlacement(sub);
            for (const finding of findings) out(`${finding.sample}: ${finding.rule}: ${finding.detail}`);
            return findings.length ? 1 : 0;
        }
        if (command === 'canary' && sub === 'scan') {
            const root = args[2];
            if (!root || root.startsWith('--'))
                throw new Error('usage: agent-guard canary scan <path> [--registry file]');
            const findings = scanFiles(root, existsSync(registryPath) ? loadRegistry(registryPath) : undefined);
            for (const finding of findings)
                out(finding);
            return findings.length ? 1 : 0;
        }
        if (command === 'canary' && (sub === 'new' || sub === 'list')) {
            const prefix = option('prefix') ?? 'AG-CANARY-';
            const registry: CanaryRegistry = existsSync(registryPath) ? loadRegistry(registryPath) : { version: 1, prefix, canaries: [] };
            if (sub === 'list') {
                out(JSON.stringify(registry, null, 2));
                return 0;
            }
            const secret = process.env.AG_CANARY_SECRET, env = option('env'), placement = option('placement');
            if (!secret || !env || !placement)
                throw new Error('canary new requires AG_CANARY_SECRET, --env and --placement');
            const entry = { ...generateCanary({ prefix: registry.prefix, secret }), env, placement, createdAt: new Date().toISOString() };
            registry.canaries.push(entry);
            writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
            out(JSON.stringify(entry));
            return 0;
        }
        if (command === 'report') {
            const duration = option('since') ?? '7d', match = /^(\d+)([dhm])$/.exec(duration);
            if (!match)
                throw new Error('since must be e.g. 7d, 24h, 30m');
            const cutoff = Date.now() - Number(match[1]) * ({ d: 86400000, h: 3600000, m: 60000 }[match[2]!]!);
            const file = args.slice(1).find((v, i, rest) => !v.startsWith('--') && (i === 0 || rest[i - 1] !== '--since'));
            if (!file)
                throw new Error('report requires a JSONL filename');
            const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as AgentGuardEvent).filter(e => Date.parse(e.ts) >= cutoff);
            const counts: Record<string, number> = {};
            for (const e of events)
                counts[e.event] = (counts[e.event] ?? 0) + 1;
            out('| Event | Count |\n| --- | --- |\n' + Object.entries(counts).map(([k, v]) => `| ${k} | ${v} |`).join('\n'));
            const latencies = events.filter(e => e.event === 'alert_sent').map(e => e.alert?.latency_ms ?? 0).sort((a, b) => a - b);
            out(`\nSessions observed: ${new Set(events.map(e => e.req.client_key)).size}; delivery p95: ${latencies[Math.floor(latencies.length * .95)] ?? 0} ms. FP/detection rates require labeled simulation traffic.`);
            return 0;
        }
        throw new Error('usage: agent-guard lint <path>, canary new|list|scan, report --since 7d <log.jsonl>\n' + SEED_USAGE);
    }
    catch (error) {
        out(error instanceof Error ? error.message : String(error));
        return 2;
    }
}
