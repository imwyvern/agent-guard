import { Dispatcher } from '../alerts/dispatcher.js';
import { sanitizeEvent } from '../core/security-core.js';
import type { AgentGuardConfig, AgentGuardEvent } from '../types.js';
import { createLogFollower } from './follower.js';
import { boundedInteger, createLogParser, type ParserOptions } from './parser.js';

export interface WatchOptions extends ParserOptions {
    logPath: string;
    fromStart?: boolean;
    intervalMs?: number;
    alerts?: AgentGuardConfig['alerts'];
    sink: (event: AgentGuardEvent) => void;
}
export interface WatchSession {
    tick(): AgentGuardEvent[];
    start(): void;
    flush(): Promise<void>;
    close(): Promise<void>;
}

export function createWatcher(options: WatchOptions): WatchSession {
    const interval = boundedInteger(options.intervalMs ?? 500, 60000);
    const parser = createLogParser(options);
    const follower = createLogFollower(options.logPath, { fromStart: options.fromStart, maxLineBytes: options.maxLineBytes, onReset: parser.reset });
    // Delivery status is kept out of the hit JSONL stream. All notification
    // delivery, redaction, retries and deduplication belong to the dispatcher.
    const dispatcher = new Dispatcher({ ...options.alerts, adapters: options.alerts?.adapters ?? [], minSeverity: options.alerts?.minSeverity ?? 'medium' }, () => {});
    let timer: ReturnType<typeof setInterval> | undefined, closed = false;
    const session: WatchSession = {
        tick() {
            if (closed) return [];
            const events: AgentGuardEvent[] = [];
            follower.tick(line => {
                for (const event of parser.parseLine(line)) {
                    const clean = sanitizeEvent(event);
                    events.push(clean);
                    options.sink(clean);
                    dispatcher.enqueue(clean);
                }
            });
            return events;
        },
        start() {
            if (closed || timer) return;
            session.tick();
            timer = setInterval(() => session.tick(), interval);
        },
        flush: () => dispatcher.flush(),
        async close() {
            closed = true;
            clearInterval(timer);
            await dispatcher.close();
        },
    };
    return session;
}
