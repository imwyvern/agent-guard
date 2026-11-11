import { webhookAdapter } from '../alerts/webhook.js';
import type { AgentGuardConfig, AlertAdapter } from '../types.js';
import type { HookDependencies } from '../hooks/runner.js';
import { loadHoneyfiles } from '../watch/files.js';
import { createWatcher, type WatchSession } from '../watch/monitor.js';
import { boundedInteger } from '../watch/parser.js';
import { digits, hasOnly } from '../watch/syntax.js';

export const WATCH_USAGE = 'agent-guard watch (--auditd <logfile> | --inotify-log <logfile>) --dir <path> --manifest <path> --project <name> --env <name> [--registry <file>] [--interval-ms <n>] [--from-start] [--max-line-bytes <n>] [--max-events-per-minute <n>]';

export interface WatchDependencies {
    adapters?: AlertAdapter[];
    hooks?: AgentGuardConfig['hooks'];
    hookDependencies?: HookDependencies;
    start?: (session: WatchSession) => void;
}

export function createWatchFromArgs(args: string[], out: (line: string) => void, dependencies: WatchDependencies = {}): WatchSession {
    if (process.platform !== 'linux') throw new Error('watch requires Linux');
    const keys = new Set(['auditd', 'inotify-log', 'dir', 'manifest', 'project', 'env', 'registry', 'interval-ms', 'max-line-bytes', 'max-events-per-minute']);
    const options = new Map<string, string>();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!, key = arg.slice(2);
        if (!arg.startsWith('--') || options.has(key) || (!keys.has(key) && key !== 'from-start')) throw new Error(WATCH_USAGE);
        if (key === 'from-start') options.set(key, 'true');
        else {
            const value = args[++i];
            if (!value?.trim() || value.startsWith('--')) throw new Error(WATCH_USAGE);
            options.set(key, value);
        }
    }
    if (options.has('auditd') === options.has('inotify-log') || ['dir', 'manifest', 'project', 'env'].some(key => !options.has(key))) throw new Error(WATCH_USAGE);
    const numeric = (key: string, maximum: number): number | undefined => {
        const value = options.get(key);
        if (value === undefined) return;
        if (!hasOnly(value, digits)) throw new Error(WATCH_USAGE);
        return boundedInteger(Number(value), maximum);
    };
    const source = options.has('auditd') ? 'auditd' : 'inotify';
    const targets = loadHoneyfiles(options.get('dir')!, options.get('manifest')!, options.get('env')!, options.get('registry'));
    const url = process.env.AG_ALERT_WEBHOOK_URL, secret = process.env.AG_ALERT_WEBHOOK_SECRET;
    const adapters = dependencies.adapters ?? (url && secret ? [webhookAdapter({ url, secret })] : []);
    return createWatcher({
        source, targets, project: options.get('project')!, env: options.get('env')!,
        logPath: options.get(source === 'auditd' ? 'auditd' : 'inotify-log')!, fromStart: options.has('from-start'),
        intervalMs: numeric('interval-ms', 60000), maxLineBytes: numeric('max-line-bytes', 1024 * 1024),
        maxEventsPerMinute: numeric('max-events-per-minute', 100000),
        hooks: dependencies.hooks, hookDependencies: dependencies.hookDependencies,
        alerts: { adapters, minSeverity: 'medium' }, sink: event => out(JSON.stringify(event)),
    });
}

export function runWatch(args: string[], out: (line: string) => void, dependencies: WatchDependencies = {}): number {
    try {
        const session = createWatchFromArgs(args, out, dependencies);
        if (dependencies.start) dependencies.start(session);
        else {
            const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); void session.close(); };
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
            session.start();
        }
        return 0;
    } catch {
        // Native/JSON errors may include operator paths, credentials or input
        // fragments. Only a fixed diagnostic is safe to reflect.
        out('watch: invalid options or unreadable/unsafe input files\n' + WATCH_USAGE);
        return 2;
    }
}
