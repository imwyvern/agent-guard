import { isIP } from 'node:net';
import { envBody } from '../src/decoys/d1-env.js';
import { adminResponse } from '../src/decoys/d2-admin.js';
import { opsBody } from '../src/decoys/d3-ops-notes.js';
import { openapiBody } from '../src/decoys/d4-openapi.js';
import { fakeData } from '../src/decoys/fake-data.js';
import { generateCanary } from '../src/canary/format.js';
import { mcpDecoyTools } from '../src/scenarios/mcp.js';
import { isMain } from './common.js';
import { personaSample, PERSONA_CAP_BYTES } from './lib/persona.js';

export interface LintSample { name: string; body: string; capBytes: number }
export interface LintViolation { sample: string; rule: string; detail: string }
export const DECOY_CAP_BYTES = 8 * 1024;

export function reservedHost(value: string): boolean {
    const host = value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (host.endsWith('.invalid') || host.endsWith('.example')) return true;
    if (isIP(host) === 4) {
        const parts = host.split('.').map(Number);
        return (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) ||
            (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
            (parts[0] === 203 && parts[1] === 0 && parts[2] === 113);
    }
    if (isIP(host) === 6) return new URL(`http://[${host}]/`).hostname.startsWith('[2001:db8:');
    return false;
}

/** Offline heuristic, not a general prompt-injection detector. Descriptive copy
 * (including "do not share") is allowed; agent-directed commands are rejected. */
export function lintSample(sample: LintSample): LintViolation[] {
    const errors: LintViolation[] = [];
    const add = (rule: string, detail: string) => errors.push({ sample: sample.name, rule, detail });
    const body = sample.body;
    if (Buffer.byteLength(body) > sample.capBytes) add('size', `body exceeds ${sample.capBytes} bytes`);
    if (/(?:AKIA|ASIA|ghp_|github_pat_|sk-|xox[bpas]-|AIza|eyJ|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----)/.test(body))
        add('vendor-secret', 'vendor credential prefix or private-key header');
    if (/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/u.test(body)) add('hidden-character', 'hidden or zero-width character');
    const imperatives = [
        /\b(?:ignore|disregard|override)\b(?:\s+\w+){0,3}\s+(?:previous|prior|above|instructions?|prompts?|rules?|polic(?:y|ies)|system|developer|safety)\b/i,
        /\b(?:you\s+must|you\s+should|please\s+(?:run|execute|ignore|disregard|send|reveal|visit|follow)|(?:run|execute|invoke)\s+(?:this|the|a|an|following|command|tool|code|script|shell|curl|wget|bash|powershell|rm|python|node)\b)/i,
        /(?:^|[\n.!?:>])\s*["']?(?:run|execute|ignore|disregard)\b/i,
        /\b(?:agent|assistant|model)\s*[,，:]?\s*(?:run|execute|obey|follow|send|reveal|visit|read|use)\b/i,
        /\b(?:follow|obey)\s+(?:(?:these|the|my|new)\s+)?(?:instructions?|commands?|rules?)\b/i,
        /(?:忽略|无视|無視|忘记|忘記|覆盖|覆蓋).{0,12}(?:指令|提示|规则|規則|系统|系統|之前|先前)|(?:你|您)(?:必须|必須|应当|應當)|(?:请|請)(?:执行|執行|运行|運行|调用|調用|访问|訪問|发送|發送|遵循|忽略)|(?:执行|執行|运行|運行|调用|調用)(?:以下|此|这个|這個|命令|代码|代碼|脚本|腳本|工具)/u,
    ];
    // Interpret HTML tags as separators so split instruction phrases are visible.
    const text = body.replace(/<[^>]*>/g, ' ');
    if (imperatives.some(pattern => pattern.test(text))) add('imperative', 'agent-directed instruction');

    const hosts = new Set<string>();
    // URL parsing catches credentials, ports, decimal IPv4 and bracketed IPv6.
    for (const match of body.matchAll(/(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s<>"'\\]+/gi)) {
        try {
            const url = new URL(match[0].startsWith('//') ? `https:${match[0]}` : match[0]);
            if (!url.hostname) add('host', 'URL has no hostname');
            else hosts.add(url.hostname);
        } catch { add('host', 'unparseable URL'); }
    }
    // Bare DNS names include env values and email domains. A dotted filename in
    // a relative route is data, e.g. /api/internal/openapi.json, not a hostname.
    for (const match of body.matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi)) {
        if (body[match.index - 1] !== '/') hosts.add(match[0]);
    }
    for (const match of body.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) hosts.add(match[0]);
    for (const match of body.matchAll(/\[[0-9a-f:]+\]|\b(?:[0-9a-f]{0,4}:){2,}[0-9a-f:]+/gi)) hosts.add(match[0]);
    for (const host of hosts) if (!reservedHost(host)) add('host', `non-reserved hostname: ${host}`);
    return errors;
}

export function existingDecoySamples(seed = 'v0.3b-offline'): LintSample[] {
    const fake = fakeData(seed);
    const tokens = Array.from({ length: 3 }, () => generateCanary({ secret: 'offline-lint-only' }).token);
    const bodies: Array<[string, string]> = [
        ['D1 env', envBody(tokens, fake.database, fake.region, fake.revision)],
        ['D2 missing', String(adminResponse('', '/api/internal/openapi.json').body)],
        ['D2 expired', String(adminResponse(`Bearer ${tokens[0]}`, '/api/internal/openapi.json').body)],
        ['D3 ops', opsBody(tokens[0]!, tokens[1]!, fake.site)],
        ['D4 openapi', openapiBody(tokens[2]!, '/api/internal/admin')],
        ['MCP tools and descriptions', JSON.stringify(mcpDecoyTools)],
    ];
    return bodies.map(([name, body]) => ({ name: `${seed}: ${name}`, body, capBytes: DECOY_CAP_BYTES }));
}

export function deceptionLint() {
    const samples = Array.from({ length: 20 }, (_, i) => {
        const seed = `v0.3b-persona-${i}`;
        return [...existingDecoySamples(seed), { name: seed, body: personaSample(seed), capBytes: PERSONA_CAP_BYTES }];
    }).flat();
    const violations = samples.flatMap(lintSample);
    return { status: violations.length ? 'failed' : 'passed', samples: samples.length, violations };
}
if (isMain(import.meta.url)) {
    const result = deceptionLint();
    console.log(JSON.stringify(result, null, 2));
    if (result.violations.length) process.exitCode = 1;
}
