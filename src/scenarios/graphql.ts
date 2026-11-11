import type { AGDecision, AGRequest, AGResponse, AgentGuard } from '../types.js';
import { decoyHeaders } from '../decoys/headers.js';

/** Schema metadata only. Hosts must give every decoy field an inert error resolver
 * as well as inspecting requests before executing any application resolvers. */
const decoys = Object.freeze([
    Object.freeze({
        field: Object.freeze({
            name: 'internalAdminUsers',
            type: '[InternalAdminUser!]',
            description: 'Internal administration account directory metadata.',
        }),
        type: Object.freeze({
            name: 'InternalAdminUser',
            description: 'Internal administration account metadata.',
            fields: Object.freeze([
                Object.freeze({ name: 'id', type: 'ID!', description: 'Synthetic account identifier.' }),
            ]),
        }),
    }),
]);

export function graphqlDecoys(): typeof decoys { return decoys; }

export function graphqlForbiddenResponse(): AGResponse {
    return { status: 200, headers: decoyHeaders('application/json'), body: JSON.stringify({ errors: [{ message: 'Permission denied', extensions: { code: 'FORBIDDEN' } }] }) };
}

// These caps apply before allocation/tokenization and before recursive parsing.
// Unsupported, excessive or malformed documents belong to the host validator.
const MAX_QUERY_LENGTH = 16384, MAX_TOKENS = 4096, MAX_DEPTH = 64;
const namePattern = /^[A-Za-z_][A-Za-z_0-9]*$/;
type Selection = { field: string; children: Selection[] } | { spread: string };
interface Operation { name?: string; selections: Selection[] }

function tokenize(source: string): string[] {
    const tokens: string[] = [];
    const name = /[A-Za-z_][A-Za-z_0-9]*/y;
    const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    for (let i = 0; i < source.length;) {
        const char = source[i]!;
        if (/[\t\n\r ,\uFEFF]/u.test(char)) { i++; continue; }
        if (char === '#') {
            while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
            continue;
        }
        if (tokens.length >= MAX_TOKENS) throw new Error('token limit');
        if (char === '"') {
            const start = i;
            if (source.startsWith('"""', i)) {
                i += 3;
                while (i < source.length && !source.startsWith('"""', i)) {
                    if (source.startsWith('\\"""', i)) { i += 4; continue; }
                    const code = source.codePointAt(i)!;
                    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 0xD800 && code <= 0xDFFF)) throw new Error('invalid string');
                    i += code > 0xFFFF ? 2 : 1;
                }
                if (i >= source.length) throw new Error('unterminated block string');
                i += 3;
            } else {
                i++;
                while (i < source.length && source[i] !== '"') {
                    if (source[i] === '\\') i++;
                    i++;
                }
                if (i >= source.length) throw new Error('unterminated string');
                i++;
                const value: unknown = JSON.parse(source.slice(start, i));
                // JSON permits lone surrogates; GraphQL string values do not.
                for (const point of value as string) {
                    const code = point.codePointAt(0)!;
                    if (code >= 0xD800 && code <= 0xDFFF) throw new Error('invalid Unicode');
                }
            }
            tokens.push('\0string');
        } else if (/[A-Za-z_]/.test(char)) {
            name.lastIndex = i;
            const match = name.exec(source)!;
            tokens.push(match[0]); i = name.lastIndex;
        } else if (char === '-' || /[0-9]/.test(char)) {
            number.lastIndex = i;
            const match = number.exec(source);
            if (!match) throw new Error('invalid number');
            i = number.lastIndex;
            if (/[.A-Za-z_0-9]/.test(source[i] ?? '')) throw new Error('invalid number suffix');
            tokens.push('\0number');
        } else if (source.startsWith('...', i)) {
            tokens.push('...'); i += 3;
        } else if ('!$():=@[]{|}'.includes(char)) {
            tokens.push(char); i++;
        } else throw new Error('invalid character');
    }
    return tokens;
}

/** A small executable-document parser, not a schema validator. Strings, values,
 * aliases, directives and unused fragments cannot masquerade as field selections. */
