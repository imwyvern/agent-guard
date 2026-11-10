import type { AGRequest, AGResponse, AgentGuardConfig, DecoyId } from '../types.js';
import type { Registry } from '../canary/registry.js';
import { fakeData } from './fake-data.js';
import { decoyHeaders } from './headers.js';
import { envBody } from './d1-env.js';
import { adminResponse } from './d2-admin.js';
import { opsBody } from './d3-ops-notes.js';
import { openapiBody } from './d4-openapi.js';
import { loginResponse } from './d5-login.js';
export class Decoys {
    readonly paths: Record<DecoyId, string[]>;
    private enabled: Set<DecoyId>;
    private bodies: Partial<Record<DecoyId, string>> = {};
    private delay: number;
    constructor(config: AgentGuardConfig, registry: Registry) {
        const base = (config.decoys?.basePath ?? '/api/internal').replace(/\/$/, '');
        this.paths = { D1: ['/.env', '/.env.local', '/.env.production', '/.env.bak'], D2: [base + '/admin'], D3: ['/internal/ops-notes'], D4: [base + '/openapi.json'], D5: [base + '/auth/login'] };
        for (const id of Object.keys(this.paths) as DecoyId[]) {
            const override = config.decoys?.paths?.[id];
            if (override)
                this.paths[id] = typeof override === 'string' ? [override] : override;
        }
        this.enabled = new Set(config.decoys?.enabled ?? ['D1', 'D2', 'D3', 'D4', 'D5']);
        const fake = fakeData(config.projectSeed);
        this.delay = fake.loginDelay;
        const token = (id: DecoyId, field: string) => registry.placement(`${id}:${this.paths[id][0]}#${field}`, config.env).token;
        if (this.enabled.has('D1'))
            this.bodies.D1 = envBody(['DATABASE_URL', 'ADMIN_API_TOKEN', 'STRIPE_SECRET_KEY'].map(f => token('D1', f)), fake.database, fake.region, fake.revision);
        if (this.enabled.has('D3'))
            this.bodies.D3 = opsBody(token('D3', 'password'), token('D3', 'api_key'), config.decoys?.siteName ?? fake.site);
        if (this.enabled.has('D4'))
            this.bodies.D4 = openapiBody(token('D4', 'bearer'), this.paths.D2[0]!);
        for (const body of Object.values(this.bodies))
            if (Buffer.byteLength(body) > 8192)
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
    async respond(id: DecoyId, req: AGRequest): Promise<AGResponse> {
        if (id === 'D2')
            return adminResponse(String(req.headers.authorization ?? ''), this.paths.D4[0]!);
        if (id === 'D5')
            return loginResponse(req.method, this.delay);
        const body = this.bodies[id]!;
        return { status: 200, headers: decoyHeaders(id === 'D1' ? 'text/plain' : id === 'D3' ? 'text/html' : 'application/json'), body };
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
