import { createHash, createHmac } from 'node:crypto';
import { checksum, DEFAULT_PREFIX, verifyCanary } from '../canary/format.js';
import { formatCanary } from '../canary/format-core.js';
import { DECOY_CAP_BYTES, lintSample } from '../canary/lint-rules.js';
import { base32 } from '../core/ulid-core.js';
import { fakeData } from '../decoys/fake-data.js';
import type { CanaryEntry, CanaryRegistry } from '../types.js';
import { SeedError } from './errors.js';

export const profiles = {
    generic: ['.env.backup', 'db-connection.txt'],
    node: ['.env.backup', '.npmrc', '.aws/credentials', '.ssh/id_rsa'],
    python: ['.env.backup', '.pypirc', 'db-connection.txt'],
    k8s: ['.kube/config', '.ssh/id_rsa', '.env.backup'],
} as const;
export type SeedProfile = keyof typeof profiles;
export interface SeedFile { path: string; mode: '0600'; body: string; entry: CanaryEntry }
export interface SeedManifest {
    version: 1;
    profile: SeedProfile;
    env: string;
    callbackHost?: string;
    files: Array<{ path: string; mode: '0600'; canaryId: string; sha256: string }>;
}
export interface SeedInputs {
    profile: SeedProfile;
    env: string;
    secret: string;
    projectSeed: string;
    callbackBase?: string;
    registry: CanaryRegistry;
}

export function contentHash(body: string | Uint8Array): string { return createHash('sha256').update(body).digest('hex'); }

/** Node-only deterministic honeyfile templates. Operator strings are never copy. */
export function buildSeedPlan(input: SeedInputs, requireRecorded = false): SeedFile[] {
    const { profile, env, secret, projectSeed, registry, callbackBase } = input;
    if (registry.prefix !== DEFAULT_PREFIX) throw new SeedError('seed requires the default canary registry prefix');
    const fake = fakeData(projectSeed);
    const allowedHosts = callbackBase ? [new URL(callbackBase).hostname] : [];
    return profiles[profile].map(path => {
        const placement = `honeyfile:${profile}:${path}`;
        const recorded = registry.canaries.filter(entry => entry.placement === placement && entry.env === env);
        if (recorded.length > 1 || (requireRecorded && !recorded.length)) throw new SeedError('seed registry placement is missing or ambiguous');
        const digest = (domain: string) => createHmac('sha256', secret).update(JSON.stringify([domain, env, placement, projectSeed])).digest();
        const id = base32(digest('seed-canary:v1')).slice(0, 12);
        const entry = recorded[0] ?? {
            id, token: formatCanary(DEFAULT_PREFIX, id, checksum(DEFAULT_PREFIX, id, secret)),
            env, placement, createdAt: new Date().toISOString(),
        };
        const verified = verifyCanary(entry.token, { secret });
        if (!verified.valid || verified.id !== entry.id) throw new SeedError('seed registry token does not match the supplied secret');
        const values = digest('seed-values:v1').toString('hex');
        const user = `archive_${values.slice(0, 10)}`, password = `AGFAKE${values.slice(10, 34)}`;
        const endpoint = callbackBase ?? `https://archive.${fake.site}`;
        const database = `postgresql://${user}:${password}@db.${fake.site}:5432/${fake.database}`;
        let body: string;
        switch (path) {
            case '.env.backup':
                body = `# Synthetic backup configuration\nDATABASE_URL=${database}\nSERVICE_ENDPOINT=${endpoint}\nACCESS_TOKEN=${entry.token}\n`;
                break;
            case 'db-connection.txt':
                body = `# Synthetic database connection\n${database}\nendpoint=${endpoint}\ncanary=${entry.token}\n`;
                break;
            case '.npmrc':
                body = `registry=${endpoint}\n_authToken=${entry.token}\nalways-auth=false\n`;
                break;
            case '.aws/credentials':
                body = `[default]\naws_access_key_id = AGFAKE${values.slice(0, 20)}\naws_secret_access_key = ${password}\nregion = ${fake.region}\n# endpoint: ${endpoint}\n# canary: ${entry.token}\n`;
                break;
            case '.pypirc':
                body = `[distutils]\nindex-servers = archive\n\n[archive]\nrepository = ${endpoint}\nusername = ${user}\npassword = ${entry.token}\n`;
                break;
            case '.kube/config':
                body = `apiVersion: v1\nkind: Config\nclusters:\n  - name: archive\n    cluster:\n      server: ${endpoint}\ncontexts:\n  - name: archive\n    context:\n      cluster: archive\n      user: ${user}\ncurrent-context: archive\nusers:\n  - name: ${user}\n    user:\n      token: ${entry.token}\n`;
                break;
            case '.ssh/id_rsa':
                body = `-----BEGIN INVALID SSH KEY PLACEHOLDER-----\ninvalid synthetic fixture; not a real key\npayload=${password}\n# endpoint: ${endpoint}\n# canary: ${entry.token}\n-----END INVALID SSH KEY PLACEHOLDER-----\n`;
                break;
        }
        // The shared linter remains the authority for inert content. Never echo
        // violations: callback URLs and registry input may contain sensitive text.
        if (lintSample({ name: path, body, capBytes: DECOY_CAP_BYTES, allowedHosts }).length ||
            body.split(DEFAULT_PREFIX).length !== 2)
            throw new SeedError('seed content failed the inert safety checks');
        return { path, mode: '0600', body, entry };
    });
}

export function seedManifest(input: SeedInputs, files: SeedFile[]): SeedManifest {
    return {
        version: 1, profile: input.profile, env: input.env,
        ...(input.callbackBase ? { callbackHost: new URL(input.callbackBase).hostname } : {}),
        files: files.map(file => ({ path: file.path, mode: file.mode, canaryId: file.entry.id, sha256: contentHash(file.body) })),
    };
}
