import type { AgentGuardConfig, AGResponse } from '../types.js';
import { mazeRoot, mazeMacAsync, encodeMazeNode, verifyMazeNodeAsync } from '../core/maze-nodes.js';
import { webCrypto } from '../crypto/web.js';
import { utf8ByteLength } from '../crypto/bytes.js';
import { patterns } from '../core/signals.js';
import { decoyHeaders } from '../decoys/headers.js';
import type { WebState } from './state.js';
import { notFound } from './trap.js';

interface Session { key: string; started: number; expires: number; pages: number; bytes: number; spent: boolean }
interface Budget { sessions: Session[]; windowStart: number; windowBytes: number }
export class WebMaze {
    readonly prefix: string;
    active = 0;
    private entryNode?: Promise<string>;
    constructor(private readonly config: AgentGuardConfig, private readonly state: WebState) {
        this.prefix = (config.decoys?.basePath ?? '/api/internal').replace(patterns.repeatedSlash, '/').replace(patterns.trailingSlash, '') + '/archive/';
    }
    matches(path: string): boolean { return path.startsWith(this.prefix); }
    entry(): Promise<string> { return this.entryNode ??= this.node(mazeRoot, 0, 0).then(node => this.prefix + node); }
    private async node(parent: string, index: number, depth: number): Promise<string> {
        return encodeMazeNode(parent, index, depth, await mazeMacAsync(parent, index, depth, this.config.canary.secret, webCrypto));
    }
    verify(path: string): Promise<{ depth: number; mac: string } | undefined> {
        return verifyMazeNodeAsync(path.slice(this.prefix.length), this.config.canary.secret, webCrypto);
    }
    async respond(path: string, key: string, head: boolean): Promise<{ response: AGResponse; spent: boolean }> {
        const node = await this.verify(path), missing = (spent = false) => ({ response: notFound(head), spent });
        // MAC verification is stateless. Admission is refused without a store,
        // since even one page per client would promise an unenforceable budget.
        if (!node || !this.state.store) return missing();
        return this.state.exclusive(async () => {
            const store = this.state.store!, storeKey = this.state.prefix + 'maze:' + this.prefix, now = Date.now();
            const budget = structuredClone(await store.get<Budget>(storeKey) ?? { sessions: [], windowStart: now, windowBytes: 0 });
            const options = this.config.trap?.maze, duration = options?.maxDurationMs ?? 600_000;
            budget.sessions = budget.sessions.filter(s => s.expires > now);
            let session = budget.sessions.find(s => s.key === key);
            budget.sessions = budget.sessions.filter(s => s.key !== key);
            const active = () => budget.sessions.filter(s => !s.spent && now - s.started < duration).length;
            if (!session) {
                if (active() >= (options?.maxConcurrent ?? 20)) { this.active = active(); return missing(); }
                session = { key, started: now, expires: now + duration + 1800_000, pages: 0, bytes: 0, spent: false };
            }
            budget.sessions.push(session);
            if (budget.sessions.length > 8192) budget.sessions.shift();
            const save = async () => { this.active = active(); await store.set(storeKey, budget, duration + 1800_000); };
            if (session.spent) { await save(); return missing(); }
            const spend = async () => { session.spent = true; await save(); return missing(true); };
            if (node.depth > (options?.maxDepth ?? 6) || session.pages >= (options?.maxPages ?? 50) || now - session.started >= duration) return spend();
            const links = (await Promise.all(Array.from({ length: 10 }, async (_, i) => `<li><a rel="nofollow" href="${this.prefix}${await this.node(node.mac, i, node.depth + 1)}">Record ${i + 1}</a></li>`))).join('');
            const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow,noarchive"><title>Archive index</title></head><body><h1>Archive index</h1><p>Snapshot metadata, revision ${node.depth}. Synthetic read-only records.</p><ul>${links}</ul></body></html>`;
            const bytes = head ? 0 : utf8ByteLength(body);
            if (now - budget.windowStart >= 60_000) { budget.windowStart = now; budget.windowBytes = 0; }
            if (session.bytes + bytes > (options?.maxBytes ?? 512 * 1024) || budget.windowBytes + bytes > (options?.bytesPerMinute ?? 5 * 1024 * 1024)) return spend();
            session.pages++; session.bytes += bytes; budget.windowBytes += bytes;
            await save();
            return { response: { status: 200, headers: decoyHeaders('text/html'), body: head ? '' : body }, spent: false };
        });
    }
}
