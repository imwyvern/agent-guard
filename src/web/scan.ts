import { verifyCanaryAsync } from '../canary/format-core.js';
import { utf8ByteLength, utf8Decode } from '../crypto/bytes.js';
import { webCrypto } from '../crypto/web.js';
import type { AGRequest, AgentGuardConfig, CanaryEntry } from '../types.js';
import type { WebRegistry } from './registry.js';
import { boundRequest, inspectionLimits, takeBytes } from '../core/limits.js';
import { sanitizeHeader } from '../core/security-core.js';
export function matchesPath(path: string, pattern: string): boolean {
    return pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
}
export interface ScanHit {
    entry: CanaryEntry;
    found_in: 'header' | 'query' | 'body' | 'path';
    field: string;
}
export async function scanRequest(input: AGRequest, registry: WebRegistry, config: AgentGuardConfig, scanBody: boolean): Promise<ScanHit[]> {
    const hits: ScanHit[] = [], limits = inspectionLimits(config), seen = new Set<string>();
    let remaining = limits.maxCanaryCandidates;
    const prefix = registry.data.prefix;
    const candidates: Array<{ token: string; found_in: ScanHit['found_in']; field: string }> = [];
    const scan = (text: string, found_in: ScanHit['found_in'], field: string): void => {
        if (remaining <= 0) return;
        for (const token of registry.candidates(text, remaining)) {
            remaining--;
            candidates.push({ token, found_in, field: sanitizeHeader(field) });
        }
    };
    try {
        const req = boundRequest(input, limits);
        scan(req.path, 'path', 'path');
        if (config.canaryScan?.headers !== false)
            for (const k in req.headers) {
                const value = req.headers[k];
                for (const text of Array.isArray(value) ? value : [value])
                    if (text !== undefined) scan(text, 'header', k);
            }
        if (config.canaryScan?.query !== false)
            for (const k in req.query) {
                const value = req.query[k]!;
                for (const text of Array.isArray(value) ? value : [value]) scan(text, 'query', k);
            }
        // Do not serialize or recurse into host objects. Charge each visited node/key as
        // well as UTF-8 string bytes; cycles, getters and toJSON cannot expand the work.
        if (scanBody && remaining > 0) {
            let budget = limits.maxBodyBytes;
            const visited = new WeakSet<object>();
            const visit = (value: unknown, field: string, depth: number): void => {
                if (budget-- <= 0 || remaining <= 0 || depth > 32) return;
                if (typeof value === 'string') {
                    const text = takeBytes(value, Math.max(0, budget));
                    budget -= utf8ByteLength(text);
                    scan(text, 'body', field);
                } else if (value instanceof Uint8Array) {
                    const text = utf8Decode(value.subarray(0, Math.max(0, budget)));
                    budget -= utf8ByteLength(text);
                    scan(text, 'body', field);
                } else if (value && typeof value === 'object' && !visited.has(value)) {
                    visited.add(value);
                    for (const key in value) {
                        if (budget <= 0 || remaining <= 0) break;
                        budget--;
                        if (!Object.hasOwn(value, key)) continue;
                        const name = takeBytes(key, Math.max(0, budget));
                        budget -= utf8ByteLength(name);
                        if (name.length !== key.length) break;
                        const descriptor = Object.getOwnPropertyDescriptor(value, key);
                        if (descriptor && 'value' in descriptor)
                            visit(descriptor.value, sanitizeHeader(field ? `${field}.${name}` : name), depth + 1);
                    }
                }
            };
            visit(req.body, '', 0);
        }
    } catch { /* Malformed host values never affect application handling. */ }
    for (const { token, found_in, field } of candidates) {
        const registered = registry.find(token), verified = registered ? undefined : await verifyCanaryAsync(token, { prefix, secret: config.canary.secret }, webCrypto);
        if ((!registered && !verified!.valid) || seen.has(token)) continue;
        seen.add(token);
        hits.push({ entry: registered ?? { id: verified!.id!, token, placement: 'unregistered', env: config.env, createdAt: '' }, found_in, field });
    }
    return hits;
}
