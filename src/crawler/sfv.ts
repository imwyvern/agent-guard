import { base64 } from '../crypto/bytes.js';

/** RFC 8941 values. Maps preserve parameter order for RFC 9421 signature bases. */
export type SfBareItem =
    | { type: 'string' | 'token'; value: string }
    | { type: 'integer' | 'decimal'; value: number }
    | { type: 'boolean'; value: boolean }
    | { type: 'bytes'; value: Uint8Array };
export type SfParameters = Map<string, SfBareItem>;
export interface SfItem { type: 'item'; bare: SfBareItem; parameters: SfParameters }
export interface SfInnerList { type: 'inner-list'; items: SfItem[]; parameters: SfParameters }
export type SfMember = SfItem | SfInnerList;
export type SfDictionary = Map<string, SfMember>;

const maxLength = 65536, maxMembers = 128;
const keyStart = /[a-z*]/, keyRest = /[a-z0-9_.*-]/;
const tokenStart = /[A-Za-z*]/, tokenRest = /[A-Za-z0-9!#$%&'*+.^_`|~:/-]/;
const yes: SfBareItem = { type: 'boolean', value: true };

export function decodeBase64(value: string): Uint8Array {
    // RFC 8941 permits omitted padding, but never interior padding or other alphabets.
    let end = value.length;
    while (value[end - 1] === '=') end--;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || end % 4 === 1
        || value.includes('=') && value.length % 4 !== 0) throw new SyntaxError('Invalid byte sequence');
    return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

class Parser {
    private offset = 0;
    constructor(private source: string) {
        if (source.length > maxLength) throw new SyntaxError('Structured field too long');
    }
    private peek(): string { return this.source[this.offset] ?? ''; }
    private take(value: string): boolean {
        if (this.peek() !== value) return false;
        this.offset++; return true;
    }
    private spaces(ows = false): void {
        while (this.peek() === ' ' || ows && this.peek() === '\t') this.offset++;
    }
    private fail(): never { throw new SyntaxError('Invalid structured field'); }
    private key(): string {
        const start = this.offset;
        if (!keyStart.test(this.peek()) || !this.peek()) return this.fail();
        this.offset++;
        while (this.peek() && keyRest.test(this.peek())) this.offset++;
        return this.source.slice(start, this.offset);
    }
    private bare(): SfBareItem {
        if (this.take('"')) {
            let value = '';
            while (this.peek()) {
                let char = this.source[this.offset++]!;
                if (char === '"') return { type: 'string', value };
                if (char === '\\') {
                    char = this.source[this.offset++] ?? '';
                    if (char !== '"' && char !== '\\') return this.fail();
                }
                if (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) > 0x7e) return this.fail();
                value += char;
            }
            return this.fail();
        }
        if (this.take(':')) {
            const end = this.source.indexOf(':', this.offset);
            if (end < 0) return this.fail();
            const value = decodeBase64(this.source.slice(this.offset, end));
            this.offset = end + 1; return { type: 'bytes', value };
        }
        if (this.take('?')) {
            if (this.take('1')) return yes;
            if (this.take('0')) return { type: 'boolean', value: false };
            return this.fail();
        }
        if (this.peek() === '-' || /[0-9]/.test(this.peek()) && this.peek()) {
            const start = this.offset;
            this.take('-');
            const digits = this.offset;
            while (this.peek() && /[0-9]/.test(this.peek())) this.offset++;
            const length = this.offset - digits;
            if (!length) return this.fail();
            if (this.take('.')) {
                const fraction = this.offset;
                while (this.peek() && /[0-9]/.test(this.peek())) this.offset++;
                if (length > 12 || this.offset - fraction < 1 || this.offset - fraction > 3) return this.fail();
                return { type: 'decimal', value: Number(this.source.slice(start, this.offset)) };
            }
            if (length > 15) return this.fail();
            return { type: 'integer', value: Number(this.source.slice(start, this.offset)) };
        }
        if (this.peek() && tokenStart.test(this.peek())) {
            const start = this.offset++;
            while (this.peek() && tokenRest.test(this.peek())) this.offset++;
            return { type: 'token', value: this.source.slice(start, this.offset) };
        }
        return this.fail();
    }
    private parameters(): SfParameters {
        const parameters: SfParameters = new Map();
        let count = 0;
        while (this.take(';')) {
            this.spaces();
            const key = this.key();
            // Reject duplicates instead of silently overwriting security-critical parameters.
            if (++count > maxMembers || parameters.has(key)) return this.fail();
            parameters.set(key, this.take('=') ? this.bare() : yes);
        }
        return parameters;
    }
    private item(): SfItem { return { type: 'item', bare: this.bare(), parameters: this.parameters() }; }
    private member(): SfMember {
        if (!this.take('(')) return this.item();
        const items: SfItem[] = [];
        this.spaces();
        while (!this.take(')')) {
            if (items.length >= maxMembers) return this.fail();
            items.push(this.item());
            if (this.peek() !== ')' && this.peek() !== ' ') return this.fail();
            this.spaces();
        }
        return { type: 'inner-list', items, parameters: this.parameters() };
    }
    private finish(): void { this.spaces(); if (this.offset !== this.source.length) this.fail(); }
    parseItem(): SfItem { this.spaces(); const result = this.item(); this.finish(); return result; }
    parseDictionary(): SfDictionary {
        const result: SfDictionary = new Map();
        this.spaces();
        if (!this.peek()) return result;
        for (;;) {
            const key = this.key();
            if (result.size >= maxMembers || result.has(key)) return this.fail();
            result.set(key, this.take('=') ? this.member() : { type: 'item', bare: yes, parameters: this.parameters() });
            this.spaces(true);
            if (!this.take(',')) break;
            this.spaces(true);
            if (!this.peek()) return this.fail();
        }
        this.finish(); return result;
    }
}

