import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { sanitizeEvent } from '../core/security-core.js';
import { ulid } from '../core/ulid.js';
import type { AgentGuardEvent } from '../types.js';
import type { HoneyfileTarget } from './files.js';
import { digits, hasOnly, hexDigits, letters, space, unsafeText } from './syntax.js';

export const DEFAULT_MAX_LINE_BYTES = 16 * 1024;
export const DEFAULT_MAX_EVENTS_PER_MINUTE = 60;
export interface ParserOptions {
    source: 'auditd' | 'inotify';
    targets: HoneyfileTarget[];
    project: string;
    env: string;
    maxLineBytes?: number;
    maxEventsPerMinute?: number;
    maxPending?: number;
    now?: () => number;
}

export function boundedInteger(value: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('invalid watch limit');
    return value;
}

/** Audit escapes decode to bytes, never to allocation sizes or code points. */
function decode(value: string, quoted: boolean, cap: number): string | undefined {
    if (!quoted && value.length % 2 === 0 && hasOnly(value, hexDigits)) {
        value = Buffer.from(value, 'hex').toString('utf8');
    } else {
        const decoded = Buffer.alloc(Buffer.byteLength(value));
        let used = 0, cursor = 0;
        while (cursor < value.length) {
            const at = value.indexOf('\\', cursor);
            if (at < 0) { used += decoded.write(value.slice(cursor), used); break; }
            used += decoded.write(value.slice(cursor, at), used);
            cursor = at + 1;
            const escape = value[cursor++];
            let byte: number;
            if (escape === '"' || escape === '\\') byte = escape.charCodeAt(0);
            else if (escape === 'x') {
                const hex = value.slice(cursor, cursor + 2);
                if (hex.length !== 2 || !hasOnly(hex, hexDigits)) return;
                byte = Number.parseInt(hex, 16); cursor += 2;
            } else if (escape && '01234567'.includes(escape)) {
                let octal = escape;
                while (octal.length < 3 && value[cursor] && '01234567'.includes(value[cursor]!)) octal += value[cursor++];
                byte = Number.parseInt(octal, 8);
            } else return;
            if (byte > 255) return;
            decoded[used++] = byte;
        }
        value = decoded.subarray(0, used).toString('utf8');
    }
    if (unsafeText(value) || Buffer.byteLength(value) > cap) return;
    return value;
}

function fields(line: string): Map<string, { value: string; quoted: boolean }> {
    const result = new Map<string, { value: string; quoted: boolean }>();
    let cursor = 0;
    while (cursor < line.length) {
        while (space(line[cursor])) cursor++;
        const start = cursor;
        while (cursor < line.length && !space(line[cursor]) && line[cursor] !== '=') cursor++;
        if (line[cursor] !== '=') continue;
        const key = line.slice(start, cursor++);
        const quoted = line[cursor] === '"';
        if (quoted) cursor++;
        const valueStart = cursor;
        if (quoted) {
            while (cursor < line.length && line[cursor] !== '"') cursor += line[cursor] === '\\' ? 2 : 1;
            if (line[cursor] !== '"') return new Map();
        } else while (cursor < line.length && !space(line[cursor])) cursor++;
        const value = line.slice(valueStart, cursor);
        if (quoted) cursor++;
        if (cursor < line.length && !space(line[cursor])) return new Map();
        if (!hasOnly(key.slice(0, 1), letters + '_') || !hasOnly(key, letters + digits + '_')) continue;
        if (result.has(key) || (!quoted && value.includes('"'))) return new Map();
        result.set(key, { value, quoted });
    }
    return result;
}

function auditMessage(value: string): { timestamp: string; serial: string } | undefined {
    if (!value.startsWith('audit(') || (!value.endsWith('):') && !value.endsWith(')'))) return;
    const body = value.slice(6, value.endsWith('):') ? -2 : -1), colon = body.indexOf(':');
    const timestamp = body.slice(0, colon), serial = body.slice(colon + 1);
    if (colon < 1 || timestamp.length > 64 || timestamp.includes('(') || timestamp.includes(')') ||
        [...timestamp].some(space) || serial.length > 24 || !hasOnly(serial, digits)) return;
    return { timestamp, serial };
}

