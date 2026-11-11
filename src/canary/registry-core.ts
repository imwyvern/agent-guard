import type { CryptoProvider } from '../crypto/types.js';
import { hex } from '../crypto/bytes.js';
import { patterns } from '../core/signals.js';
import { generateCanary, validatePrefix } from './format-core.js';
import type { CanaryEntry, CanaryRegistry } from '../types.js';
export function validateRegistry(r: CanaryRegistry): CanaryRegistry {
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
    private nodes: Array<{ next: Map<string, number>; fail: number; output?: string; suffix: number }> = [
        { next: new Map(), fail: 0, suffix: 0 },
    ];
    private fingerprint(token: string): string { return hex(this.crypto.sha256(token)); }
    private index(entry: CanaryEntry): void {
        this.tokens.set(this.fingerprint(entry.token), entry);
        // Modern candidates are parsed by fixed prefix/length, including rotated tokens.
        const rest = entry.token.slice(this.data.prefix.length);
        if (entry.token.startsWith(this.data.prefix) && rest.length === 19 && patterns.registryToken.test(rest)) return;
        let node = 0;
        for (const char of entry.token) {
            let child = this.nodes[node]!.next.get(char);
            if (child === undefined) {
                child = this.nodes.length;
                this.nodes[node]!.next.set(char, child);
                this.nodes.push({ next: new Map(), fail: 0, suffix: 0 });
            }
            node = child;
        }
        this.nodes[node]!.output = entry.token;
    }
    private link(): void {
        const queue = [...this.nodes[0]!.next.values()];
        for (let i = 0; i < queue.length; i++) {
            const node = queue[i]!;
            for (const [char, child] of this.nodes[node]!.next) {
                let failure = this.nodes[node]!.fail;
                while (failure && !this.nodes[failure]!.next.has(char)) failure = this.nodes[failure]!.fail;
                failure = this.nodes[failure]!.next.get(char) ?? 0;
                this.nodes[child]!.fail = failure;
                this.nodes[child]!.suffix = this.nodes[failure]!.output ? failure : this.nodes[failure]!.suffix;
                queue.push(child);
            }
        }
    }
    /** Aho–Corasick legacy matching: linear input traversal, bounded outputs. */
    *candidates(text: string, budget: number): Generator<string> {
        let offset = 0;
        while (budget > 0) {
            const at = text.indexOf(this.data.prefix, offset);
            if (at < 0) break;
            yield text.slice(at, at + this.data.prefix.length + 19);
            budget--;
            offset = at + this.data.prefix.length;
        }
        if (this.nodes.length === 1 || budget <= 0) return;
        let node = 0;
        for (const char of text) {
            while (node && !this.nodes[node]!.next.has(char)) node = this.nodes[node]!.fail;
            node = this.nodes[node]!.next.get(char) ?? 0;
            let output = this.nodes[node]!.output ? node : this.nodes[node]!.suffix;
            while (output) {
                if (budget-- <= 0) return;
                yield this.nodes[output]!.output!;
                output = this.nodes[output]!.suffix;
            }
        }
    }
    constructor(data: CanaryRegistry, private secret: string, prefix: string, private readonly crypto: CryptoProvider) {
        this.data = data;
        if (this.data.prefix !== prefix)
            throw new Error('registry prefix does not match config');
        for (const entry of this.data.canaries)
            this.index(entry);
        this.link();
    }
    hasCandidate(text: string): boolean { return !this.candidates(text, 1).next().done; }
    find(token: string): CanaryEntry | undefined {
        const entry = this.tokens.get(this.fingerprint(token));
        return entry && this.crypto.secretEqual(token, entry.token) ? entry : undefined;
    }
    placement(placement: string, env: string): CanaryEntry {
        const found = this.data.canaries.find(e => e.placement === placement && e.env === env);
        if (found)
            return found;
        const entry = { ...generateCanary({ secret: this.secret, prefix: this.data.prefix }, this.crypto), env, placement, createdAt: new Date().toISOString() };
        this.data.canaries.push(entry);
        this.index(entry);
        return entry;
    }
}
