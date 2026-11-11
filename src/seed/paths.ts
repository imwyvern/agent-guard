import { constants, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { SeedError } from './errors.js';

export function statPath(path: string): Stats | undefined {
    try { return lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}

/** Validate segments before resolve() can erase a symlink/.. combination. */
export function absolutePath(path: string): string {
    if (!path || path.includes('\0') || path.replaceAll('\\', '/').split('/').includes('..')) throw new SeedError('seed paths must not contain parent traversal');
    return resolve(path);
}

/** Every existing ancestor must be a real directory. Missing directories are
 * created individually with mode 0700. Existing permissions stay unchanged. */
export function checkDirectories(directory: string, create = false, allowMissing = false): boolean {
    const root = parse(directory).root;
    let cursor = root;
    for (const segment of directory.slice(root.length).split(sep).filter(Boolean)) {
        cursor = resolve(cursor, segment);
        let stat = statPath(cursor);
        if (!stat && create) {
            mkdirSync(cursor, { mode: 0o700 });
            const fd = openSync(cursor, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            try { fchmodSync(fd, 0o700); }
            finally { closeSync(fd); }
            stat = lstatSync(cursor);
        }
        if (!stat) {
            if (allowMissing) return false;
            throw new SeedError('seed directory does not exist');
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SeedError('seed refuses a symlink or non-directory ancestor');
    }
    return true;
}

export function seedRoot(directory: string, allowMissing: boolean): string {
    const root = absolutePath(directory);
    return checkDirectories(root, false, allowMissing) ? realpathSync(root) : root;
}

export function destination(root: string, path: string): string {
    if (!path || isAbsolute(path) || path.includes(':') || path.includes('\\') || path.includes('\0') ||
        path.split('/').some(segment => !segment || segment === '.' || segment === '..'))
        throw new SeedError('seed destination must be a relative path without traversal');
    const target = resolve(root, path), inside = relative(root, target);
    if (!inside || isAbsolute(inside) || inside.split(sep).includes('..')) throw new SeedError('seed destination escapes its root');
    return target;
}

export function checkTarget(target: string): void {
    checkDirectories(dirname(target), false, true);
    const stat = statPath(target);
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new SeedError('seed metadata must be a regular file, never a symlink');
}

export function readRegularFile(path: string): Buffer {
    checkTarget(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { return readFileSync(fd); }
    finally { closeSync(fd); }
}

export function createHoneyfile(target: string, body: string): boolean {
    checkDirectories(dirname(target), true);
    let fd: number;
    try { fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    try { fchmodSync(fd, 0o600); writeFileSync(fd, body, 'utf8'); }
    finally { closeSync(fd); }
    return true;
}

/** Atomic metadata replacement avoids truncating an existing hardlink. It also
 * preserves metadata bytes and mtimes when the inventory has not changed. */
export function writeMetadata(path: string, value: unknown): void {
    checkTarget(path);
    const body = JSON.stringify(value, null, 2) + '\n';
    if (statPath(path) && readRegularFile(path).equals(Buffer.from(body))) return;
    checkDirectories(dirname(path), true);
    const temporary = resolve(dirname(path), `.agent-guard-seed-${randomUUID()}.tmp`);
    let created = false;
    try {
        created = createHoneyfile(temporary, body);
        if (!created) throw new SeedError('seed temporary metadata path already exists');
        checkTarget(path);
        renameSync(temporary, path);
    } finally {
        if (created && statPath(temporary)) unlinkSync(temporary);
    }
}