function previousWord(line: string, end: number): { start: number; word: string } {
    while (end > 0 && space(line[end - 1])) end--;
    let start = end;
    while (start > 0 && !space(line[start - 1])) start--;
    return { start, word: line.slice(start, end) };
}

function accessToken(value: string): boolean {
    const tokens = value.split(',');
    return tokens.includes('ACCESS') && tokens.every(token => hasOnly(token, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_'));
}

interface ProcessInfo { uid?: string; comm?: string }

export function createLogParser(options: ParserOptions): {
    parseLine(line: string): AgentGuardEvent[];
    reset(): void;
    readonly pendingCount: number;
} {
    const cap = boundedInteger(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES, 1024 * 1024);
    const rate = boundedInteger(options.maxEventsPerMinute ?? DEFAULT_MAX_EVENTS_PER_MINUTE, 100000);
    const pendingCap = boundedInteger(options.maxPending ?? 1024, 10000);
    const now = options.now ?? Date.now;
    const paths = new Map(options.targets.flatMap(target => target.absolutePaths.map(path => [path, target] as const)));
    const pending = new Map<string, ProcessInfo>();
    let start = now(), count = 0;

    function emit(path: string, timestamp?: string, process: ProcessInfo = {}): AgentGuardEvent[] {
        if (!isAbsolute(path)) return [];
        const target = paths.get(resolve(path));
        if (!target) return [];
        const time = now();
        if (time - start >= 60000) { start = time; count = 0; }
        if (count >= rate) return [];
        count++;
        const parsed = timestamp === undefined ? NaN : Number(timestamp) * 1000;
        const date = new Date(parsed);
        const ts = Number.isFinite(date.getTime()) ? date.toISOString() : new Date(time).toISOString();
        return [sanitizeEvent({
            v: 1, ts, event_id: ulid(), event: 'honeyfile_read', severity: 'medium', project: options.project, env: options.env,
            req: {
                method: 'READ', path: target.path,
                client_key: createHash('sha256').update(JSON.stringify([process.uid ?? '', process.comm ?? '', target.path])).digest('hex').slice(0, 24),
            },
            honeyfile: { path: target.path, placement: target.placement, source: options.source, ...process },
        })];
    }

    return {
        get pendingCount() { return pending.size; },
        reset() { pending.clear(); },
        parseLine(input) {
            if (!input || input.length > cap || Buffer.byteLength(input) > cap) return [];
            const line = input.endsWith('\r') ? input.slice(0, -1) : input;
            if (unsafeText(line)) return [];
            if (options.source === 'inotify') {
                if (!line.startsWith('/')) return [];
                // Seed basenames contain no spaces; scan from the right so
                // spaces (or event-like words) in directory names stay intact.
                const last = previousWord(line, line.length);
                if (accessToken(last.word)) return emit(line.slice(0, last.start).trimEnd());
                const event = previousWord(line, last.start), base = line.slice(0, event.start).trimEnd();
                return accessToken(event.word) && base.endsWith('/') ? emit(base + last.word) : [];
            }
            const record = fields(line), type = record.get('type')?.value;
            const audit = auditMessage(record.get('msg')?.value ?? '');
            if (!audit || (type !== 'SYSCALL' && type !== 'PATH')) return [];
            const serial = `${audit.timestamp}:${audit.serial}`;
            if (type === 'SYSCALL') {
                const uid = record.get('uid')?.value;
                const name = record.get('comm') ?? record.get('exe');
                const comm = name ? decode(name.value, name.quoted, cap) : undefined;
                const process: ProcessInfo = { ...(uid && uid.length <= 20 && hasOnly(uid, digits) ? { uid } : {}), ...(comm ? { comm } : {}) };
                pending.delete(serial);
                pending.set(serial, process);
                if (pending.size > pendingCap) pending.delete(pending.keys().next().value!);
                return [];
            }
            const name = record.get('name');
            const path = name ? decode(name.value, name.quoted, cap) : undefined;
            return path ? emit(path, audit.timestamp, pending.get(serial)) : [];
        },
    };
}
