/** Bounded LRU with lazy TTL expiry; reads refresh recency, never TTL. */
export class LRU<K, V> {
    private entries = new Map<K, {
        value: V;
        expires: number;
    }>();
    constructor(readonly capacity: number, private now: () => number = Date.now) {
        if (capacity < 1)
            throw new RangeError('capacity must be positive');
    }
    get size(): number { return this.entries.size; }
    get(key: K): V | undefined {
        const e = this.entries.get(key);
        if (!e)
            return;
        this.entries.delete(key);
        if (e.expires <= this.now())
            return;
        this.entries.set(key, e);
        return e.value;
    }
    set(key: K, value: V, ttlMs: number): void {
        this.entries.delete(key);
        this.entries.set(key, { value, expires: this.now() + ttlMs });
        if (this.entries.size > this.capacity)
            this.entries.delete(this.entries.keys().next().value!);
    }
}
