export function decoyHeaders(type: string): Record<string, string> {
    return { 'Content-Type': type + '; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet', 'Cache-Control': 'no-store' };
}
