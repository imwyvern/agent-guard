/** Conservative subset for operator-supplied allowlist regexes. Unsupported
 * patterns are skipped, so request UAs cannot trigger JS regexp backtracking.
 * Literal alternatives/groups and one repeated character/class are supported. */
export function boundedUAPattern(pattern: RegExp): boolean {
    const source = pattern.source;
    if (source.length > 256 || pattern.flags.includes('v')) return false;
    let repeats = 0, inClass = false, previous = '';
    for (let i = 0; i < source.length; i++) {
        const char = source[i]!;
        if (char === '\\') {
            const escaped = source[++i];
            if (!escaped || '123456789k'.includes(escaped)) return false;
            previous = 'atom';
            continue;
        }
        if (char === '[' && !inClass) { inClass = true; continue; }
        if (char === ']' && inClass) { inClass = false; previous = 'atom'; continue; }
        if (inClass) continue;
        if (char === '(' && source[i + 1] === '?') {
            if (source[i + 2] !== ':') return false;
            i += 2;
        } else if ('*+?{'.includes(char)) {
            if (previous === ')' || previous === 'repeat' || ++repeats > 1) return false;
            if (char === '{') {
                const end = source.indexOf('}', i);
                if (end < 0 || end - i > 8) return false;
                i = end;
            }
            previous = 'repeat';
            continue;
        }
        previous = char;
    }
    return !inClass;
}
