import { expect, it, vi } from 'vitest';
import { WebBotAuthVerifier } from '../../src/crawler/web-bot-auth.js';
import { agent, jsonResponse, now, signedRequest, testKey } from '../fixtures/web-bot-auth.js';
import type { WebBotAuthFetchOptions } from '../../src/crawler/web-bot-auth-types.js';

it('accepts and advertises the draft -01 section 8 directory media type', async () => {
    const mediaType = 'application/http-message-signatures-directory+json';
    const fetcher = vi.fn(async (_url: string, _init: Parameters<WebBotAuthFetchOptions['fetcher']>[1]) =>
        jsonResponse({ keys: [(await testKey()).key] }, { 'Content-Type': mediaType.toUpperCase() + '; charset=utf-8' }));
    const verifier = new WebBotAuthVerifier({ enabled: true, trustedAgents: [{ url: agent }], fetchKeys: { fetcher, allowHosts: ['agent.test'] } });
    expect(await verifier.verify(await signedRequest(), now)).toMatchObject({ verified: true, trusted: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetcher.mock.calls[0]![1].headers);
    expect(headers.get('accept')!.split(',').map(value => value.trim())).toEqual([
        'application/jwk-set+json', 'application/json', mediaType,
    ]);
});
