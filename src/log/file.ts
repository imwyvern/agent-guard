import { constants, openSync, closeSync, fstatSync, fchmodSync, ftruncateSync, lstatSync, readSync, writeSync } from 'node:fs';
import { resolve, parse, join, sep } from 'node:path';

export const defaultLogMaxBytes = 10 * 1024 * 1024;
const chunkBytes = 64 * 1024;
export const maxJsonlLineBytes = 64 * 1024;

/** Parent directories must already exist. Check every component, not just the leaf.
 * O_NOFOLLOW also protects the final open against a leaf replacement race. */
export function openRegularLog(path: string, writable = false): number {
    const absolute = resolve(path), root = parse(absolute).root;
    let parent = root;
    const parts = absolute.slice(root.length).split(sep);
    for (const part of parts.slice(0, -1)) {
        parent = join(parent, part);
        const stat = lstatSync(parent);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe log');
    }
    const fd = openSync(absolute, (writable ? constants.O_RDWR | constants.O_APPEND | constants.O_CREAT : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe log');
        if (writable) fchmodSync(fd, 0o600);
        return fd;
    } catch (error) { closeSync(fd); throw error; }
}

/** Synchronous, bounded single-line writes. Callers isolate I/O failures. No mkdir,
 * persistent descriptors, queued buffers or full-file reads. External rotation works. */
export function appendJsonl(path: string, value: unknown, maxBytes?: number): void {
    let line = Buffer.from(JSON.stringify(value) + '\n');
    if (line.length > maxJsonlLineBytes || (maxBytes !== undefined && line.length > maxBytes)) return;
    const fd = openRegularLog(path, true);
    try {
        const size = fstatSync(fd).size;
        const last = Buffer.alloc(1);
        if (size && readSync(fd, last, 0, 1, size - 1) && last[0] !== 10) line = Buffer.concat([Buffer.from('\n'), line]);
        if (maxBytes !== undefined && size + line.length > maxBytes) {
            ftruncateSync(fd, 0);
            if (line[0] === 10) line = line.subarray(1);
        }
        // One O_APPEND write keeps concurrent CLI acknowledgements separate.
        if (writeSync(fd, line) !== line.length) throw new Error('short log write');
    } finally { closeSync(fd); }
}

/** Incremental JSONL reader. Oversized/malformed lines are discarded. poll() does
 * at most budget bytes of work, even when a producer outpaces the reader. */
export class JsonlReader {
    private offset = 0;
    private identity = '';
    private pending = Buffer.alloc(0);
    private dropping = false;
    private anchor = Buffer.alloc(0);
    constructor(private readonly path: string) {}
    poll(visit: (value: unknown) => void, budget = 256 * 1024): boolean {
        const fd = openRegularLog(this.path);
        try {
            const stat = fstatSync(fd), identity = `${stat.dev}:${stat.ino}`;
            const anchor = Buffer.alloc(this.anchor.length);
            if (this.offset >= anchor.length) readSync(fd, anchor, 0, anchor.length, this.offset - anchor.length);
            if (identity !== this.identity || stat.size < this.offset || !anchor.equals(this.anchor)) {
                this.offset = 0; this.pending = Buffer.alloc(0); this.dropping = false;
            }
            this.identity = identity;
            const end = Math.min(stat.size, this.offset + budget), chunk = Buffer.alloc(chunkBytes);
            while (this.offset < end) {
                const count = readSync(fd, chunk, 0, Math.min(chunk.length, end - this.offset), this.offset);
                if (!count) break;
                this.offset += count;
                let start = 0;
                for (let i = 0; i < count; i++) if (chunk[i] === 10) {
                    this.part(chunk.subarray(start, i));
                    this.finish(visit);
                    start = i + 1;
                }
                this.part(chunk.subarray(start, count));
            }
            this.anchor = Buffer.alloc(Math.min(32, this.offset));
            readSync(fd, this.anchor, 0, this.anchor.length, this.offset - this.anchor.length);
            return this.offset >= stat.size;
        } finally { closeSync(fd); }
    }
    private part(bytes: Buffer): void {
        if (this.dropping) return;
        if (this.pending.length + bytes.length > maxJsonlLineBytes) {
            this.pending = Buffer.alloc(0); this.dropping = true;
        } else this.pending = Buffer.concat([this.pending, bytes]);
    }
    /** CLI readers may accept a complete JSON record without a terminal newline.
     * Live ack polling waits for the newline so partial appends are never applied. */
    finish(visit: (value: unknown) => void): void {
        if (!this.dropping && this.pending.length) {
            let value: unknown;
            try { value = JSON.parse(this.pending.toString('utf8')); } catch { /* Skip malformed input. */ }
            if (value !== undefined) visit(value);
        }
        this.pending = Buffer.alloc(0); this.dropping = false;
    }
}
