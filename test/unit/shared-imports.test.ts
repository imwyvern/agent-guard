import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const shared = [
    'crypto/types.ts', 'crypto/bytes.ts', 'core/ulid-core.ts', 'core/security-core.ts', 'core/ip-parse.ts',
    'core/client-key-core.ts', 'core/maze-nodes.ts', 'core/incidents-core.ts', 'core/limits.ts', 'core/signals.ts', 'crawler/ua.ts',
    'canary/format-core.ts', 'canary/registry-core.ts', 'canary/callback-core.ts', 'canary/tracing.ts',
    'crypto/web.ts', 'state/store.ts',
    'adapters/workers.ts', 'adapters/next.ts', 'adapters/deno.ts', 'adapters/bun.ts', 'adapters/hono-web.ts',
    ...readdirSync(fileURLToPath(new URL('../../src/web/', import.meta.url)), { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.ts')).map(f => 'web/' + f),
    'decoys/responses.ts', 'decoys/fake-data-core.ts', 'alerts/signing.ts', 'alerts/format.ts', 'alerts/shared.ts', 'lures/html-comment.ts',
];

it('keeps shared modules and their complete import graph free of Node globals and imports', () => {
    const seen = new Set<string>(), root = fileURLToPath(new URL('../../src/', import.meta.url));
    const visit = (file: string): void => {
        if (seen.has(file)) return;
        seen.add(file);
        const source = readFileSync(file, 'utf8');
        expect(/node:|\bBuffer\b|\bprocess\s*\./.exec(source)?.[0], file).toBeUndefined();
        const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        const dependency = (specifier: ts.Expression): void => {
            expect(ts.isStringLiteral(specifier), file + ': literal import required').toBe(true);
            if (!ts.isStringLiteral(specifier)) return;
            expect(specifier.text, file).toMatch(/^\.{1,2}\//);
            visit(resolve(dirname(file), specifier.text.replace(/\.js$/, '.ts')));
        };
        const walk = (node: ts.Node): void => {
            if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) dependency(node.moduleSpecifier);
            if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) dependency(node.moduleSpecifier);
            if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
                expect(node.arguments.length, file).toBe(1);
                dependency(node.arguments[0]!);
            }
            if (ts.isIdentifier(node)) expect(['process', 'Buffer', 'nodeCrypto'].includes(node.text), file + ': ' + node.text).toBe(false);
            ts.forEachChild(node, walk);
        };
        walk(ast);
    };
    for (const file of shared) visit(resolve(root, file));
    expect(seen.size).toBeGreaterThanOrEqual(shared.length);
});
