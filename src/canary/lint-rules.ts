import { isIP } from 'node:net';

export interface LintSample { name: string; body: string; capBytes: number; /** Exact operator-configured callback hostnames only. */ allowedHosts?: string[] }
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
    // Find // first, then recover an optional scheme in a backward linear scan.
    // An unanchored optional scheme regex retries every suffix on a long word.
    // URL parsing still catches credentials, ports, decimal IPv4 and IPv6.
    for (const match of body.matchAll(/\/\/[^\s<>"'\\]+/g)) {
        let raw = match[0];
        if (body[match.index - 1] === ':') {
            let start = match.index - 1;
            while (start > 0 && /[a-z0-9+.-]/i.test(body[start - 1]!)) start--;
            // Like the former regex, a scheme must start at an ASCII letter.
            while (start < match.index - 1 && !/[a-z]/i.test(body[start]!)) start++;
            if (start < match.index - 1) raw = body.slice(start, match.index) + raw;
        }
        try {
            const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
            if (!url.hostname) add('host', 'URL has no hostname');
            else hosts.add(url.hostname);
        } catch { add('host', 'unparseable URL'); }
    }
    // Bare DNS names include env values and email domains. A dotted filename in
    // a relative route is data, e.g. /api/internal/openapi.json or /.env.local.
    // Allow one leading dot in the segment, but never a // URL authority.
    for (const match of body.matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi)) {
        const segmentStart = body[match.index - 1] === '.' ? match.index - 1 : match.index;
        const pathFilename = body[segmentStart - 1] === '/' && body[segmentStart - 2] !== '/';
        if (!pathFilename) hosts.add(match[0]);
    }
    for (const match of body.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) hosts.add(match[0]);
    for (const match of body.matchAll(/\[[0-9a-f:]+\]|\b(?:[0-9a-f]{0,4}:){2,}[0-9a-f:]+/gi)) hosts.add(match[0]);
    const normalize = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, '');
    const allowed = new Set((sample.allowedHosts ?? []).map(normalize));
    for (const host of hosts) if (!reservedHost(host) && !allowed.has(normalize(host))) add('host', `non-reserved hostname: ${host}`);
    return errors;
}
