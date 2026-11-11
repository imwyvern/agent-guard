import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ipNumber, inCidr, redactIp } from '../../src/core/ip-parse.js';
import { clientKey } from '../../src/core/client-key.js';
import { generator } from '../helpers/prng.js';

// The pre-refactor parser is the differential oracle; validation stays in Node.
function legacyIpNumber(ip: string): { value: bigint; bits: number } | undefined {
    ip = ip.toLowerCase().split('%')[0]!;
    if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
    if (isIP(ip) === 4) return { value: ip.split('.').reduce((n, v) => (n << 8n) + BigInt(v), 0n), bits: 32 };
    if (isIP(ip) !== 6) return;
    if (ip.includes('.')) {
        const i = ip.lastIndexOf(':'), v = legacyIpNumber(ip.slice(i + 1))!;
        ip = ip.slice(0, i) + ':' + (v.value >> 16n).toString(16) + ':' + (v.value & 65535n).toString(16);
    }
    const parts = ip.split('::'), left = parts[0]!.split(':').filter(Boolean), right = (parts[1] ?? '').split(':').filter(Boolean);
    const words = parts.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right] : left;
    return { value: words.reduce((n, v) => (n << 16n) + BigInt('0x' + v), 0n), bits: 128 };
}

const addresses = [
    '0.0.0.0', '255.255.255.255', '127.0.0.1', '192.0.2.1', '1.2.3.4',
    '::', '::1', '1::', '1::1', '2001:db8::', '2001:DB8:1:2:3:4:5:6', '1:2:3:4:5:6:7:8',
    'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '0:0:0:0:0:0:0:0', '1:2:3:4:5:6:7::', '::1:2:3:4:5:6:7',
    '::ffff:192.0.2.1', '::FFFF:192.0.2.1', '::ffff:c000:201', '0:0:0:0:0:ffff:192.0.2.1',
    '2001:db8::192.0.2.1', '::192.0.2.1', '1:2:3:4:5:6:192.0.2.1', '1:2:3:4:5::192.0.2.1',
    'fe80::1%eth0', 'fe80::1%1', '192.0.2.1%scope', '::ffff:192.0.2.1%scope', '::1%arbitrary%scope',
    '', 'bad', 'localhost', '1', '1.2.3', '1.2.3.4.5', '256.1.2.3', '01.2.3.4', '1.02.3.4',
    '1.2.3.000', '-1.2.3.4', '+1.2.3.4', '0x1.2.3.4', '1..2.3', ' 1.2.3.4', '1.2.3.4 ',
    '1.2.3.4\n', '1.2.3.4\r', '1.2.3.4\0', '1.2.3.4/24', '[::1]', '[::1]:80',
    ':', ':::', '1:::2', '1::2::3', ':1:2:3:4:5:6:7', '1:2:3:4:5:6:7:', '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7::8', '12345::', 'gggg::', '::1\n', '::1\r', '::1\0',
    '::ffff:256.0.0.1', '::ffff:192.000.2.1', '::ffff:192.0.2.1\n', '1:2:3:4:5:192.0.2.1',
    '1:2:3:4:5:6:7:192.0.2.1', '::ffff:192.0.2.1:1', '192.0.2.1::', '::192.0.2', '::ffff:0x7f.0.0.1',
];

