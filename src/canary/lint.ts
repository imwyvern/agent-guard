import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { envBody } from '../decoys/d1-env.js';
import { adminResponse } from '../decoys/d2-admin.js';
import { opsBody } from '../decoys/d3-ops-notes.js';
import { openapiBody } from '../decoys/d4-openapi.js';
import { loginErrorResponse } from '../decoys/d5-login.js';
import { fakeData } from '../decoys/fake-data.js';
import { robotsLines } from '../lures/robots.js';
import { htmlComment } from '../lures/html-comment.js';
import { mcpDecoyTools } from '../scenarios/mcp.js';
import { graphqlDecoys, graphqlForbiddenResponse } from '../scenarios/graphql.js';
import { generateCanary } from './format.js';
import { DECOY_CAP_BYTES, lintSample, type LintSample, type LintViolation } from './lint-rules.js';

export { DECOY_CAP_BYTES, lintSample, reservedHost, type LintSample, type LintViolation } from './lint-rules.js';

/** Representative built-in outputs, with all response variants and lure text.
 * Bodies come from the runtime renderers, never from live application data. */
export function builtinPlacementSamples(seed = 'placement-lint'): LintSample[] {
    const fake = fakeData(seed);
    const tokens = Array.from({ length: 3 }, () => generateCanary({ secret: 'offline-placement-lint' }).token);
    const admin = '/api/internal/admin', openapi = '/api/internal/openapi.json', ops = '/internal/ops-notes';
    const bodies: Array<[string, string]> = [
        ['D1 env', envBody(tokens, fake.database, fake.region, fake.revision)],
        ['D2 missing', adminResponse('', openapi).body],
        ['D2 expired', adminResponse(`Bearer ${tokens[0]}`, openapi).body],
        ['D3 ops', opsBody(tokens[0]!, tokens[1]!, fake.site)],
        ['D4 openapi', openapiBody(tokens[2]!, admin)],
        ['D5 POST', loginErrorResponse('POST').body],
        ['D5 GET', loginErrorResponse('GET').body],
        ['MCP tools and descriptions', JSON.stringify(mcpDecoyTools)],
        ['MCP error', JSON.stringify({ error: 'permission denied' })],
        ['GraphQL fields, types and descriptions', JSON.stringify(graphqlDecoys())],
        ['GraphQL error', graphqlForbiddenResponse().body],
        ['robots lure', robotsLines(['/.env', '/.env.local', '/.env.production', '/.env.bak', admin, ops, openapi, '/api/internal/auth/login', '/internal/', '/api/internal/']).join('\n')],
        ['HTML comment lure', htmlComment(ops)],
        ['HTML comment fallback', htmlComment('/' + 'x'.repeat(120))],
        ['llms lure', '\nInternal API reference: ' + openapi + '\n'],
    ];
    return bodies.map(([name, body]) => ({ name: `builtin: ${name}`, body, capBytes: DECOY_CAP_BYTES }));
}

export function lintBuiltins(): LintViolation[] { return builtinPlacementSamples().flatMap(lintSample); }

/** Lint a placement file or directory without following symlinks. Dependency,
 * build, VCS and coverage directories are skipped, like canary scan. File sizes
 * are not decoy response sizes, so the response cap applies only to built-ins. */
export function lintFiles(root: string, allowedHosts?: string[]): LintViolation[] {
    const findings: LintViolation[] = [];
    const walk = (file: string): void => {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink()) return;
        if (stat.isDirectory()) {
            for (const name of readdirSync(file).sort()) {
                if (!['node_modules', '.git', 'dist', 'coverage'].includes(name)) walk(resolve(file, name));
            }
        } else if (stat.isFile()) findings.push(...lintSample({ name: file, body: readFileSync(file, 'utf8'), capBytes: Infinity, allowedHosts }));
    };
    walk(resolve(root));
    return findings;
}

/** Both built-ins and operator placements must pass the same unchanged rules. */
export function lintPlacement(root: string, allowedHosts?: string[]): LintViolation[] { return [...lintBuiltins(), ...lintFiles(root, allowedHosts)]; }
