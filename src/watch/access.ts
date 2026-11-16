import { createHash } from 'node:crypto';
import { Registry } from '../canary/registry.js';
import { scanRequest } from '../canary/scan.js';
import { DecoyRoutes } from '../decoys/responses.js';
import { claimedCrawler, classifyUA } from '../crawler/ua.js';
import { sanitizeEvent } from '../core/security-core.js';
import { ulid } from '../core/ulid.js';
import type { AgentGuardConfig, AgentGuardEvent, AGRequest } from '../types.js';
import { boundedInteger, DEFAULT_MAX_EVENTS_PER_MINUTE, DEFAULT_MAX_LINE_BYTES } from './parser.js';
import { unsafeText } from './syntax.js';
import { createWatchSession, type WatchSession } from './monitor.js';

export type AccessFormat = 'combined' | 'common' | 'json';
export type AccessFields = Record<'path' | 'status' | 'ua' | 'ip' | 'time', string>;
export interface AccessOptions {
    format: AccessFormat;
    fields?: Partial<AccessFields>;
    config: AgentGuardConfig;
    maxLineBytes?: number;
    maxEventsPerMinute?: number;
    now?: () => number;
}
interface RecordLine { target: string; method: string; status: number; ua: string; ip: string; time: string }
/** Quoted fields accept the standard backslash escapes, without backtracking. */
function words(line: string): string[] | undefined {
    const result: string[] = [];
    for (let i = 0; i < line.length;) {
        if (line[i] === ' ' || line[i] === '\t') { i++; continue; }
        const close = line[i] === '"' ? '"' : line[i] === '[' ? ']' : undefined;
        let word = '';
        if (close) {
            i++;
            while (i < line.length && line[i] !== close) {
                if (line[i] === '\\' && close === '"') {
                    i++;
                    if (line[i] === 'x' && /^[a-fA-F0-9]{2}$/.test(line.slice(i + 1, i + 3))) {
                        word += String.fromCharCode(Number.parseInt(line.slice(i + 1, i + 3), 16)); i += 3; continue;
                    }
                }
                if (i === line.length) return;
                word += line[i++];
            }
            if (line[i++] !== close || (i < line.length && line[i] !== ' ' && line[i] !== '\t')) return;
        } else while (i < line.length && line[i] !== ' ' && line[i] !== '\t') word += line[i++];
        result.push(word);
    }
    return result;
}
function timestamp(input: string, now: number): string {
    const match = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{4})$/.exec(input);
    const time = Date.parse(match ? `${match[1]} ${match[2]} ${match[3]} ${match[4]} ${match[5]}` : input);
    return new Date(Number.isFinite(time) ? time : now).toISOString();
}
export function createAccessLogParser(options: AccessOptions): { parseLine(line: string): AgentGuardEvent[]; reset(): void } {
    if (!['common', 'combined', 'json'].includes(options.format) || options.config.mode !== 'detect') throw new Error('invalid access-log options');
    const cap = boundedInteger(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES, 1024 * 1024);
    const rate = boundedInteger(options.maxEventsPerMinute ?? DEFAULT_MAX_EVENTS_PER_MINUTE, 100000);
    const fields: AccessFields = { path: 'path', status: 'status', ua: 'ua', ip: 'ip', time: 'time', ...options.fields };
    const config = options.config, routes = new DecoyRoutes(config);
    const registry = new Registry(config.canary.registry, config.canary.secret, config.canary.prefix ?? 'AG-CANARY-');
    const now = options.now ?? Date.now;
    let start = now(), count = 0;
    function parse(line: string): RecordLine | undefined {
        if (options.format === 'json') {
            const value: unknown = JSON.parse(line);
            if (!value || typeof value !== 'object' || Array.isArray(value)) return;
            const record = value as Record<string, unknown>;
            const target = record[fields.path], status = Number(record[fields.status]);
            if (typeof target !== 'string' || !Number.isInteger(status) || status < 100 || status > 599) return;
            const str = (key: keyof AccessFields) => typeof record[fields[key]] === 'string' ? record[fields[key]] as string : '';
            return { target, status, method: 'GET', ua: str('ua'), ip: str('ip'), time: str('time') };
        }
        const parts = words(line);
        if (!parts || parts.length !== (options.format === 'common' ? 7 : 9)) return;
        const request = parts[4]!.split(' '), status = Number(parts[5]);
        if (request.length !== 3 || !request[2]!.startsWith('HTTP/') || !Number.isInteger(status) || status < 100 || status > 599) return;
        return { target: request[1]!, method: request[0]!, status, ip: parts[0]!, time: parts[3]!, ua: parts[8] ?? '' };
    }
    return {
        reset() { /* Rate budgets survive rotation so rotation cannot reset the cap. */ },
        parseLine(line) {
            if (!line || line.length > cap || Buffer.byteLength(line) > cap || unsafeText(line.replace(/\r$/, ''))) return [];
            try {
                const record = parse(line.trimEnd());
                if (!record) return [];
                // JSON path fields may also be a complete request line.
                if (!record.target.startsWith('/') && !record.target.startsWith('http')) {
                    const parts = record.target.split(' ');
                    if (parts.length !== 3) return [];
                    record.method = parts[0]!; record.target = parts[1]!;
                }
                const url = new URL(record.target, 'http://local.invalid');
                const query = Object.create(null) as AGRequest['query'];
                for (const [key, value] of url.searchParams) {
                    const old = query[key];
                    if (old === undefined) query[key] = value;
                    else if (Array.isArray(old)) old.push(value);
                    else query[key] = [old, value];
                }
                const request: AGRequest = { path: url.pathname, method: record.method, query, headers: {}, ip: record.ip };
                const hits = scanRequest(request, registry, config, false);
                const id = routes.match(request.path, request.method);
                const time = now();
                if (time - start >= 60000) { start = time; count = 0; }
                const claimed = claimedCrawler(record.ua);
                const base = { v: 1 as const, ts: timestamp(record.time, time), project: config.project, env: config.env, source: 'access_log' as const,
                    req: { method: request.method, path: hits.reduce((path, hit) => path.replaceAll(hit.entry.token, '[canary]'), request.path),
                        client_key: createHash('sha256').update(record.ip + '\n' + record.ua).digest('hex').slice(0, 24), ip: record.ip, ua: record.ua, ua_class: classifyUA(record.ua) },
                    ...(claimed ? { crawler: { claimed, verified: false, cache: false } } : {}) };
                const events: AgentGuardEvent[] = [];
                for (const hit of hits) events.push({ ...base, event_id: ulid(), event: 'canary_replay', severity: 'critical',
                    canary: { id: hit.entry.id, placement: hit.entry.placement, env: hit.entry.env, found_in: hit.found_in, field: hit.field } });
                if (id) events.push({ ...base, event_id: ulid(), event: 'decoy_hit', severity: id === 'D1' || id === 'D3' ? 'high' : 'medium', decoy: { id, status: record.status } });
                const admitted = events.slice(0, Math.max(0, rate - count)); count += admitted.length;
                return admitted.map(sanitizeEvent);
            } catch { return []; }
        },
    };
}
export function createAccessWatcher(options: AccessOptions & { logPath: string; fromStart?: boolean; intervalMs?: number; sink: (event: AgentGuardEvent) => void }): WatchSession {
    return createWatchSession({ ...options, alerts: options.config.alerts }, createAccessLogParser(options));
}