class DocumentParser {
    private position = 0;
    readonly operations: Operation[] = [];
    readonly fragments = new Map<string, Selection[]>();
    constructor(private readonly tokens: string[]) {}
    private peek(): string | undefined { return this.tokens[this.position]; }
    private take(token: string): boolean {
        if (this.peek() !== token) return false;
        this.position++; return true;
    }
    private expect(token: string): void {
        if (!this.take(token)) throw new Error('unexpected token');
    }
    private name(): string {
        const token = this.peek();
        if (!token || !namePattern.test(token)) throw new Error('expected name');
        this.position++; return token;
    }
    private depth(depth: number): void {
        if (depth > MAX_DEPTH) throw new Error('depth limit');
    }
    private value(depth: number, constant = false): void {
        this.depth(depth);
        if (this.take('$')) {
            if (constant) throw new Error('variable in constant');
            this.name();
        } else if (this.take('[')) {
            while (!this.take(']')) this.value(depth + 1, constant);
        } else if (this.take('{')) {
            while (!this.take('}')) { this.name(); this.expect(':'); this.value(depth + 1, constant); }
        } else if (!this.take('\0string') && !this.take('\0number')) this.name();
    }
    private arguments(constant = false): void {
        if (!this.take('(')) return;
        do { this.name(); this.expect(':'); this.value(0, constant); } while (!this.take(')'));
    }
    private directives(constant = false): void {
        while (this.take('@')) { this.name(); this.arguments(constant); }
    }
    private type(depth = 0): void {
        this.depth(depth);
        if (this.take('[')) { this.type(depth + 1); this.expect(']'); }
        else this.name();
        this.take('!');
    }
    private selections(depth = 0): Selection[] {
        this.depth(depth);
        this.expect('{');
        const selections: Selection[] = [];
        do {
            if (this.take('...')) {
                if (this.take('on')) {
                    this.name(); this.directives();
                    selections.push(...this.selections(depth + 1));
                } else if (this.peek() === '@' || this.peek() === '{') {
                    this.directives(); selections.push(...this.selections(depth + 1));
                } else {
                    selections.push({ spread: this.name() }); this.directives();
                }
            } else {
                let field = this.name();
                if (this.take(':')) field = this.name();
                this.arguments(); this.directives();
                selections.push({ field, children: this.peek() === '{' ? this.selections(depth + 1) : [] });
            }
        } while (!this.take('}'));
        return selections;
    }
    parse(): void {
        while (this.position < this.tokens.length) {
            if (this.peek() === '{') {
                this.operations.push({ selections: this.selections() }); continue;
            }
            const kind = this.name();
            if (kind === 'fragment') {
                const name = this.name();
                if (name === 'on' || this.fragments.has(name)) throw new Error('invalid fragment');
                this.expect('on'); this.name(); this.directives();
                this.fragments.set(name, this.selections());
            } else {
                if (!['query', 'mutation', 'subscription'].includes(kind)) throw new Error('expected operation');
                const name = this.peek() && namePattern.test(this.peek()!) ? this.name() : undefined;
                if (this.operations.some(op => name !== undefined && op.name === name)) throw new Error('duplicate operation');
                if (this.take('(')) {
                    do {
                        this.expect('$'); this.name(); this.expect(':'); this.type();
                        if (this.take('=')) this.value(0, true);
                        this.directives(true);
                    } while (!this.take(')'));
                }
                this.directives();
                this.operations.push({ name, selections: this.selections() });
            }
        }
        if (!this.operations.length || (this.operations.length > 1 && this.operations.some(op => !op.name))) throw new Error('invalid operations');
    }
}

function decoySelected(query: unknown, operationName: unknown): boolean {
    if (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH ||
        (operationName !== undefined && operationName !== null && typeof operationName !== 'string')) return false;
    try {
        const document = new DocumentParser(tokenize(query));
        document.parse();
        const operation = typeof operationName === 'string'
            ? document.operations.find(op => op.name === operationName)
            : document.operations.length === 1 ? document.operations[0] : undefined;
        if (!operation) return false;
        // Memoize fragments to avoid exponential expansion; cycles/missing spreads
        // fail open even if another selection in the document mentions a decoy.
        const results = new Map<string, boolean>(), active = new Set<string>();
        const visit = (selections: Selection[], depth: number): boolean => {
            if (depth > MAX_DEPTH) throw new Error('fragment depth limit');
            let hit = false;
            for (const selection of selections) {
                if ('spread' in selection) {
                    const name = selection.spread, fragment = document.fragments.get(name);
                    if (!fragment || active.has(name)) throw new Error('invalid spread');
                    if (!results.has(name)) {
                        active.add(name); results.set(name, visit(fragment, depth + 1)); active.delete(name);
                    }
                    hit = results.get(name)! || hit;
                } else if (!['__schema', '__type', '__typename'].includes(selection.field)) {
                    hit = visit(selection.children, depth + 1) || decoys.some(decoy => decoy.field.name === selection.field) || hit;
                }
            }
            return hit;
        };
        return visit(operation.selections, 0);
    } catch { return false; }
}

/** Inspect once after host body parsing, before GraphQL execution. The host maps
 * crawler_bypass to its native 404. Real queries and introspection pass through;
 * a decoy response must end routing before any application resolver executes. */
export function inspectGraphqlRequest(guard: AgentGuard, request: AGRequest): Promise<AGDecision> {
    let fieldName: string | undefined;
    try {
        const body = request.body;
        const input = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : request.query;
        if (decoySelected(input.query, input.operationName)) fieldName = decoys[0]!.field.name;
    } catch { /* Exotic host objects also fail open. */ }
    return guard.inspect(request, { graphql: { fieldName } });
}
