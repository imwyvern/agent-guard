import { closeSync, fstatSync, readSync } from 'node:fs';
import { absolutePath } from '../seed/paths.js';
import { openRegular } from './files.js';
import { boundedInteger, DEFAULT_MAX_LINE_BYTES } from './parser.js';

export interface FollowerOptions {
    fromStart?: boolean;
    maxLineBytes?: number;
    onReset?: () => void;
}

/** Tick-driven, read-only tailer. Each tick reads at most 1 MiB. Missing or
 * unsafe replacements are retried, and partial/overlong lines stay bounded. */
export function createLogFollower(logPath: string, options: FollowerOptions = {}): {
    tick(onLine: (line: string) => void): void;
} {
    const path = absolutePath(logPath);
    const cap = boundedInteger(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES, 1024 * 1024);
    const line = Buffer.alloc(cap), chunk = Buffer.alloc(64 * 1024);
    let offset = 0, used = 0, dropping = false;
    let identity = '', anchor = Buffer.alloc(0);
    const initial = openRegular(path);
    try {
        const stat = fstatSync(initial);
        identity = `${stat.dev}:${stat.ino}`;
        offset = options.fromStart ? 0 : stat.size;
        if (offset > 0) {
            anchor = Buffer.alloc(Math.min(offset, 64));
            readSync(initial, anchor, 0, anchor.length, offset - anchor.length);
            dropping = anchor.at(-1) !== 10;
        }
    } finally { closeSync(initial); }

    return {
        tick(onLine) {
            let fd: number;
            try { fd = openRegular(path); }
            catch { return; }
            try {
                const stat = fstatSync(fd), current = `${stat.dev}:${stat.ino}`;
                let replaced = current !== identity || stat.size < offset;
                // Detect copytruncate followed by a quick rewrite that has
                // already grown beyond the old offset before the next poll.
                if (!replaced && anchor.length) {
                    const previous = Buffer.alloc(anchor.length);
                    const bytes = readSync(fd, previous, 0, previous.length, offset - previous.length);
                    replaced = bytes !== anchor.length || !previous.equals(anchor);
                }
                if (replaced) {
                    offset = 0; used = 0; dropping = false; anchor = Buffer.alloc(0);
                    options.onReset?.();
                }
                identity = current;
                let budget = 1024 * 1024;
                while (offset < stat.size && budget > 0) {
                    const bytes = readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset, budget), offset);
                    if (!bytes) break;
                    offset += bytes; budget -= bytes;
                    for (let i = 0; i < bytes; i++) {
                        const byte = chunk[i]!;
                        if (byte === 10) {
                            if (!dropping) onLine(line.subarray(0, used).toString('utf8'));
                            used = 0; dropping = false;
                        } else if (!dropping) {
                            if (used === cap) { used = 0; dropping = true; }
                            else line[used++] = byte;
                        }
                    }
                }
                anchor = Buffer.alloc(Math.min(offset, 64));
                if (anchor.length) readSync(fd, anchor, 0, anchor.length, offset - anchor.length);
            } catch { /* Rotation, truncation and transient IO never stop following. */ }
            finally { closeSync(fd); }
        },
    };
}
