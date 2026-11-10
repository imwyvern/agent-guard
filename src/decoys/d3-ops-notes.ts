export function opsBody(password: string, apiKey: string, site: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow,noarchive"><title>Ops notes (internal, do not share)</title></head><body><h1>Ops notes (internal, do not share)</h1><p>Internal staging reference, read-only maintenance account.</p><dl><dt>Account</dt><dd>ops-admin@${site}</dd><dt>Password</dt><dd>${password}</dd><dt>API key</dt><dd>${apiKey}</dd><dt>SSH bastion</dt><dd>bastion.internal.invalid</dd></dl></body></html>`;
}
