import { existsSync } from 'node:fs';
import { appendJsonl, JsonlReader } from '../log/file.js';
import { sanitizeHeader } from '../core/security-core.js';
import { ulid } from '../core/ulid.js';
import type { AgentGuardEvent } from '../types.js';

export const INCIDENT_USAGE = 'agent-guard incident list --log <jsonl> [--json]\nagent-guard incident show <id> --log <jsonl> [--json]\nagent-guard incident ack <id> --log <jsonl>';
export const INCIDENT_ERROR = 'incident: invalid options or unreadable/unsafe log\n' + INCIDENT_USAGE;
interface TimelineEntry { ts: string; event: string; event_id?: string; path?: string; status?: number }
interface Timeline {
    id: string;
    first_touch_at: string;
    last_seen: string;
    alerted_at?: string;
    acknowledged: boolean;
    timeline: TimelineEntry[];
    incident: NonNullable<AgentGuardEvent['incident']>;
}
interface View { incidents: Timeline[]; adjacent: TimelineEntry[]; truncated: boolean }
const eventNames = new Set(['decoy_hit', 'canary_replay', 'probe', 'ai_discovery', 'crawler_bypass', 'alert_sent', 'alert_failed', 'trap_block', 'trap_circuit_open', 'exhaust_budget_spent', 'canary_callback', 'honeyfile_read', 'incident_ack', 'incident_escalated', 'incident_reminder']);
const steps = new Set(['robots', 'D1', 'D2', 'D3', 'D4', 'D5', 'MCP', 'GQL', 'probe', 'ai_discovery', 'canary_replay', 'incident_ack']);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === 'string' ? value.includes('-CANARY-') ? '[redacted]' : sanitizeHeader(value) : undefined;
const date = (value: unknown): string | undefined => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;

/** Streaming reconstruction: at most 50k incident groups, last 32 records each,
 * and 32 adjacent records. No client/IP heuristics across processes. */
export function readIncidentLog(path: string, onlyId?: string): View {
    const groups = new Map<string, Timeline>(), adjacent: TimelineEntry[] = [];
    let truncated = false;
    const visit = (value: unknown): void => {
        const record = object(value), event = string(record.event), ts = date(record.ts);
        if (!event || !eventNames.has(event) || !ts) return;
        const raw = object(record.incident), id = string(raw.id);
        const entry: TimelineEntry = { ts, event, event_id: string(record.event_id),
            // Only a projected, bounded path is displayed, never arbitrary fields.
            path: string(object(record.honeyfile).path ?? object(record.req).path) };
        const status = object(record.decoy).status;
        if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) entry.status = status;
        if (!id) {
            adjacent.push(entry);
            if (adjacent.length > 32) { adjacent.shift(); truncated = true; }
            return;
        }
        if (onlyId && id !== onlyId) return;
        let group = groups.get(id);
        const first = date(raw.first_touch_at) ?? date(raw.first_seen) ?? ts;
        if (!group) {
            if (groups.size === 50_000) { groups.delete(groups.keys().next().value!); truncated = true; }
            group = { id, first_touch_at: first, last_seen: ts, acknowledged: false, timeline: [],
                incident: { id, first_seen: first, last_seen: ts, sequence: ['incident_ack'], confidence: 'low' } };
        }
        groups.delete(id); groups.set(id, group);
        if (first < group.first_touch_at) group.first_touch_at = first;
        if (ts > group.last_seen) group.last_seen = ts;
        group.acknowledged ||= event === 'incident_ack';
        const alerted = date(raw.alerted_at) ?? (event === 'alert_sent' ? ts : undefined);
        if (alerted && (!group.alerted_at || alerted < group.alerted_at)) group.alerted_at = alerted;
        if (Array.isArray(raw.sequence)) {
            const sequence = raw.sequence.slice(-32).filter((step): step is string => typeof step === 'string' && steps.has(step));
            if (sequence.length) group.incident.sequence = sequence;
        }
        if (raw.confidence === 'low' || raw.confidence === 'medium' || raw.confidence === 'high') group.incident.confidence = raw.confidence;
        group.incident.first_seen = group.first_touch_at;
        group.incident.last_seen = group.last_seen;
        group.incident.first_touch_at = group.first_touch_at;
        if (group.alerted_at) group.incident.alerted_at = group.alerted_at;
        group.timeline.push(entry);
        if (group.timeline.length > 32) { group.timeline.shift(); truncated = true; }
    };
    const reader = new JsonlReader(path);
    while (!reader.poll(visit)) { /* Fixed chunks; retained state stays bounded. */ }
    reader.finish(visit);
    for (const group of groups.values()) group.timeline.sort((a, b) => a.ts.localeCompare(b.ts));
    return { incidents: [...groups.values()], adjacent, truncated };
}

export function runIncident(args: string[], out: (line: string) => void): number {
    try {
        const action = args[0];
        if (!['list', 'show', 'ack'].includes(action ?? '')) throw new Error();
        let index = 1;
        const id = action === 'list' ? undefined : args[index++];
        if (action !== 'list' && (!id || id.startsWith('--') || id.includes('-CANARY-') || id.length > 512 || sanitizeHeader(id) !== id)) throw new Error();
        let path: string | undefined, json = false;
        for (; index < args.length; index++) {
            if (args[index] === '--log' && path === undefined) {
                path = args[++index];
                if (!path?.trim() || path.startsWith('--')) throw new Error();
            } else if (args[index] === '--json' && !json && action !== 'ack') json = true;
            else throw new Error();
        }
        if (!path) throw new Error();
        const view = action === 'ack' && !existsSync(path) ? { incidents: [], adjacent: [], truncated: false } : readIncidentLog(path, id);
        const group = view.incidents.find(item => item.id === id);
        if (action === 'ack') {
            const ts = new Date().toISOString();
            const incident = group?.incident ?? { id: id!, sequence: ['incident_ack'], first_seen: ts, last_seen: ts, confidence: 'low' as const };
            const ack: AgentGuardEvent = { v: 1, ts, event_id: ulid(), event: 'incident_ack', severity: 'info', project: 'incident-cli', env: 'local',
                req: { method: 'CLI', path: '', client_key: '' },
                incident: { ...incident, last_seen: ts, first_touch_at: group?.first_touch_at ?? ts,
                    dwell_ms: Math.max(0, Date.parse(ts) - Date.parse(incident.first_seen)) } };
            appendJsonl(path, ack); // Append only: never apply log.file truncation to an ack.
            out(`Acknowledged ${id}`);
            return 0;
        }
        if (action === 'show' && !group) throw new Error();
        if (json) out(JSON.stringify(action === 'show' ? { ...group, adjacent: view.adjacent, truncated: view.truncated } : view));
        else {
            for (const item of action === 'show' ? [group!] : view.incidents) {
                out(`${item.id} ${item.acknowledged ? 'acknowledged' : 'unacknowledged'}`);
                out(`  ${item.first_touch_at} first_touch`);
                for (const entry of item.timeline) out(`  ${entry.ts} ${entry.event}${entry.status === 429 ? ' rate-limit' : ''}${entry.path ? ' ' + entry.path : ''}`);
            }
            for (const entry of view.adjacent) out(`log-adjacent ${entry.ts} ${entry.event}${entry.path ? ' ' + entry.path : ''}`);
            if (view.truncated) out('Timeline limited to the most recent retained records.');
        }
        return 0;
    } catch {
        out(INCIDENT_ERROR);
        return 2;
    }
}
