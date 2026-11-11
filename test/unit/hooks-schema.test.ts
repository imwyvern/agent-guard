import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { event } from '../helpers.js';

const { $schema: _draft, ...schema } = JSON.parse(readFileSync(new URL('../../schema/event.v1.json', import.meta.url), 'utf8'));
const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
beforeAll(async () => {
    app.post('/', { schema: { body: schema } }, async () => ({ ok: true }));
    await app.ready();
});
afterAll(() => app.close());

it.each([
    { on: 'incident_high', status: 'success' },
    { on: 'canary_replay', status: 'timeout' },
    { on: 'honeyfile_read', status: 'failure', reason: 'spawn_error' },
    { on: 'canary_replay', status: 'failure', reason: 'exit_nonzero' },
    { on: 'canary_replay', status: 'failure', reason: 'signal' },
    { on: 'incident_high', status: 'refused', reason: 'rate_limit' },
    { on: 'canary_replay', status: 'refused', reason: 'concurrency_limit' },
    { on: 'honeyfile_read', status: 'refused', reason: 'global_concurrency_limit' },
    { on: 'canary_replay', status: 'cancelled', reason: 'closed' },
])('accepts bounded hook_result metadata %j', async hook => {
    expect((await app.inject({ method: 'POST', url: '/', payload: { ...event({ event: 'hook_result' }), hook } })).statusCode).toBe(200);
});

it.each([
    { on: 'probe', status: 'success' }, { on: 'canary_replay', status: 'unknown' }, { on: 'canary_replay' }, { status: 'success' },
    { on: 'canary_replay', status: 'failure', reason: 'private error text' },
    ...['argv', 'command', 'output', 'ua', 'path', 'unknown'].map(key => ({ on: 'canary_replay', status: 'success', [key]: 'private' })),
    null, [], 'success',
])('rejects invalid or unknown hook fields: %j', async hook => {
    expect((await app.inject({ method: 'POST', url: '/', payload: { ...event({ event: 'hook_result' }), hook } })).statusCode).toBe(400);
});

it('retains the root required fields and forbids unknown root fields for hook_result', async () => {
    const base = event({ event: 'hook_result', hook: { on: 'canary_replay', status: 'success' } });
    expect((await app.inject({ method: 'POST', url: '/', payload: { ...base, output: 'private' } })).statusCode).toBe(400);
    for (const field of schema.required as string[]) {
        const payload = { ...base } as Record<string, unknown>; delete payload[field];
        expect((await app.inject({ method: 'POST', url: '/', payload })).statusCode).toBe(400);
    }
});
