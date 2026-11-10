import { readFileSync } from 'node:fs';
import { generateCanary, validatePrefix } from './format.js';
import type { CanaryEntry, CanaryRegistry } from '../types.js';
export function loadRegistry(input: CanaryRegistry | string): CanaryRegistry {
    const r: CanaryRegistry = typeof input === 'string' ? JSON.parse(readFileSync(input, 'utf8')) as CanaryRegistry : structuredClone(input);
    if (r.version !== 1 || !Array.isArray(r.canaries))
        throw new Error('invalid canary registry');
    validatePrefix(r.prefix);
    const ids = new Set<string>(), tokens = new Set<string>();
    for (const e of r.canaries) {
        if (!e.id || !e.token || !e.env || !e.placement || !e.createdAt || ids.has(e.id) || tokens.has(e.token))
            throw new Error('invalid/duplicate canary registry entry');
        ids.add(e.id);
        tokens.add(e.token);
    }
    return r;
}
export class Registry {
    readonly data: CanaryRegistry;
    private tokens = new Map<string, CanaryEntry>();
    private otherTokens: string[];
    constructor(input: CanaryRegistry | string, private secret: string, prefix: string) {
        this.data = loadRegistry(input);
        if (this.data.prefix !== prefix)
            throw new Error('registry prefix does not match config');
        for (const entry of this.data.canaries)
            this.tokens.set(entry.token, entry);
        // Imported registries may contain legacy tokens without the current prefix.
        this.otherTokens = this.data.canaries.filter(e => !e.token.includes(prefix)).map(e => e.token);
    }
    hasCandidate(text: string): boolean { return text.includes(this.data.prefix) || this.otherTokens.some(token => text.includes(token)); }
    find(token: string): CanaryEntry | undefined { return this.tokens.get(token); }
    placement(placement: string, env: string): CanaryEntry {
        const found = this.data.canaries.find(e => e.placement === placement && e.env === env);
        if (found)
            return found;
        const entry = { ...generateCanary({ secret: this.secret, prefix: this.data.prefix }), env, placement, createdAt: new Date().toISOString() };
        this.data.canaries.push(entry);
        this.tokens.set(entry.token, entry);
        return entry;
    }
}
