import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildSchema, execute, getOperationAST, GraphQLError, parse, separateOperations, validate, type ValidationRule } from 'graphql';
import { createAgentGuard, graphqlDecoys, inspectGraphqlRequest, type AgentGuardConfig } from '../../src/index.js';
import { graphqlForbiddenResponse } from '../../src/scenarios/graphql.js';
import { agentGuardNode, toRequest, type ParsedRequest } from '../../src/adapters/node.js';
import { demoConfig, parseBody, site, type Demo } from '../shared/site.js';
import { listenLocal } from '../shared/loopback.js';

const metadata = graphqlDecoys();
const schema = buildSchema(`
    type Query {
        hello: String!
        ${metadata.map(decoy => `${JSON.stringify(decoy.field.description)} ${decoy.field.name}: ${decoy.field.type}`).join('\n')}
    }
    ${metadata.map(decoy => `${JSON.stringify(decoy.type.description)} type ${decoy.type.name} {
        ${decoy.type.fields.map(field => `${JSON.stringify(field.description)} ${field.name}: ${field.type}`).join('\n')}
    }`).join('\n')}
`);
const forbidden = (): GraphQLError => new GraphQLError('Permission denied', { extensions: { code: 'FORBIDDEN' } });
const rootValue = {
    hello: () => 'Hello from the local demo.',
    // Defense in depth: an allowlist or fail-open inspector cannot expose records.
    ...Object.fromEntries(metadata.map(decoy => [decoy.field.name, () => { throw forbidden(); }])),
};
// A host validation rule also prevents mixed real/decoy documents from executing
// any resolvers when inspection is skipped (e.g. allowlisted clients).
const noDecoyFields: ValidationRule = context => ({
    Field(node) {
        if (metadata.some(decoy => decoy.field.name === node.name.value)) context.reportError(forbidden());
    },
});
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** Local schema example. graphql is a development dependency, never a core import. */
export async function startGraphqlDemo(config: AgentGuardConfig = demoConfig(), port = 0): Promise<Demo> {
    const guard = createAgentGuard(config), middleware = agentGuardNode(guard);
    const server = createServer((req: ParsedRequest, res) => {
        void (async () => {
            const path = new URL(req.url ?? '/', 'http://local.invalid').pathname;
            req.body = await parseBody(req);
            if (path !== '/graphql' || req.method !== 'POST') {
                middleware(req, res, () => site(req, res)); return;
            }
            const decision = await inspectGraphqlRequest(guard, toRequest(req, config));
            if (decision.events.some(event => event.event === 'crawler_bypass')) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not Found\n'); return;
            }
            if (decision.action === 'respond') {
                res.writeHead(decision.response.status, decision.response.headers);
                res.end(decision.response.body); return;
            }
            const message = req.body;
            if (!object(message) || typeof message.query !== 'string' || message.query.length > 16384 ||
                (message.operationName != null && typeof message.operationName !== 'string') ||
                (message.variables != null && !object(message.variables))) throw new Error('Invalid request');
            const document = parse(message.query, { maxTokens: 4096 });
            const errors = validate(schema, document);
            const operation = getOperationAST(document, message.operationName as string | undefined);
            const selectedDocument = operation ? separateOperations(document)[operation.name?.value ?? ''] : undefined;
            const decoyErrors = selectedDocument ? validate(schema, selectedDocument, [noDecoyFields]) : [];
            if (decoyErrors.length) {
                const response = graphqlForbiddenResponse();
                res.writeHead(response.status, response.headers); res.end(response.body); return;
            }
            const result = errors.length ? { errors } : await execute({
                schema, document, rootValue,
                variableValues: message.variables as Record<string, unknown> | undefined,
                operationName: message.operationName as string | undefined,
            });
            res.writeHead(errors.length ? 400 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result));
        })().catch(() => {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ errors: [{ message: 'Invalid GraphQL request' }] }));
        });
    });
    const local = await listenLocal(server, port);
    return { server, guard, url: local.url, async close() { await guard.close(); await local.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const demo = await startGraphqlDemo(demoConfig(), Number(process.env.PORT ?? 3000));
    console.log(`GraphQL decoy demo: ${demo.url}/graphql`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void demo.close(); });
}