/** Bounded RFC 8941 parser; duplicate dictionary keys/parameters are rejected. */
export function parseDictionary(source: string): SfDictionary { return new Parser(source).parseDictionary(); }
export function parseItem(source: string): SfItem { return new Parser(source).parseItem(); }

export function serializeBareItem(item: SfBareItem): string {
    switch (item.type) {
        case 'string':
            if (/[^\x20-\x7e]/.test(item.value)) throw new SyntaxError('Invalid structured string');
            return '"' + item.value.replace(/["\\]/g, '\\$&') + '"';
        case 'token':
            if (!/^[A-Za-z*][A-Za-z0-9!#$%&'*+.^_`|~:/-]*$/.test(item.value)) throw new SyntaxError('Invalid token');
            return item.value;
        case 'boolean': return item.value ? '?1' : '?0';
        case 'bytes': return ':' + base64(item.value) + ':';
        case 'integer':
            if (!Number.isInteger(item.value) || Math.abs(item.value) > 999999999999999) throw new SyntaxError('Invalid integer');
            return String(item.value);
        case 'decimal': {
            if (!Number.isFinite(item.value) || Math.abs(item.value) > 999999999999.999) throw new SyntaxError('Invalid decimal');
            let value = item.value.toFixed(3);
            while (value.endsWith('0')) value = value.slice(0, -1);
            return value.endsWith('.') ? value + '0' : value;
        }
    }
}
function serializeParameters(parameters: SfParameters): string {
    return [...parameters].map(([key, value]) => {
        if (!/^[a-z*][a-z0-9_.*-]*$/.test(key)) throw new SyntaxError('Invalid parameter key');
        return ';' + key + (value.type === 'boolean' && value.value ? '' : '=' + serializeBareItem(value));
    }).join('');
}
export function serializeMember(member: SfMember): string {
    return (member.type === 'item' ? serializeBareItem(member.bare) : '(' + member.items.map(serializeMember).join(' ') + ')') + serializeParameters(member.parameters);
}
export function serializeDictionary(dictionary: SfDictionary): string {
    return [...dictionary].map(([key, member]) => {
        if (!/^[a-z*][a-z0-9_.*-]*$/.test(key)) throw new SyntaxError('Invalid dictionary key');
        return key + (member.type === 'item' && member.bare.type === 'boolean' && member.bare.value
            ? serializeParameters(member.parameters) : '=' + serializeMember(member));
    }).join(', ');
}
