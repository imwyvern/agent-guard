import { vi, afterEach } from 'vitest';
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== '127.0.0.1')
        throw new Error(`Outbound network forbidden: ${url.hostname}`);
    return originalFetch(input, init);
}) as typeof fetch;
vi.mock('node:dns/promises', () => ({ reverse: vi.fn(async () => { throw new Error('Uninjected DNS forbidden'); }), resolve4: vi.fn(async () => { throw new Error('Uninjected DNS forbidden'); }), resolve6: vi.fn(async () => { throw new Error('Uninjected DNS forbidden'); }) }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
