import type { AGRequest, AGResponse, AgentGuardConfig, DecoyId } from '../types.js';
import { webCrypto } from '../crypto/web.js';
import { hex, utf8ByteLength } from '../crypto/bytes.js';
import { formatFakeData } from '../decoys/fake-data-core.js';
import { DecoyRoutes, respondDecoy } from '../decoys/responses.js';
import { envBody } from '../decoys/d1-env.js';
import { opsBody } from '../decoys/d3-ops-notes.js';
import { openapiBody } from '../decoys/d4-openapi.js';
import { base32 } from '../core/ulid-core.js';
import { patterns } from '../core/signals.js';
import type { WebRegistry } from './registry.js';

export class WebDecoys extends DecoyRoutes {
    private ready?: Promise<void>;
    private bodies: Partial<Record<DecoyId, string>> = {};
    private delay = 0;
    constructor(private readonly config: AgentGuardConfig, private readonly registry: WebRegistry) { super(config); }
    private async prepare(): Promise<void> {
        const config = this.config, fake = formatFakeData(hex(await webCrypto.sha256(config.projectSeed)));
        this.delay = fake.loginDelay;
        const token = async (id: DecoyId, field: string) => (await this.registry.placement(`${id}:${this.paths[id][0]}#${field}`, config.env)).token;
        if (this.enabled.has('D1')) this.bodies.D1 = envBody(await Promise.all(['DATABASE_URL', 'ADMIN_API_TOKEN', 'STRIPE_SECRET_KEY'].map(f => token('D1', f))), fake.database, fake.region, fake.revision);
        if (this.enabled.has('D3')) this.bodies.D3 = opsBody(await token('D3', 'password'), await token('D3', 'api_key'), config.decoys?.siteName ?? fake.site);
        if (this.enabled.has('D4')) this.bodies.D4 = openapiBody(await token('D4', 'bearer'), this.paths.D2[0]!);
        for (const body of Object.values(this.bodies)) if (utf8ByteLength(body) > 8192) throw new Error('decoy body exceeds 8 KB');
    }
    async respond(id: DecoyId, req: AGRequest, mazeEntry?: string): Promise<AGResponse> {
        await (this.ready ??= this.prepare());
        return respondDecoy(id, req, this.paths, this.bodies, this.delay, mazeEntry, await this.callbackUrl(id));
    }
    private async digest(value: string): Promise<string> { return base32(await webCrypto.hmacSha256(this.config.canary.secret, value)); }
    private async callbackId(id: DecoyId): Promise<string> { return (await this.digest(`callback:id|${this.config.env}|${id}`)).slice(0, 12); }
    private async callbackMac(id: string): Promise<string> { return (await this.digest(`callback:v1|${this.config.env}|${id}`)).slice(0, 20); }
    private async callbackUrl(id: DecoyId): Promise<string | undefined> {
        const base = this.config.canary.callback?.baseUrl;
        if (!base) return;
        const value = await this.callbackId(id);
        let end = base.length;
        while (end > 0 && base[end - 1] === '/') end--;
        return base.slice(0, end) + `/ag/cb/AGCB-CANARY-${value}-${await this.callbackMac(value)}`;
    }
    async callback(path: string): Promise<{ id: string; placement: string } | undefined> {
        if (!this.config.canary.callback) return;
        const match = patterns.callbackPath.exec(path);
        if (!match || !webCrypto.secretEqual(match[2]!, await this.callbackMac(match[1]!))) return;
        for (const placement of ['D1', 'D2', 'D3', 'D4'] as const)
            if (webCrypto.secretEqual(match[1]!, await this.callbackId(placement))) return { id: match[1]!, placement: `${placement}:callback` };
        return;
    }
}
