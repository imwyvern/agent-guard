import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { createHoneyfile, readRegularFile, absolutePath, checkTarget, statPath } from '../seed/paths.js';
import { validateConfig } from '../config.js';
import { webhookAdapter } from '../alerts/webhook.js';
import type { AgentGuardConfig } from '../types.js';

/** JSON references environment names; credentials never belong in generated files. */
export function entryConfig(): Record<string, unknown> {
    return { project: 'local-project', env: 'local', mode: 'detect', projectSeed: '${AG_PROJECT_SEED}',
        canary: { secret: '${AG_CANARY_SECRET}', registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
        crawler: { verify: 'ua-bypass' } };
}

export function loadEntryConfig(path?: string, initSecrets = false): AgentGuardConfig {
    const configPath = absolutePath(path ?? 'agent-guard.config.json');
    checkTarget(configPath);
    const present = !!statPath(configPath);
    if (path && !present && !initSecrets) throw new Error('configuration file is missing');
    if (initSecrets && !present) {
        const envPath = resolve(dirname(configPath), '.env');
        checkTarget(envPath);
        createHoneyfile(envPath, ['AG_CANARY_SECRET', 'AG_WEBHOOK_SECRET', 'AG_PROJECT_SEED']
            .map(name => `${name}=${randomBytes(32).toString('hex')}`).join('\n') + '\n');
        // Read only these generated bindings, never execute a dotenv file.
        for (const line of readRegularFile(envPath).toString('utf8').split('\n')) {
            const match = /^(AG_CANARY_SECRET|AG_WEBHOOK_SECRET|AG_PROJECT_SEED)=([a-f0-9]{64})$/.exec(line);
            if (match && !process.env[match[1]!]) process.env[match[1]!] = match[2]!;
        }
    }
    const raw: unknown = present ? JSON.parse(readRegularFile(configPath).toString('utf8')) : entryConfig();
    const expand = (value: unknown): unknown => {
        if (typeof value === 'string') {
            const match = /^\$\{(AG_[A-Z_]+)\}$/.exec(value);
            if (match) {
                const binding = process.env[match[1]!];
                if (!binding) throw new Error('missing environment binding');
                return binding;
            }
        }
        if (Array.isArray(value)) return value.map(expand);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
        return value;
    };
    const config = expand(raw) as AgentGuardConfig;
    validateConfig(config);
    if (config.mode !== 'detect') throw new Error('entry points require detect mode');
    // These entry points never add DNS traffic. UA claims remain unverified.
    config.crawler = { verify: 'ua-bypass' };
    const url = process.env.AG_ALERT_WEBHOOK_URL;
    const secret = process.env.AG_ALERT_WEBHOOK_SECRET ?? process.env.AG_WEBHOOK_SECRET;
    if (url && secret) config.alerts = { ...config.alerts, adapters: [webhookAdapter({ url, secret })] };
    return config;
}
