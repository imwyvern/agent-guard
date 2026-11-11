import type { CanaryEntry, CanaryRegistry } from '../types.js';
import { CandidateIndex, validateRegistry } from '../canary/registry-core.js';
import { generateCanaryAsync } from '../canary/format-core.js';
import { webCrypto } from '../crypto/web.js';

export class WebRegistry extends CandidateIndex {
    readonly data: CanaryRegistry;
    private readonly tokens = new Map<string, CanaryEntry>();
    constructor(input: CanaryRegistry, private readonly secret: string, prefix: string) {
        super(prefix);
        this.data = validateRegistry(structuredClone(input));
        if (this.data.prefix !== prefix) throw new Error('registry prefix does not match config');
        for (const entry of this.data.canaries) { this.tokens.set(entry.token, entry); this.add(entry.token); }
        this.link();
    }
    find(token: string): CanaryEntry | undefined {
        const entry = this.tokens.get(token);
        return entry && webCrypto.secretEqual(token, entry.token) ? entry : undefined;
    }
    async placement(placement: string, env: string): Promise<CanaryEntry> {
        const found = this.data.canaries.find(e => e.placement === placement && e.env === env);
        if (found) return found;
        const entry = { ...await generateCanaryAsync({ secret: this.secret, prefix: this.data.prefix }, webCrypto), env, placement, createdAt: new Date().toISOString() };
        this.data.canaries.push(entry);
        this.tokens.set(entry.token, entry);
        return entry;
    }
}
