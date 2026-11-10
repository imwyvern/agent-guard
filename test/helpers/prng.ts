/** Mulberry32: repeatable fuzz cases, with no runtime/test dependency. */
export function generator(seed: number) {
    const next = (): number => {
        seed |= 0; seed = seed + 0x6d2b79f5 | 0;
        let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
        value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
    const int = (max: number): number => Math.floor(next() * max);
    const string = (max = 512): string => {
        const alphabet = 'abZ019-/%.?=&:AG-CANARY-\r\n\t\0\x1b\x7f\x85\u2028é中😀';
        let value = '';
        for (let n = int(max + 1); n > 0; n--) value += alphabet[int(alphabet.length)];
        return value;
    };
    const value = (depth = 0): unknown => {
        switch (int(depth < 4 ? 7 : 4)) {
            case 0: return null;
            case 1: return int(1000);
            case 2: return Boolean(int(2));
            case 3: return string();
            case 4: return Array.from({ length: int(8) }, () => value(depth + 1));
            default: return Object.fromEntries(Array.from({ length: int(8) }, () => [string(24), value(depth + 1)]));
        }
    };
    return { next, int, string, value };
}
