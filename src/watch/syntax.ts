/** Small linear character scans keep log parsing bounded without backtracking. */
export function hasOnly(value: string, alphabet: string): boolean {
    if (!value) return false;
    for (const char of value) if (!alphabet.includes(char)) return false;
    return true;
}

export const digits = '0123456789';
export const hexDigits = digits + 'abcdefABCDEF';
export const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function space(char: string | undefined): boolean { return char === ' ' || char === '\t'; }

export function unsafeText(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if ((code < 32 && code !== 9) || (code >= 127 && code <= 159) || code === 0xfffd) return true;
    }
    return false;
}
