import type { CryptoProvider } from '../crypto/types.js';
import type { AgentGuardConfig, DecoyId } from '../types.js';
import { base32 } from '../core/ulid-core.js';
import { patterns } from '../core/signals.js';

/** Dedicated inert format with a 100-bit MAC and domain separation from replay
 * canaries and maze nodes. Stable IDs let separate guard instances share a handler. */
export class CallbackCanaries {
    private readonly placements = new Map<string, string>();
    constructor(private readonly config: AgentGuardConfig, private readonly crypto: CryptoProvider) {
        for (const id of ['D1', 'D2', 'D3', 'D4'] as const) this.placements.set(this.id(id), `${id}:callback`);
    }
    private digest(value: string): string { return base32(this.crypto.hmacSha256(this.config.canary.secret, value)); }
    private id(id: DecoyId): string { return this.digest(`callback:id|${this.config.env}|${id}`).slice(0, 12); }
    private mac(id: string): string { return this.digest(`callback:v1|${this.config.env}|${id}`).slice(0, 20); }
    url(placement: DecoyId): string | undefined {
        const base = this.config.canary.callback?.baseUrl;
        if (!base) return;
        const id = this.id(placement);
        let end = base.length;
        while (end > 0 && base[end - 1] === '/') end--;
        return base.slice(0, end) + `/ag/cb/AGCB-CANARY-${id}-${this.mac(id)}`;
    }
    verify(path: string): { id: string; placement: string } | undefined {
        if (!this.config.canary.callback) return;
        const match = patterns.callbackPath.exec(path);
        if (!match || !this.crypto.secretEqual(match[2]!, this.mac(match[1]!))) return;
        const id = match[1]!, placement = this.placements.get(id);
        return placement ? { id, placement } : undefined;
    }
}
