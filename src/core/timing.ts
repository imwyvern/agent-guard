interface TimingState {
    last: number;
    intervals?: Uint32Array;
    count: number;
    cursor: number;
}

export function automationScore(intervals: ArrayLike<number>): number | undefined {
    if (!intervals.length) return;
    let sum = 0;
    for (let i = 0; i < intervals.length; i++) sum += intervals[i]!;
    const mean = sum / intervals.length;
    if (mean === 0) return 1;
    let variance = 0;
    for (let i = 0; i < intervals.length; i++) variance += (intervals[i]! - mean) ** 2;
    const cv = Math.sqrt(variance / intervals.length) / mean;
    // Linear mapping: CV 0 scores 1; CV >= 0.25 scores 0. Only near-periodic traffic scores highly.
    return Math.max(0, Math.min(1, 1 - cv / .25));
}

/** Separate, small LRU: allocate an interval ring only on a client's second request. */
export class Timing {
    private entries = new Map<string, TimingState>();
    constructor(readonly windowSize = 20, readonly capacity = 2048) {
        if (!Number.isSafeInteger(windowSize) || windowSize < 1 || !Number.isSafeInteger(capacity) || capacity < 1)
            throw new RangeError('timing window and capacity must be positive integers');
    }
    get size(): number { return this.entries.size; }
    record(key: string, now = Date.now()): number | undefined {
        let state = this.entries.get(key);
        if (!state) {
            state = { last: now, count: 0, cursor: 0 };
            if (this.entries.size >= this.capacity)
                this.entries.delete(this.entries.keys().next().value!);
            this.entries.set(key, state);
            return;
        }
        this.entries.delete(key);
        this.entries.set(key, state);
        const intervals = state.intervals ??= new Uint32Array(this.windowSize);
        intervals[state.cursor] = Math.max(0, Math.min(0xffff_ffff, Math.floor(now - state.last)));
        state.last = now;
        state.cursor = (state.cursor + 1) % this.windowSize;
        state.count = Math.min(this.windowSize, state.count + 1);
        return state.count === this.windowSize ? automationScore(intervals) : undefined;
    }
}
