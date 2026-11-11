import { nodeCrypto } from '../crypto/node.js';
import type { CryptoProvider } from '../crypto/types.js';
import { utf8ByteLength } from '../crypto/bytes.js';
import type { AgentGuardConfig, AGResponse } from '../types.js';
import { decoyHeaders } from '../decoys/headers.js';
import { mazeRoot, mazeMac, encodeMazeNode, verifyMazeNode } from './maze-nodes.js';

type Options = NonNullable<NonNullable<AgentGuardConfig['trap']>['maze']>;
interface Session { started: number; expires: number; pages: number; bytes: number; spent: boolean }
const capacity = 8192;

export function archivePrefix(config: AgentGuardConfig): string {
    // A leading double slash must never become a URL authority in an href.
    return (config.decoys?.basePath ?? '/api/internal').replace(/\/+/g, '/').replace(/\/$/, '') + '/archive/';
}

/** Fixed-size, stateless topology. Only budgets retain client state. Nodes encode
 * depth (2 base32 digits), parent MAC (20), child index (1), and a 100-bit MAC.
 * Domain-separated HMAC-SHA256 uses canary.secret, never a public project seed. */
export class Maze {
    readonly prefix: string;
    readonly entry: string;
    private readonly options: Options;
    private readonly sessions = new Map<string, Session>();
    private readonly active = new Map<string, number>();
    private windowStart = Date.now();
    private windowBytes = 0;
    constructor(config: AgentGuardConfig, private readonly secret = config.canary.secret, private readonly crypto: CryptoProvider = nodeCrypto) {
        this.options = config.trap?.maze ?? {};
        this.prefix = archivePrefix(config);
        this.entry = this.prefix + this.node(mazeRoot, 0, 0);
    }
    matches(path: string): boolean { return path.startsWith(this.prefix); }
    valid(path: string): boolean { return this.matches(path) && this.verify(path) !== undefined; }
    private node(parent: string, index: number, depth: number): string {
        return encodeMazeNode(parent, index, depth, mazeMac(parent, index, depth, this.secret, this.crypto));
    }
    private verify(path: string): { depth: number; mac: string } | undefined {
        return verifyMazeNode(path.slice(this.prefix.length), this.secret, this.crypto);
    }
    private pruneActive(now: number): void {
        for (const [key, deadline] of this.active) if (deadline <= now) this.active.delete(key);
    }
    get size(): number { this.pruneActive(Date.now()); return this.active.size; }
    private render(depth: number, parent: string): string {
        const links = Array.from({ length: 10 }, (_, i) => `<li><a rel="nofollow" href="${this.prefix}${this.node(parent, i, depth + 1)}">Record ${i + 1}</a></li>`).join('');
        return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow,noarchive"><title>Archive index</title></head><body><h1>Archive index</h1><p>Snapshot metadata, revision ${depth}. Synthetic read-only records.</p><ul>${links}</ul></body></html>`;
    }
    /** Invalid nodes never read or change a session. Session/global admission is
     * synchronous, including byte reservation, so concurrent inspect calls share caps. */
    respond(path: string, key: string, head = false): { response: AGResponse; spent: boolean } {
        const missing = (spent = false) => ({ response: mazeNotFound(head), spent });
        const node = this.verify(path);
        if (!node) return missing();
        const now = Date.now(), duration = this.options.maxDurationMs ?? 600_000;
        this.pruneActive(now);
        let session = this.sessions.get(key);
        this.sessions.delete(key);
        if (session && session.expires <= now) session = undefined;
        if (!session) {
            // No session is admitted at the global concurrency cap.
            if (this.active.size >= (this.options.maxConcurrent ?? 20)) return missing();
            session = { started: now, expires: now + duration + 30 * 60_000, pages: 0, bytes: 0, spent: false };
        }
        this.sessions.set(key, session);
        if (this.sessions.size > capacity) {
            const oldest = this.sessions.keys().next().value!;
            this.sessions.delete(oldest); this.active.delete(oldest);
        }
        if (session.spent) return missing();
        const spend = () => { session.spent = true; this.active.delete(key); return missing(true); };
        if (node.depth > (this.options.maxDepth ?? 6) || session.pages >= (this.options.maxPages ?? 50) || now - session.started >= duration) return spend();
        const body = this.render(node.depth, node.mac), bytes = head ? 0 : utf8ByteLength(body);
        if (now - this.windowStart >= 60_000) { this.windowStart = now; this.windowBytes = 0; }
        if (session.bytes + bytes > (this.options.maxBytes ?? 512 * 1024) || this.windowBytes + bytes > (this.options.bytesPerMinute ?? 5 * 1024 * 1024)) return spend();
        session.pages++; session.bytes += bytes; this.windowBytes += bytes;
        this.active.set(key, session.started + duration);
        return { response: { status: 200, headers: decoyHeaders('text/html'), body: head ? '' : body }, spent: false };
    }
}

export function mazeNotFound(head = false): AGResponse {
    return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: head ? '' : 'Not Found\n' };
}
