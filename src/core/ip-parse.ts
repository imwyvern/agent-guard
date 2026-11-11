function ipv4Number(ip: string): number | undefined {
    const parts = ip.split('.');
    if (parts.length !== 4) return;
    let value = 0;
    for (const part of parts) {
        if (!part.length || part.length > 3 || (part.length > 1 && part[0] === '0') || Number(part) > 255) return;
        for (let i = 0; i < part.length; i++) if (part.charCodeAt(i) < 48 || part.charCodeAt(i) > 57) return;
        value = value * 256 + Number(part);
    }
    return value;
}
function invalidWord(word: string): boolean {
    if (!word.length || word.length > 4) return true;
    for (let i = 0; i < word.length; i++) {
        const code = word.charCodeAt(i);
        if (!(code >= 48 && code <= 57) && !(code >= 97 && code <= 102)) return true;
    }
    return false;
}
export function ipNumber(ip: string): { value: bigint; bits: number } | undefined {
    ip = ip.toLowerCase().split('%')[0]!;
    if (ip.startsWith('::ffff:')) {
        const mapped = ipv4Number(ip.slice(7));
        if (mapped !== undefined) return { value: BigInt(mapped), bits: 32 };
    }
    if (!ip.includes(':')) {
        const value = ipv4Number(ip);
        return value === undefined ? undefined : { value: BigInt(value), bits: 32 };
    }
    if (ip.includes('.')) {
        const i = ip.lastIndexOf(':'), value = ipv4Number(ip.slice(i + 1));
        if (value === undefined) return;
        ip = ip.slice(0, i) + ':' + (value >>> 16).toString(16) + ':' + (value & 65535).toString(16);
    }
    const parts = ip.split('::');
    if (parts.length > 2) return;
    const left = parts[0] ? parts[0].split(':') : [], right = parts[1] ? parts[1].split(':') : [];
    const length = left.length + right.length;
    if (parts.length === 2 ? length >= 8 : length !== 8) return;
    if (left.some(invalidWord) || right.some(invalidWord)) return;
    const words = parts.length === 2 ? [...left, ...Array<string>(8 - length).fill('0'), ...right] : left;
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
export function redactIp(ip: string): string {
    const parsed = ipNumber(ip);
    if (!parsed)
        return 'unknown';
    return parsed.bits === 32 ? `${Number(parsed.value >> 24n)}.${Number((parsed.value >> 16n) & 255n)}.${Number((parsed.value >> 8n) & 255n)}.x` : [parsed.value >> 112n, (parsed.value >> 96n) & 65535n, (parsed.value >> 80n) & 65535n].map(word => word.toString(16)).join(':') + '::/48';
}
