import type { AgentGuardConfig, AgentGuardEvent } from '../types.js';
import { ulid } from '../core/ulid.js';
import { JsonlReader } from '../log/file.js';

interface Slot {
    event: AgentGuardEvent;
    expires: number;
    queued: boolean;
    high: boolean;
    acked: boolean;
    alerted?: number;
    next: number;
    reminders: number;
}

/** Node inspect coordinator. Bounded companion LRU; one interval for all incidents.
 * Without log.file, CLI acks are not visible in-process; reminders remain capped.
 * Failed deliveries are recorded by Dispatcher and never change inspection. */
export class Escalation {
    private readonly slots = new Map<string, Slot>();
    private readonly reader?: JsonlReader;
    private timer?: ReturnType<typeof setInterval>;
    private readonly after: number;
    private readonly max: number;
    constructor(private readonly config: AgentGuardConfig,
        private readonly enqueue: (event: AgentGuardEvent, key: string) => boolean,
        private readonly emit: (event: AgentGuardEvent) => void,
        private readonly now: () => number = Date.now,
        private readonly capacity = 50_000) {
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50_000) throw new RangeError('invalid escalation capacity');
        this.after = config.escalation?.remindAfterMs ?? 300_000;
        this.max = config.escalation?.maxReminders ?? 2;
        if (config.log?.file) this.reader = new JsonlReader(config.log.file);
    }
    get size(): number { return this.slots.size; }
    start(): void {
        if (this.timer || !this.config.escalation?.enabled) return;
        this.timer = setInterval(() => this.tick(), Math.min(1000, this.after));
        this.timer.unref();
    }
    close(): void { clearInterval(this.timer); this.timer = undefined; this.slots.clear(); }
    observe(event: AgentGuardEvent): void {
        const incident = event.incident;
        if (!incident || !this.config.escalation?.enabled) return;
        let slot = this.slots.get(incident.id);
        if (!slot) {
            if (this.slots.size === this.capacity) this.slots.delete(this.slots.keys().next().value!);
            slot = { event, expires: Date.parse(incident.first_seen) + (this.config.incident?.windowMs ?? 900_000), queued: false,
                high: incident.confidence === 'high', acked: false, next: Infinity, reminders: 0 };
        }
        this.slots.delete(incident.id); this.slots.set(incident.id, slot);
        slot.event = event;
        if (!slot.queued) {
            slot.high = incident.confidence === 'high';
            slot.queued = this.enqueue(event, `${incident.id}:first`);
        } else if (incident.confidence === 'high' && !slot.high) {
            slot.high = true;
            // Apply any newly appended acknowledgement before notifying again.
            this.pollAcks();
            if (!slot.acked) this.notify(slot, 'incident_escalated', `${incident.id}:high`);
        }
    }
    delivered(event: AgentGuardEvent): void {
        const slot = event.incident && this.slots.get(event.incident.id);
        if (!slot || slot.alerted !== undefined) return;
        slot.alerted = Date.parse(event.ts);
        slot.next = slot.alerted + this.after;
    }
    private pollAcks(): boolean {
        if (!this.reader) return true;
        try {
            return this.reader.poll(value => {
                if (!value || typeof value !== 'object') return;
                const record = value as { event?: unknown; ts?: unknown; incident?: { id?: unknown } };
                if (record.event !== 'incident_ack' || typeof record.ts !== 'string' || !Number.isFinite(Date.parse(record.ts)) || typeof record.incident?.id !== 'string') return;
                const slot = this.slots.get(record.incident.id);
                if (slot) slot.acked = true;
            });
        } catch { return false; /* Defer reminders while the ack file is unreadable. */ }
    }
    tick(): void {
        if (!this.config.escalation?.enabled) return;
        const caughtUp = this.pollAcks(), now = this.now();
        for (const [id, slot] of this.slots) {
            if (now >= slot.expires) { this.slots.delete(id); continue; }
            if (!caughtUp || slot.acked || slot.alerted === undefined || slot.reminders >= this.max || now < slot.next) continue;
            slot.reminders++;
            slot.next = now + this.after;
            this.notify(slot, 'incident_reminder', `${id}:reminder:${slot.reminders}`);
        }
    }
    private notify(slot: Slot, type: 'incident_escalated' | 'incident_reminder', key: string): void {
        const now = this.now(), original = slot.event.incident!;
        const event: AgentGuardEvent = { ...slot.event, ts: new Date(now).toISOString(), event_id: ulid(), event: type, severity: 'high',
            incident: { ...original, dwell_ms: Math.max(0, Math.floor(now - Date.parse(original.first_touch_at ?? original.first_seen))),
                ...(slot.alerted === undefined ? {} : { alerted_at: new Date(slot.alerted).toISOString() }) } };
        this.emit(event);
        this.enqueue(event, key);
    }
}
