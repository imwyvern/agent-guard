import { expect, it, vi } from 'vitest';
import { memoryStore } from '../../src/state/store.js';

it('evicts the oldest entry at capacity and refreshes recency on get', async () => {
    const store = memoryStore({ maxEntries: 2 });
    await store.set('a', 1, 1000); await store.set('b', 2, 1000);
    expect(await store.get<number>('a')).toBe(1);
    await store.set('c', 3, 1000);
    expect(await store.get('b')).toBeUndefined();
    expect(await store.get('a')).toBe(1);
    expect(await store.get('c')).toBe(3);
});
it('moves updates to most recent and replaces their values and TTL', async () => {
    vi.useFakeTimers();
    const store = memoryStore({ maxEntries: 2 });
    store.set('a', 1, 5); store.set('b', 2, 100);
    vi.advanceTimersByTime(4); store.set('a', 9, 100); store.set('c', 3, 100);
    vi.advanceTimersByTime(5);
    expect(store.get('a')).toBe(9); expect(store.get('b')).toBeUndefined();
});
it('expires at the TTL boundary, never renews TTL on reads, and deletes entries', () => {
    vi.useFakeTimers();
    const store = memoryStore();
    store.set('a', { n: 1 }, 10);
    vi.advanceTimersByTime(9); expect(store.get('a')).toEqual({ n: 1 });
    vi.advanceTimersByTime(1); expect(store.get('a')).toBeUndefined();
    store.set('a', 1, 1000); store.delete('a'); store.delete('missing');
    expect(store.get('a')).toBeUndefined();
    store.set('zero', 1, 0); expect(store.get('zero')).toBeUndefined();
});
it('uses the default 50,000 entry bound', () => {
    const store = memoryStore();
    for (let n = 0; n <= 50_000; n++) store.set(String(n), n, 60_000);
    expect(store.get('0')).toBeUndefined(); expect(store.get('1')).toBe(1); expect(store.get('50000')).toBe(50_000);
});
it('validates capacity and TTL', () => {
    for (const maxEntries of [0, -1, 1.5, Infinity, NaN]) expect(() => memoryStore({ maxEntries })).toThrow();
    for (const ttl of [-1, Infinity, NaN]) expect(() => memoryStore().set('a', 1, ttl)).toThrow();
});
