import { envBody } from '../src/decoys/d1-env.js';
import { adminResponse } from '../src/decoys/d2-admin.js';
import { opsBody } from '../src/decoys/d3-ops-notes.js';
import { openapiBody } from '../src/decoys/d4-openapi.js';
import { fakeData } from '../src/decoys/fake-data.js';
import { generateCanary } from '../src/canary/format.js';
import { mcpDecoyTools } from '../src/scenarios/mcp.js';
import { DECOY_CAP_BYTES, lintSample, type LintSample } from '../src/canary/lint-rules.js';
export { reservedHost, lintSample, DECOY_CAP_BYTES, type LintSample, type LintViolation } from '../src/canary/lint-rules.js';
import { isMain } from './common.js';
import { personaSample, PERSONA_CAP_BYTES } from './lib/persona.js';

export function existingDecoySamples(seed = 'v0.3b-offline'): LintSample[] {
    const fake = fakeData(seed);
    const tokens = Array.from({ length: 3 }, () => generateCanary({ secret: 'offline-lint-only' }).token);
    const bodies: Array<[string, string]> = [
        ['D1 env', envBody(tokens, fake.database, fake.region, fake.revision)],
        ['D2 missing', String(adminResponse('', '/api/internal/openapi.json').body)],
        ['D2 expired', String(adminResponse(`Bearer ${tokens[0]}`, '/api/internal/openapi.json').body)],
        ['D3 ops', opsBody(tokens[0]!, tokens[1]!, fake.site)],
        ['D4 openapi', openapiBody(tokens[2]!, '/api/internal/admin')],
        ['MCP tools and descriptions', JSON.stringify(mcpDecoyTools)],
    ];
    return bodies.map(([name, body]) => ({ name: `${seed}: ${name}`, body, capBytes: DECOY_CAP_BYTES }));
}

export function deceptionLint() {
    const samples = Array.from({ length: 20 }, (_, i) => {
        const seed = `v0.3b-persona-${i}`;
        return [...existingDecoySamples(seed), { name: seed, body: personaSample(seed), capBytes: PERSONA_CAP_BYTES }];
    }).flat();
    const violations = samples.flatMap(lintSample);
    return { status: violations.length ? 'failed' : 'passed', samples: samples.length, violations };
}
if (isMain(import.meta.url)) {
    const result = deceptionLint();
    console.log(JSON.stringify(result, null, 2));
    if (result.violations.length) process.exitCode = 1;
}
