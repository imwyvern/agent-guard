import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/** Parse the actual source so internal, non-exported and newly added regexes are tested too. */
export function regexInventory(root = join(process.cwd(), 'src')): Array<{ file: string; literal: string; regex: RegExp }> {
    const entries: Array<{ file: string; literal: string; regex: RegExp }> = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) { walk(path); continue; }
            if (!entry.name.endsWith('.ts')) continue;
            const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
            const visit = (node: ts.Node): void => {
                if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
                    const literal = node.getText(source);
                    entries.push({ file: relative(process.cwd(), path), literal, regex: Function(`"use strict"; return (${literal});`)() as RegExp });
                }
                if (ts.isNewExpression(node) && node.expression.getText(source) === 'RegExp')
                    throw Error(`Dynamic regex in ${path} needs an explicit audit fixture`);
                ts.forEachChild(node, visit);
            };
            visit(source);
        }
    };
    walk(root);
    return entries;
}
