import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { it, expect } from 'vitest';
import { createAgentGuard } from '../../src/index.js';
import { config, event, request } from '../helpers.js';

const schema = JSON.parse(readFileSync(new URL('../../schema/event.v1.json', import.meta.url), 'utf8'));

it('keeps v1 required fields and event types unchanged and declares the optional metadata', () => {
    expect(schema.required).toEqual(['v', 'ts', 'event_id', 'event', 'severity', 'project', 'env', 'req']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.event.enum).toEqual(['decoy_hit', 'canary_replay', 'probe', 'ai_discovery', 'crawler_bypass', 'alert_sent', 'alert_failed']);
    expect(schema.properties.canary.properties).toMatchObject({ leaked_at: { type: 'string' }, replayed_at: { type: 'string' }, dwell_ms: { type: 'integer', minimum: 0 }, client_keys_seen: { type: 'integer', minimum: 1, maximum: 8 } });
});

it('validates legacy and emitted incident/replay events and rejects invalid optional metadata', async () => {
    // Reuse the installed Fastify dev dependency's validator; no new dependency.
    // These schema keywords are shared by draft 7 and 2020-12.
    const { $schema: _draft, ...body } = schema;
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
    app.post('/', { schema: { body } }, async () => ({ ok: true }));
    const guard = createAgentGuard(config());
    try {
        await guard.inspect(request('/robots.txt'));
        const env = await guard.inspect(request('/.env'));
        if (env.action !== 'respond') throw new Error('expected decoy');
        const token = /^ADMIN_API_TOKEN=(.+)$/m.exec(env.response.body)![1]!;
        const replay = (await guard.inspect(request('/normal', { headers: { authorization: token } }))).events[0]!;
        for (const payload of [event(), env.events[0]!, replay])
            expect((await app.inject({ method: 'POST', url: '/', payload })).statusCode).toBe(200);
        const invalid = [
            { ...replay, incident: { ...replay.incident, confidence: 'critical' } },
            { ...replay, incident: { ...replay.incident, sequence: Array<string>(33).fill('D1') } },
            { ...replay, incident: { ...replay.incident, first_seen: 'not-a-date' } },
            { ...replay, incident: { ...replay.incident, sequence: ['unknown'] } },
            { ...replay, incident: { sequence: [] } },
            { ...replay, canary: { ...replay.canary, dwell_ms: -1 } },
            { ...replay, canary: { ...replay.canary, client_keys_seen: 9 } },
            { ...replay, canary: { ...replay.canary, leaked_at: 1 } },
            { ...replay, unexpected: true },
        ];
        for (const payload of invalid)
            expect((await app.inject({ method: 'POST', url: '/', payload })).statusCode).toBe(400);
    } finally { await app.close(); await guard.close(); }
});
