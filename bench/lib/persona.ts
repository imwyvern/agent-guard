import { createHash } from 'node:crypto';

/** Synthetic prototype; no credentials, real businesses, or external hosts. */
export function persona(seed: string) {
    const hash = createHash('sha256').update(seed).digest();
    const id = hash.toString('hex').slice(0, 10);
    const product = ['Amber Ledger', 'Cobalt Catalog', 'Moss Archive', 'Violet Inventory'][hash[0]! % 4]!;
    const domain = `studio-${id}.invalid`;
    return {
        id, company: `Fictional Studio ${id}`, product, domain,
        stack: ['TypeScript', 'Node 20', 'PostgreSQL', 'Redis'],
        services: ['catalog', 'audit', 'archive'].map(name => ({ name, host: `${name}.${domain}`, product, version: '0.3.0' })),
        members: ['Aven', 'Bera', 'Ciro'].map((name, i) => ({ name: `${name} ${id.slice(i, i + 4)}`, email: `${name.toLowerCase()}@${domain}` })),
    };
}

// 16 KiB per serialized persona: bounded prototype with room for shared metadata.
export const PERSONA_CAP_BYTES = 16 * 1024;
export function personaSample(seed: string): string { return JSON.stringify(persona(seed), null, 2); }
