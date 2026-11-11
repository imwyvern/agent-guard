export interface StateStore {
    get<T>(key: string): T | undefined | Promise<T | undefined>;
    set<T>(key: string, value: T, ttlMs: number): void | Promise<void>;
    delete(key: string): void | Promise<void>;
}

/** Bounded memory belonging to one isolate. Reads never renew the TTL. */
export function memoryStore(options: { maxEntries?: number } = {}): StateStore {
    const capacity = options.maxEntries ?? 50_000;
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('maxEntries must be a positive safe integer');
    const entries = new Map<string, { value: unknown; expires: number }>();
    return {
        get<T>(key: string): T | undefined {
            const entry = entries.get(key);
            if (!entry) return;
            entries.delete(key);
            if (entry.expires <= Date.now()) return;
            entries.set(key, entry);
            return entry.value as T;
        },
        set(key, value, ttlMs) {
            if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError('ttlMs must be finite and nonnegative');
            entries.delete(key);
            if (ttlMs === 0) return;
            entries.set(key, { value, expires: Date.now() + ttlMs });
            if (entries.size > capacity) entries.delete(entries.keys().next().value!);
        },
        delete(key) { entries.delete(key); },
    };
}
