import { verifyCanary } from './format.js';
import type { AGRequest, AgentGuardConfig, CanaryEntry } from '../types.js';
import type { Registry } from './registry.js';
export function matchesPath(path: string, pattern: string): boolean {
    return pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
}
export interface ScanHit {
    entry: CanaryEntry;
    found_in: 'header' | 'query' | 'body' | 'path';
    field: string;
}
export function scanRequest(req: AGRequest, registry: Registry, config: AgentGuardConfig, scanBody: boolean): ScanHit[] {
    const hits: ScanHit[] = [], seen = new Set<string>();
    const prefix = registry.data.prefix;
    const re = new RegExp(prefix + '[0-9A-HJKMNP-TV-Z]{12}-[0-9A-HJKMNP-TV-Z]{6}', 'g');
    const scan = (text: string, found_in: ScanHit['found_in'], field: string): void => {
        const candidates = new Set(text.match(re) ?? []);
        // Exact registry matches permit previously issued tokens after secret rotation.
        for (const e of registry.data.canaries)
            if (text.includes(e.token))
                candidates.add(e.token);
        for (const token of candidates) {
            const registered = registry.find(token), verified = verifyCanary(token, { prefix, secret: config.canary.secret });
            if ((!registered && !verified.valid) || seen.has(token))
                continue;
            seen.add(token);
            hits.push({ entry: registered ?? { id: verified.id!, token, placement: 'unregistered', env: config.env, createdAt: '' }, found_in, field });
        }
    };
    scan(req.path, 'path', 'path');
    if (config.canaryScan?.headers !== false)
        for (const [k, v] of Object.entries(req.headers))
            if (v !== undefined)
                scan(Array.isArray(v) ? v.join(' ') : v, 'header', k.toLowerCase());
    if (config.canaryScan?.query !== false)
        for (const [k, v] of Object.entries(req.query))
            scan(Array.isArray(v) ? v.join(' ') : v, 'query', k);
    if (scanBody && req.body !== undefined) {
        let serialized: string | undefined;
        try {
            serialized = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        }
        catch {
            return hits;
        }
        if (serialized !== undefined && Buffer.byteLength(serialized) <= (config.canaryScan?.maxBodyBytes ?? 16384)) {
            const visit = (value: unknown, field: string): void => {
                if (typeof value === 'string')
                    scan(value, 'body', field);
                else if (value && typeof value === 'object')
                    for (const [k, v] of Object.entries(value))
                        visit(v, field ? `${field}.${k}` : k);
            };
            visit(req.body, '');
        }
    }
    return hits;
}
