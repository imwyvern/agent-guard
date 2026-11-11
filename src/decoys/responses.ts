import type { CryptoProvider } from '../crypto/types.js';
import { utf8ByteLength } from '../crypto/bytes.js';
import { patterns } from '../core/signals.js';
import type { AGRequest, AGResponse, AgentGuardConfig, DecoyId } from '../types.js';
import type { Registry } from '../canary/registry-core.js';
import { fakeData } from './fake-data-core.js';
import { decoyHeaders } from './headers.js';
import { envBody } from './d1-env.js';
import { adminResponse } from './d2-admin.js';
import { opsBody } from './d3-ops-notes.js';
import { openapiBody } from './d4-openapi.js';
import { loginResponse } from './d5-login.js';
import { CallbackCanaries } from '../canary/callback-core.js';
export class Decoys {
    readonly paths: Record<DecoyId, string[]>;
    private enabled: Set<DecoyId>;
    private bodies: Partial<Record<DecoyId, string>> = {};
    private delay: number;
    private readonly callbacks?: CallbackCanaries;
    constructor(config: AgentGuardConfig, registry: Registry, crypto: CryptoProvider) {
        if (config.canary.callback) this.callbacks = new CallbackCanaries(config, crypto);
        const base = (config.decoys?.basePath ?? '/api/internal').replace(patterns.trailingSlash, '');
        this.paths = { D1: ['/.env', '/.env.local', '/.env.production', '/.env.bak'], D2: [base + '/admin'], D3: ['/internal/ops-notes'], D4: [base + '/openapi.json'], D5: [base + '/auth/login'] };
        for (const id of Object.keys(this.paths) as DecoyId[]) {
            const override = config.decoys?.paths?.[id];
            if (override)
                this.paths[id] = typeof override === 'string' ? [override] : override;
        }
        this.enabled = new Set(config.decoys?.enabled ?? ['D1', 'D2', 'D3', 'D4', 'D5']);
        const fake = fakeData(config.projectSeed, crypto);
        this.delay = fake.loginDelay;
        const token = (id: DecoyId, field: string) => registry.placement(`${id}:${this.paths[id][0]}#${field}`, config.env).token;
        if (this.enabled.has('D1'))
            this.bodies.D1 = envBody(['DATABASE_URL', 'ADMIN_API_TOKEN', 'STRIPE_SECRET_KEY'].map(f => token('D1', f)), fake.database, fake.region, fake.revision);
        if (this.enabled.has('D3'))
            this.bodies.D3 = opsBody(token('D3', 'password'), token('D3', 'api_key'), config.decoys?.siteName ?? fake.site);
        if (this.enabled.has('D4'))
            this.bodies.D4 = openapiBody(token('D4', 'bearer'), this.paths.D2[0]!);
        for (const body of Object.values(this.bodies))
            if (utf8ByteLength(body) > 8192)
                throw new Error('decoy body exceeds 8 KB');
    }
    match(path: string, method: string): DecoyId | undefined {
        for (const id of this.enabled)
            if (this.paths[id].some(p => id === 'D2' ? (path === p || path.startsWith(p + '/')) : path === p)) {
                if (id === 'D1' && method !== 'GET' && method !== 'HEAD')
                    continue;
                if ((id === 'D3' || id === 'D4') && method !== 'GET' && method !== 'HEAD')
                    continue;
                return id;
            }
        return;
    }
    async respond(id: DecoyId, req: AGRequest, mazeEntry?: string): Promise<AGResponse> {
        if (id === 'D5')
            return loginResponse(req.method, this.delay);
        const response = id === 'D2' ? adminResponse(String(req.headers.authorization ?? ''), this.paths.D4[0]!) :
            { status: 200, headers: decoyHeaders(id === 'D1' ? 'text/plain' : id === 'D3' ? 'text/html' : 'application/json'), body: this.bodies[id]! };
        const callback = this.callbacks?.url(id);
        if (mazeEntry || callback) {
            if (id === 'D1') response.body += (mazeEntry ? `ARCHIVE_INDEX=${mazeEntry}\n` : '') + (callback ? `CALLBACK_URL=${callback}\n` : '');
            else if (id === 'D3') {
                const escape = (value: string) => value.replace(patterns.ampersand, '&amp;').replace(patterns.lessThan, '&lt;').replace(patterns.quote, '&quot;');
                response.body = response.body.replace('</body>', (mazeEntry ? `<p><a rel="nofollow" href="${escape(mazeEntry)}">Archive index</a></p>` : '') + (callback ? `<p>Callback reference: ${escape(callback)}</p>` : '') + '</body>');
            } else response.body = JSON.stringify({ ...JSON.parse(response.body) as object, ...(mazeEntry ? { 'x-archive-index': mazeEntry } : {}), ...(callback ? { 'x-callback-url': callback } : {}) });
            if (utf8ByteLength(response.body) > 8192) throw new Error('decoy body exceeds 8 KB');
        }
        return response;
    }
    disallowed(): string[] {
        const paths = [...this.enabled].flatMap(id => this.paths[id]);
        if (paths.includes('/internal/ops-notes'))
            paths.push('/internal/');
        if (paths.some(p => p.startsWith('/api/internal/')))
            paths.push('/api/internal/');
        return [...new Set(paths)];
    }
}
