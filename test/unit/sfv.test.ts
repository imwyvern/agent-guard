import { describe, expect, it } from 'vitest';
import { decodeBase64, parseDictionary, parseItem, serializeDictionary, serializeMember } from '../../src/crawler/sfv.js';

describe('RFC 8941 signature fields', () => {
    it.each([
        ['', ''], ['a', 'a'], ['a=?1', 'a'], ['a=?0', 'a=?0'],
        ['a=1, b=-999999999999999', 'a=1, b=-999999999999999'],
        ['a=001, b=-0', 'a=1, b=0'], ['a=1.230, b=-0.000', 'a=1.23, b=0.0'],
        ['a=999999999999.999', 'a=999999999999.999'], ['a=Token:/x', 'a=Token:/x'],
        ['a="escaped \\" quote \\\\ slash"', 'a="escaped \\" quote \\\\ slash"'],
        ['a=:YWJjZA:;p', 'a=:YWJjZA==:;p'], ['a=::', 'a=::'],
        ['a=("@authority" "signature-agent";key="a");created=123;tag="web-bot-auth"', 'a=("@authority" "signature-agent";key="a");created=123;tag="web-bot-auth"'],
        ['  a=(  "@method"   "@path"  ); p=?1,\tb="url"  ', 'a=("@method" "@path");p, b="url"'],
        ['a=();p=42, b;name="v"', 'a=();p=42, b;name="v"'],
    ])('parses and canonically serializes %s', (source, expected) => {
        const parsed = parseDictionary(source!);
        expect(serializeDictionary(parsed)).toBe(expected);
        expect(serializeDictionary(parseDictionary(serializeDictionary(parsed)))).toBe(expected);
    });
    it('preserves component and signature parameter order', () => {
        const member = parseDictionary('a=("@path" "@method");expires=20;created=10;keyid="k"').get('a')!;
        expect([...member.parameters.keys()]).toEqual(['expires', 'created', 'keyid']);
        expect(serializeMember(member)).toBe('("@path" "@method");expires=20;created=10;keyid="k"');
        expect(parseItem(' "https://agent.test/jwks" ').bare).toEqual({ type: 'string', value: 'https://agent.test/jwks' });
    });
    it.each([
        'A=1', '1a=1', 'a=1,', ',a', 'a=1,,b=2', 'a =1', 'a= 1',
        'a="unterminated', 'a="bad\\x"', 'a="a\nb"', 'a="é"', 'a="\u007f"',
        'a=?2', 'a=?10', 'a=-', 'a=1000000000000000', 'a=1000000000000.1', 'a=1.', 'a=.1', 'a=1.1234',
        'a=:a:', 'a=:ab=c:', 'a=:!!!!:', 'a=:YWJjZA=:', 'a=:abc',
        'a=("x"\t"y")', 'a=(("x"))', 'a=("x"', 'a=("x""y")', 'a=("x"), a=("y")',
        'a=1;p=2;p=3', 'a=("x";key="a";key="b")', 'a=1;', 'a=1;P',
    ])('rejects malformed or ambiguous input %j', source => {
        expect(() => parseDictionary(source)).toThrow();
    });
    it('bounds field bytes, dictionary members, components and parameters', () => {
        expect(() => parseDictionary('a="' + 'x'.repeat(65536) + '"')).toThrow();
        expect(() => parseDictionary(Array.from({ length: 129 }, (_, i) => 'a' + i).join(','))).toThrow();
        expect(() => parseDictionary('a=(' + Array(129).fill('"x"').join(' ') + ')')).toThrow();
        expect(() => parseDictionary('a' + Array.from({ length: 129 }, (_, i) => ';p' + i).join(''))).toThrow();
        expect(() => parseItem('"x", "y"')).toThrow();
    });
    it('decodes binary bytes without changing high bits', () => {
        expect([...decodeBase64('AP+A')]).toEqual([0, 255, 128]);
    });
});
