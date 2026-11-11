import type { AgentGuardEvent } from '../types.js';
import { ulid } from './ulid-core.js';
import type { CryptoProvider } from '../crypto/types.js';

export const incidentSteps = ['robots', 'D1', 'D2', 'D3', 'D4', 'D5', 'MCP', 'GQL', 'probe', 'ai_discovery', 'canary_replay'] as const;
const steps = incidentSteps;
type Step = typeof steps[number];
const sequenceLimit = 32;

/** Fixed window from first_seen; LRU recency never extends the window.
 * Slots avoid per-client objects, arrays, IDs and timers. Keep the last 32 steps,
 * retaining cumulative features so confidence cannot fall within an incident. */
export class Incidents {
    private readonly entries = new Map<string, number>();
    private readonly first: Float64Array;
    private readonly last: Float64Array;
    private readonly serial: Float64Array;
    private readonly features: Uint16Array;
    private readonly lengths: Uint8Array;
    private readonly sequences: Uint8Array;
    private readonly prefix: string;
    private counter = 0;
    private latestKey: string | undefined;
    constructor(crypto: CryptoProvider, private readonly windowMs = 15 * 60_000, private readonly now: () => number = Date.now, private readonly capacity = 50_000) {
        this.prefix = ulid(crypto);
        if (!Number.isSafeInteger(windowMs) || windowMs < 0 || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 50_000)
            throw new RangeError('invalid incident limits');
        const slots = windowMs === 0 ? 0 : capacity;
        this.first = new Float64Array(slots);
        this.last = new Float64Array(slots);
        this.serial = new Float64Array(slots);
        this.features = new Uint16Array(slots);
        this.lengths = new Uint8Array(slots);
        this.sequences = new Uint8Array(slots * sequenceLimit / 2);
    }
    get size(): number { return this.entries.size; }
    observe(key: string, step: Step): AgentGuardEvent['incident'] {
        if (this.windowMs === 0) return;
        const now = this.now();
        let slot = this.entries.get(key);
        let fresh = slot === undefined;
        if (slot === undefined) {
            if (this.entries.size === this.capacity) {
                const oldest = this.entries.keys().next().value!;
                slot = this.entries.get(oldest)!;
                this.entries.delete(oldest);
            } else slot = this.entries.size;
        } else {
            fresh = now - this.first[slot]! >= this.windowMs;
        }
        // Consecutive events already occupy the newest position. Avoid tombstones
        // and map growth from deleting/reinserting the same current client.
        if (key !== this.latestKey) {
            this.entries.delete(key);
            this.entries.set(key, slot);
            this.latestKey = key;
        }
        if (fresh) {
            this.first[slot] = now;
            this.serial[slot] = ++this.counter;
            this.features[slot] = 0;
            this.lengths[slot] = 0;
        }
        this.last[slot] = Math.max(this.first[slot]!, now);
        const code = steps.indexOf(step), offset = slot * sequenceLimit / 2;
        let length = this.lengths[slot]!;
        if (length === sequenceLimit) {
            // Eleven step types fit in four bits. Shift one nibble on overflow.
            for (let i = 0; i < sequenceLimit / 2 - 1; i++)
                this.sequences[offset + i] = (this.sequences[offset + i]! >>> 4) | ((this.sequences[offset + i + 1]! & 15) << 4);
            this.sequences[offset + sequenceLimit / 2 - 1] = this.sequences[offset + sequenceLimit / 2 - 1]! >>> 4;
            length--;
        }
        const byte = offset + (length >> 1), shift = length % 2 * 4;
        this.sequences[byte] = (this.sequences[byte]! & ~(15 << shift)) | (code << shift);
        this.lengths[slot] = ++length;
        const features = this.features[slot]! | (1 << code);
        this.features[slot] = features;
        if (length < 2 && step !== 'canary_replay') return;
        return {
            id: `${this.prefix}-${this.serial[slot]!.toString(36)}`,
            sequence: Array.from({ length }, (_, i) => steps[(this.sequences[offset + (i >> 1)]! >>> (i % 2 * 4)) & 15]!),
            first_seen: new Date(this.first[slot]!).toISOString(),
            last_seen: new Date(this.last[slot]!).toISOString(),
            confidence: incidentConfidence(features),
        };
    }
    event(event: AgentGuardEvent): AgentGuardEvent['incident'] {
        const step: Step | undefined = event.event === 'decoy_hit' ? event.decoy?.id
            : event.event === 'probe' || event.event === 'ai_discovery' || event.event === 'canary_replay' ? event.event : undefined;
        return step === undefined ? undefined : this.observe(event.req.client_key, step);
    }
}

export function incidentConfidence(features: number): NonNullable<AgentGuardEvent['incident']>['confidence'] {
    const decoys = features & 0xfe;
    const multipleDecoys = (decoys & (decoys - 1)) !== 0;
    const discoveryThenDecoy = decoys !== 0 && (features & ((1 << 0) | (1 << 8) | (1 << 9))) !== 0;
    return features & (1 << 10) ? 'high' : multipleDecoys || discoveryThenDecoy ? 'medium' : 'low';
}
