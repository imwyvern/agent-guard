import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadRegistry } from '../canary/registry.js';
import { alphabet } from '../core/ulid-core.js';
import { absolutePath, checkDirectories, checkTarget, destination, seedRoot } from '../seed/paths.js';
import { profiles, type SeedManifest } from '../seed/plan.js';
import type { CanaryRegistry } from '../types.js';
import { hasOnly } from './syntax.js';

export interface HoneyfileTarget {
    path: string;
    placement: string;
    absolutePaths: string[];
}

/** Never follow a symlink, including in an ancestor, or open a device/FIFO. */
export function openRegular(path: string): number {
    checkDirectories(dirname(path));
    checkTarget(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        if (!fstatSync(fd).isFile()) throw new Error('watch requires regular files');
        return fd;
    } catch (error) { closeSync(fd); throw error; }
}

function readMetadata(path: string): string {
    const fd = openRegular(absolutePath(path));
    try {
        if (fstatSync(fd).size > 1024 * 1024) throw new Error('watch metadata is too large');
        return readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
}

export function loadHoneyfiles(directory: string, manifestPath: string, env: string, registryPath?: string): HoneyfileTarget[] {
    const root = seedRoot(directory, false);
    const value = JSON.parse(readMetadata(manifestPath)) as SeedManifest;
    if (!value || value.version !== 1 || typeof value.profile !== 'string' || !Object.hasOwn(profiles, value.profile) || value.env !== env ||
        !Array.isArray(value.files) || value.files.length !== profiles[value.profile].length)
        throw new Error('watch requires a matching seed manifest and env');
    // Validate a supplied registry through the existing loader, without reading
    // unsafe paths or ever reflecting its contents into an error or event.
    const registryValue: unknown = registryPath ? JSON.parse(readMetadata(registryPath)) : undefined;
    if (registryPath && (!registryValue || typeof registryValue !== 'object' || Array.isArray(registryValue)))
        throw new Error('watch registry must be an object');
    const registry = registryPath ? loadRegistry(registryValue as CanaryRegistry) : undefined;
    const seen = new Set<string>();
    return value.files.map(file => {
        if (!file || typeof file.path !== 'string') throw new Error('invalid watch manifest');
        const target = destination(root, file.path);
        if (!(profiles[value.profile] as readonly string[]).includes(file.path) || seen.has(file.path) || file.mode !== '0600' ||
            typeof file.canaryId !== 'string' || file.canaryId.length !== 12 || ![...file.canaryId].every(char => alphabet.includes(char)) ||
            typeof file.sha256 !== 'string' || file.sha256.length !== 64 || !hasOnly(file.sha256, 'abcdef0123456789'))
            throw new Error('invalid watch manifest');
        seen.add(file.path);
        const placement = `honeyfile:${value.profile}:${file.path}`;
        if (registry && !registry.canaries.some(entry => entry.id === file.canaryId && entry.env === env && entry.placement === placement))
            throw new Error('watch registry does not match manifest');
        const fd = openRegular(target);
        try { return { path: file.path, placement, absolutePaths: [...new Set([target, realpathSync(target)])] }; }
        finally { closeSync(fd); }
    });
}