describe('pure IP parser', () => {
    it.each(addresses)('matches Node validation and the original numeric interpretation (fixture %#)', ip => {
        const expected = legacyIpNumber(ip), normalized = ip.toLowerCase().split('%')[0]!;
        expect(ipNumber(ip)).toEqual(expected);
        expect(ipNumber(ip) !== undefined).toBe(isIP(normalized) !== 0);
        const network = expected ? (expected.value >> BigInt(expected.bits === 32 ? 8 : 80)).toString(16) : 'unknown';
        expect(clientKey(ip, 'fixture-ua')).toBe(createHash('sha256').update(network + '|fixture-ua').digest('hex').slice(0, 16));
    });
    it('preserves dotted mapped IPv4, hex-mapped IPv6 and embedded IPv6 distinctions', () => {
        expect(ipNumber('::ffff:192.0.2.1')).toEqual({ value: 0xc0000201n, bits: 32 });
        expect(ipNumber('::ffff:c000:201')).toEqual({ value: 0xffffc0000201n, bits: 128 });
        expect(ipNumber('0:0:0:0:0:ffff:192.0.2.1')).toEqual({ value: 0xffffc0000201n, bits: 128 });
        expect(ipNumber('2001:db8::192.0.2.1')).toEqual({ value: 0x20010db80000000000000000c0000201n, bits: 128 });
    });
    it('agrees with Node on seeded IPv4, compressed/embedded IPv6 and malformed variants', () => {
        const random = generator(0x4b1f00d);
        for (let i = 0; i < 500; i++) {
            const v4 = Array.from({ length: 4 }, () => random.int(256)).join('.');
            const words = Array.from({ length: 8 }, () => random.int(65536).toString(16));
            const full = words.join(':'), compressed = words.slice(0, i % 7).join(':') + '::' + words.slice(i % 7 + 1).join(':');
            const embedded = words.slice(0, 6).join(':') + ':' + v4;
            for (const ip of [v4, full, compressed, embedded, '::ffff:' + v4, v4 + '\n', full + '\n', '0' + v4, full + ':0', compressed + '::'])
                expect(ipNumber(ip)).toEqual(legacyIpNumber(ip));
        }
    });
    it.each([
        ['192.0.2.1', '0.0.0.0/0', true], ['192.0.2.1', '192.0.2.0/24', true], ['192.0.3.1', '192.0.2.0/24', false],
        ['192.0.2.1', '192.0.2.1/32', true], ['192.0.2.2', '192.0.2.1/32', false], ['192.0.2.1', '192.0.2.0', false],
        ['192.0.2.1', '192.0.2.0/-1', false], ['192.0.2.1', '192.0.2.0/33', false], ['192.0.2.1', '192.0.2.0/1.5', false],
        ['192.0.2.1', '192.0.2.0/NaN', false], ['192.0.2.1', '192.0.2.0/Infinity', false], ['192.0.2.1', '192.0.2.0/', true],
        ['192.0.2.1', '192.0.2.0/24/extra', true], ['192.0.2.1', '192.0.2.1/0x20', true], ['192.0.2.1', '192.0.2.1/1e1', true],
        ['::ffff:192.0.2.1', '192.0.2.0/24', true], ['192.0.2.1', '::ffff:192.0.2.0/24', true], ['192.0.2.1', '::ffff:c000:200/120', false],
        ['2001:db8::1', '::/0', true], ['2001:db8::1', '2001:db8::/32', true], ['2001:db8::1', '2001:db8::1/128', true],
        ['2001:db8::2', '2001:db8::1/128', false], ['2001:db8::1', '2001:db8::/129', false], ['::1', '0.0.0.0/0', false],
        ['bad', '0.0.0.0/0', false], ['192.0.2.1', 'bad/24', false], ['192.0.2.1', '/0', false],
    ] as const)('preserves CIDR edge behavior (fixture %#)', (ip, cidr, expected) => {
        expect(inCidr(ip, cidr)).toBe(expected);
    });
    it.each([
        ['192.0.2.1', '192.0.2.x'], ['::ffff:192.0.2.1', '192.0.2.x'], ['2001:db8:1234:abcd::1', '2001:db8:1234::/48'],
        ['fe80::1%eth0', 'fe80:0:0::/48'], ['::ffff:c000:201', '0:0:0::/48'], ['bad', 'unknown'],
    ])('preserves IP redaction (fixture %#)', (ip, expected) => {
        expect(redactIp(ip!)).toBe(expected);
    });
});
