import { it, expect } from 'vitest';
import { MazeModel } from '../../bench/lib/maze-model.js';

it('rejects forged MACs and ancestry without spending page, byte or event budgets', () => {
    const maze = new MazeModel('seed'), session = maze.startSession();
    const forged = maze.entry.replace(/archive\/(.)/, (_, first: string) => `archive/${first === 'A' ? 'B' : 'A'}`);
    expect(maze.visit(session, forged)).toMatchObject({ kind: 'stop', status: 404, reason: 'invalid' });
    expect(maze.visit(session, maze.entry.replace('trail=r', 'trail=1')).reason).toBe('invalid');
    expect(session.pages).toBe(0);
    expect(session.bytes).toBe(0);
    expect(maze.events.exhaust_budget_spent).toBe(0);
    expect(maze.visit(session, maze.entry).kind).toBe('page');
});

it('reproduces pages and verifies another instance’s nodes with the same seed', () => {
    const first = new MazeModel('stable'), second = new MazeModel('stable');
    const a = first.startSession(), b = second.startSession();
    const page = first.visit(a, first.entry);
    expect(second.entry).toBe(first.entry);
    expect(second.visit(b, second.entry)).toEqual(page);
    expect(second.visit(b, page.links[0]!)).toEqual(first.visit(a, page.links[0]!));
    const other = new MazeModel('different');
    expect(other.visit(other.startSession(), page.links[0]!).reason).toBe('invalid');
});

it('enforces depth and records budget exhaustion once, with empty stop bodies', () => {
    const maze = new MazeModel('depth', { maxDepth: 1 }), session = maze.startSession();
    const root = maze.visit(session, maze.entry), child = maze.visit(session, root.links[0]!);
    expect(child.kind).toBe('page');
    expect(maze.visit(session, child.links[0]!)).toMatchObject({ kind: 'stop', status: 404, reason: 'depth', body: '' });
    expect(maze.visit(session, maze.entry).kind).toBe('stop');
    expect(session.pages).toBe(2);
    expect(maze.events.exhaust_budget_spent).toBe(1);
});

it('enforces page cap even for repeated valid nodes', () => {
    const maze = new MazeModel('pages', { maxPages: 2 }), session = maze.startSession();
    expect(maze.visit(session, maze.entry).kind).toBe('page');
    expect(maze.visit(session, maze.entry).kind).toBe('page');
    expect(maze.visit(session, maze.entry).reason).toBe('pages');
    expect(maze.visit(session, maze.entry).kind).toBe('stop');
    expect(session.pages).toBe(2);
    expect(maze.events.exhaust_budget_spent).toBe(1);
});

it('enforces byte cap before emitting a body and allows exact equality', () => {
    const baseline = new MazeModel('bytes');
    const bytes = Buffer.byteLength(baseline.visit(baseline.startSession(), baseline.entry).body);
    const maze = new MazeModel('bytes', { maxBytes: bytes }), session = maze.startSession();
    expect(maze.visit(session, maze.entry).kind).toBe('page');
    expect(maze.visit(session, maze.entry).reason).toBe('bytes');
    expect(session.bytes).toBe(bytes);
    const tiny = new MazeModel('bytes', { maxBytes: bytes - 1 }), fresh = tiny.startSession();
    expect(tiny.visit(fresh, tiny.entry)).toMatchObject({ kind: 'stop', reason: 'bytes', body: '' });
    expect(fresh.bytes).toBe(0);
});

it('expires sessions at ten simulated minutes without waiting', () => {
    const maze = new MazeModel('duration'), session = maze.startSession();
    maze.advance(599_999);
    expect(maze.visit(session, maze.entry).kind).toBe('page');
    maze.advance(1);
    expect(maze.visit(session, maze.entry).reason).toBe('duration');
    maze.advance(600_000);
    expect(maze.visit(session, maze.entry).kind).toBe('stop');
    expect(maze.events.exhaust_budget_spent).toBe(1);
    expect(maze.activeSessions).toBe(0);
});

it('caps global concurrent sessions and reclaims released slots', () => {
    const maze = new MazeModel('concurrency');
    const sessions = Array.from({ length: 20 }, () => maze.startSession());
    const rejected = maze.startSession();
    expect(maze.visit(rejected, maze.entry).reason).toBe('concurrency');
    expect(maze.activeSessions).toBe(20);
    maze.endSession(sessions[0]!);
    expect(maze.visit(maze.startSession(), maze.entry).kind).toBe('page');
    expect(maze.visit(rejected, maze.entry).kind).toBe('stop');
    expect(maze.events.exhaust_budget_spent).toBe(1);
});

it('caps outbound bytes across sessions in a rolling minute and resets after expiry', () => {
    const baseline = new MazeModel('rate');
    const bytes = Buffer.byteLength(baseline.visit(baseline.startSession(), baseline.entry).body);
    const maze = new MazeModel('rate', { maxBytesPerMinute: bytes });
    const a = maze.startSession(), b = maze.startSession();
    expect(maze.visit(a, maze.entry).kind).toBe('page');
    maze.advance(59_999);
    expect(maze.visit(b, maze.entry).reason).toBe('rate');
    maze.advance(1);
    expect(maze.visit(maze.startSession(), maze.entry).kind).toBe('page');
    expect(maze.visit(b, maze.entry).kind).toBe('stop');
    expect(maze.events.exhaust_budget_spent).toBe(1);
});

it('trips the circuit on either overload signal and emits one circuit event', () => {
    for (const signal of [{ inspectP99Ms: 2 }, { eventLoopDelayMs: 21 }]) {
        const maze = new MazeModel('circuit'), session = maze.startSession();
        maze.injectOverload({ inspectP99Ms: 1, eventLoopDelayMs: 20 });
        expect(maze.visit(session, maze.entry).kind).toBe('page');
        const bytes = session.bytes;
        maze.injectOverload(signal);
        maze.injectOverload(signal);
        expect(maze.visit(session, maze.entry)).toMatchObject({ kind: 'stop', reason: 'circuit' });
        expect(maze.visit(maze.startSession(), maze.entry).reason).toBe('circuit');
        expect(session.bytes).toBe(bytes);
        expect(maze.events).toEqual({ exhaust_budget_spent: 0, exhaust_circuit_open: 1 });
        expect(maze.activeSessions).toBe(0);
    }
});

it('renders ten internal nofollow links with noindex/no-store and no cookies or external URLs', () => {
    const maze = new MazeModel('safety'), page = maze.visit(maze.startSession(), maze.entry);
    expect(page.links).toHaveLength(10);
    expect(page.links.every(link => link.startsWith('/api/internal/archive/'))).toBe(true);
    expect(page.body.match(/rel="nofollow"/g)).toHaveLength(10);
    expect(page.body).not.toMatch(/https?:\/\//);
    expect(page.headers['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(page.headers['Cache-Control']).toBe('no-store');
    expect(Object.keys(page.headers).some(key => key.toLowerCase() === 'set-cookie')).toBe(false);
});

it('rejects negative simulated time and unsafe budget configuration', () => {
    expect(() => new MazeModel('bad', { maxPages: 0 })).toThrow();
    expect(() => new MazeModel('bad', { maxDepth: 33 })).toThrow();
    expect(() => new MazeModel('bad', { maxBytes: Infinity })).toThrow();
    expect(() => new MazeModel('bad').advance(-1)).toThrow();
});
