import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
export function ipNumber(ip: string): {
    value: bigint;
    bits: number;
} | undefined {
    ip = ip.toLowerCase().split('%')[0]!;
    if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4)
        ip = ip.slice(7);
    if (isIP(ip) === 4)
        return { value: ip.split('.').reduce((n, v) => (n << 8n) + BigInt(v), 0n), bits: 32 };
    if (isIP(ip) !== 6)
        return;
    if (ip.includes('.')) {
        const i = ip.lastIndexOf(':');
        const v = ipNumber(ip.slice(i + 1))!;
        ip = ip.slice(0, i) + ':' + (v.value >> 16n).toString(16) + ':' + (v.value & 65535n).toString(16);
    }
    const parts = ip.split('::'), left = parts[0]!.split(':').filter(Boolean), right = (parts[1] ?? '').split(':').filter(Boolean);
    const words = parts.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right] : left;
    return { value: words.reduce((n, v) => (n << 16n) + BigInt('0x' + v), 0n), bits: 128 };
}
export function inCidr(ip: string, cidr: string): boolean {
    const [network, width] = cidr.split('/'), a = ipNumber(ip), b = ipNumber(network!);
    const bits = Number(width);
    if (!a || !b || a.bits !== b.bits || width === undefined || !Number.isInteger(bits) || bits < 0 || bits > a.bits)
        return false;
    const shift = BigInt(a.bits - bits);
    return a.value >> shift === b.value >> shift;
}
export function clientKey(ip: string, ua: string): string {
    const parsed = ipNumber(ip);
    const network = parsed ? (parsed.value >> BigInt(parsed.bits === 32 ? 8 : 80)).toString(16) : 'unknown';
    return createHash('sha256').update(network + '|' + ua).digest('hex').slice(0, 16);
}
export function redactIp(ip: string): string {
    const parsed = ipNumber(ip);
    if (!parsed)
        return 'unknown';
    return parsed.bits === 32 ? `${Number(parsed.value >> 24n)}.${Number((parsed.value >> 16n) & 255n)}.${Number((parsed.value >> 8n) & 255n)}.x` : [parsed.value >> 112n, (parsed.value >> 96n) & 65535n, (parsed.value >> 80n) & 65535n].map(word => word.toString(16)).join(':') + '::/48';
}
