import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { nodeCrypto } from '../../src/crypto/node.js';
import type { CryptoProvider } from '../../src/crypto/types.js';
import { hex } from '../../src/crypto/bytes.js';
import { generateCanary, verifyCanary, checksum } from '../../src/canary/format.js';
import { formatCanary, parseCanary } from '../../src/canary/format-core.js';
import { Registry } from '../../src/canary/registry.js';
import { CallbackCanaries } from '../../src/canary/callback.js';
import { CallbackCanaries as CoreCallbacks } from '../../src/canary/callback-core.js';
import { Maze } from '../../src/core/maze.js';
import { encodeMazeNode, mazeMac, mazeMacInput, mazeRoot, parseMazeNode, verifyMazeNode } from '../../src/core/maze-nodes.js';
import { alphabet, base32, ulid } from '../../src/core/ulid.js';
import { ulid as coreUlid } from '../../src/core/ulid-core.js';
import { clientKey } from '../../src/core/client-key.js';
import { Incidents } from '../../src/core/incidents.js';
import { Incidents as CoreIncidents } from '../../src/core/incidents-core.js';
import { fakeData } from '../../src/decoys/fake-data.js';
import { formatFakeData } from '../../src/decoys/fake-data-core.js';
import { signWebhook, verifyWebhookSignature } from '../../src/alerts/webhook.js';
import { signFeishu } from '../../src/alerts/signing.js';
import { feishuAdapter } from '../../src/alerts/feishu.js';
import { createAgentGuard } from '../../src/index.js';
import { config, event, request } from '../helpers.js';

const secret = 'fixture-secret', timestamp = '1700000000';
function mac(data: string): Uint8Array { return createHmac('sha256', secret).update(data).digest(); }
function flip(character: string): string { return alphabet[alphabet.indexOf(character) ^ 1]!; }

describe('shared crypto golden fixtures', () => {
    it('generates the same canary with injected randomness and directly computed HMAC', () => {
        const bytes = Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7), randomBytes = vi.fn(() => bytes);
        const provider: CryptoProvider = { ...nodeCrypto, randomBytes };
        const generated = generateCanary({ secret }, provider), id = base32(bytes).slice(0, 12);
        const expectedChecksum = base32(mac('AG-CANARY-' + id)).slice(0, 6);
        expect(generated).toEqual({ id, token: `AG-CANARY-${id}-${expectedChecksum}` });
        expect(randomBytes).toHaveBeenCalledExactlyOnceWith(8);
        expect(checksum('AG-CANARY-', id, secret)).toBe(expectedChecksum);
        expect(parseCanary(generated.token, 'AG-CANARY-')).toEqual({ id, checksum: expectedChecksum });
        expect(formatCanary('AG-CANARY-', id, expectedChecksum)).toBe(generated.token);
        expect(verifyCanary(generated.token, { secret })).toEqual({ valid: true, id });
        expect(verifyCanary(generated.token, { secret }, nodeCrypto)).toEqual({ valid: true, id });
    });
    it('verifies a Node-generated token against an independent HMAC provider', () => {
        const generated = generateCanary({ secret }, nodeCrypto);
        const hmacSha256 = vi.fn((key: string | Uint8Array, data: string | Uint8Array) => new Uint8Array(createHmac('sha256', key).update(data).digest()));
        expect(verifyCanary(generated.token, { secret }, { ...nodeCrypto, hmacSha256 })).toEqual({ valid: true, id: generated.id });
        expect(hmacSha256).toHaveBeenCalledExactlyOnceWith(secret, 'AG-CANARY-' + generated.id);
    });
    it('rejects every alternate checksum character through secretEqual', () => {
        const { token } = generateCanary({ secret }), secretEqual = vi.fn(nodeCrypto.secretEqual), provider = { ...nodeCrypto, secretEqual };
        for (let i = token.length - 6; i < token.length; i++) {
            for (const character of alphabet) {
                if (character === token[i]) continue;
                expect(verifyCanary(token.slice(0, i) + character + token.slice(i + 1), { secret }, provider).valid).toBe(false);
            }
        }
        expect(secretEqual).toHaveBeenCalledTimes(6 * 31);
    });
    it('constructs and verifies maze nodes using the original MAC input and encoding', () => {
        const c = config(), maze = new Maze(c, secret, nodeCrypto), parent = '0123456789ABCDEFGHJK', index = 3, depth = 7;
        const expectedMac = base32(mac(`maze:v1|${parent}|3|7`)).slice(0, 20);
        expect(mazeMacInput(parent, index, depth)).toBe(`maze:v1|${parent}|3|7`);
        expect(mazeMac(parent, index, depth, secret, nodeCrypto)).toBe(expectedMac);
        const node = encodeMazeNode(parent, index, depth, expectedMac);
        expect(node).toBe('07' + parent + '3' + expectedMac);
        expect(parseMazeNode(node)).toEqual({ parent, index, depth, mac: expectedMac });
        expect(verifyMazeNode(node, secret, nodeCrypto)).toEqual({ depth, mac: expectedMac });
        expect(maze.valid(maze.prefix + node)).toBe(true);
        expect(maze.valid(maze.prefix + node.slice(0, -1) + flip(node.at(-1)!))).toBe(false);
        const rootMac = base32(mac(`maze:v1|${mazeRoot}|0|0`)).slice(0, 20);
        expect(maze.entry).toBe(maze.prefix + '00' + mazeRoot + '0' + rootMac);
    });
    it('keeps maze structural bounds and root restrictions', () => {
        const mac = '0'.repeat(20);
        for (const [parent, index, depth] of [[mazeRoot, 0, 66], [mazeRoot, 10, 1], [mazeRoot, 1, 0], ['1'.repeat(20), 0, 0]] as const)
            expect(parseMazeNode(encodeMazeNode(parent, index, depth, mac))).toBeUndefined();
        expect(parseMazeNode(encodeMazeNode(mazeRoot, 9, 65, mac))).toEqual({ parent: mazeRoot, index: 9, depth: 65, mac });
        for (const node of ['', '0'.repeat(42), '0'.repeat(44), 'I'.repeat(43), 'a'.repeat(43)]) expect(parseMazeNode(node)).toBeUndefined();
    });
    it('preserves webhook UTF-8 signing, timestamp validation and constant-time verification', () => {
        vi.useFakeTimers(); vi.setSystemTime(1700000000000);
        const body = '{"message":"é中😀"}', expected = 'sha256=' + createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
        expect(signWebhook(body, timestamp, secret)).toBe(expected);
        expect(signWebhook(body, timestamp, secret, nodeCrypto)).toBe(expected);
        const secretEqual = vi.fn(nodeCrypto.secretEqual), provider = { ...nodeCrypto, secretEqual };
        expect(verifyWebhookSignature({ body, timestamp, signature: expected, secret }, provider)).toBe(true);
        const last = expected.endsWith('0') ? '1' : '0';
        expect(verifyWebhookSignature({ body, timestamp, signature: expected.slice(0, -1) + last, secret }, provider)).toBe(false);
        expect(secretEqual).toHaveBeenCalledTimes(2);
    });
    it('preserves Feishu HMAC/base64 and the signed and unsigned adapter payloads', async () => {
        vi.useFakeTimers(); vi.setSystemTime(1700000000000);
        const expected = createHmac('sha256', secret).update(timestamp + '\n' + secret).digest('base64');
        expect(signFeishu(timestamp, secret, nodeCrypto)).toBe(expected);
        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
        const payload = { event: event(), summary: { deduped: 0, rate_limited: 0 } }, signal = new AbortController().signal;
        const hmacSha256 = vi.fn(nodeCrypto.hmacSha256), provider = { ...nodeCrypto, hmacSha256 };
        expect(await feishuAdapter({ url: 'https://alerts.operator.example/fixture', secret }, provider).send(payload, signal)).toEqual({ ok: true, status: 204 });
        const signed = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as Record<string, unknown>;
        expect(signed).toEqual({ msg_type: 'text', content: { text: '[agent-guard] high decoy_hit\ndecoy: D1\npath: /.env\nmethod: GET\nclient_key: key' }, timestamp, sign: expected });
        await feishuAdapter({ url: 'https://alerts.operator.example/fixture' }, provider).send(payload, signal);
        const unsigned = JSON.parse(String(fetch.mock.calls[1]![1]!.body)) as Record<string, unknown>;
        expect(unsigned).toEqual({ msg_type: signed.msg_type, content: signed.content });
        expect(hmacSha256).toHaveBeenCalledExactlyOnceWith(secret, timestamp + '\n' + secret);
    });
    it.each([
        ['192.0.2.99', 'c00002'], ['::ffff:192.0.2.99', 'c00002'], ['2001:db8:1:abcd::1234', '20010db80001'], ['bad', 'unknown'],
    ])('keeps the client key hash for %s', (ip, network) => {
        const ua = 'fixture-agent/1', expected = createHash('sha256').update(network + '|' + ua).digest('hex').slice(0, 16);
        expect(clientKey(ip!, ua)).toBe(expected);
        const sha256 = vi.fn(nodeCrypto.sha256);
        expect(clientKey(ip!, ua, { ...nodeCrypto, sha256 })).toBe(expected);
        expect(sha256).toHaveBeenCalledExactlyOnceWith(network + '|' + ua);
    });
    it('keeps fakeData SHA-256 slicing and delay byte-for-byte', () => {
        const seed = 'fixture-seed-é中😀', hash = createHash('sha256').update(seed).digest('hex');
        const expected = { site: `project-${hash.slice(0, 8)}.invalid`, database: `app_${hash.slice(8, 14)}`, region: `zone-${hash.slice(14, 16)}`, revision: hash.slice(16, 24), loginDelay: 300 + parseInt(hash.slice(24, 28), 16) % 301 };
        expect(fakeData(seed)).toEqual(expected);
        expect(formatFakeData(hash)).toEqual(expected);
        const sha256 = vi.fn(nodeCrypto.sha256);
        expect(fakeData(seed, { ...nodeCrypto, sha256 })).toEqual(expected);
        expect(sha256).toHaveBeenCalledExactlyOnceWith(seed);
    });
    it('keeps callback IDs, digests and verification stable across Node and shared implementations', () => {
        const c = config(); c.canary = { ...c.canary, secret, callback: { baseUrl: 'https://callbacks.operator.example/base///' } };
        const id = base32(mac(`callback:id|${c.env}|D1`)).slice(0, 12), digest = base32(mac(`callback:v1|${c.env}|${id}`)).slice(0, 20);
        const path = `/ag/cb/AGCB-CANARY-${id}-${digest}`, expected = 'https://callbacks.operator.example/base' + path;
        for (const callbacks of [new CallbackCanaries(c), new CallbackCanaries(c, nodeCrypto), new CoreCallbacks(c, nodeCrypto)]) {
            expect(callbacks.url('D1')).toBe(expected);
            expect(callbacks.verify(path)).toEqual({ id, placement: 'D1:callback' });
            expect(callbacks.verify(path.slice(0, -1) + flip(path.at(-1)!))).toBeUndefined();
        }
    });
    it('indexes registry tokens by the original SHA-256 hex fingerprint', () => {
        const token = 'legacy-fixture-é', expected = createHash('sha256').update(token).digest('hex');
        const entry = { token, id: 'fixture', env: 'test', placement: 'fixture', createdAt: '2026-01-01T00:00:00Z' };
        const sha256 = vi.fn(nodeCrypto.sha256), registry = new Registry({ version: 1, prefix: 'AG-CANARY-', canaries: [entry] }, secret, 'AG-CANARY-', { ...nodeCrypto, sha256 });
        const tokens = (registry as unknown as { tokens: Map<string, unknown> }).tokens;
        expect([...tokens.keys()]).toEqual([expected]);
        expect(registry.find(token)).toEqual(entry);
        expect(sha256).toHaveBeenCalledTimes(2);
        expect(sha256).toHaveBeenLastCalledWith(token);
        expect(hex(nodeCrypto.sha256(token))).toBe(expected);
    });
    it('still authenticates exact registry matches after a fingerprint collision', () => {
        const entry = { token: 'legacy-a', id: 'fixture', env: 'test', placement: 'fixture', createdAt: 'now' };
        const secretEqual = vi.fn(nodeCrypto.secretEqual), provider = { ...nodeCrypto, sha256: () => new Uint8Array(32), secretEqual };
        const registry = new Registry({ version: 1, prefix: 'AG-CANARY-', canaries: [entry] }, secret, 'AG-CANARY-', provider);
        expect(registry.find('legacy-b')).toBeUndefined();
        expect(registry.find('legacy-a')).toEqual(entry);
        expect(secretEqual).toHaveBeenCalledTimes(2);
    });
    it('keeps Crockford encoding and synchronous ULID generation with injected randomness', () => {
        vi.useFakeTimers(); vi.setSystemTime(1700000000000);
        for (const [bytes, encoded] of [[[], ''], [[0], '00'], [[255], 'ZW'], [[255, 255], 'ZZZG'], [[0, 1], '000G']] as const)
            expect(base32(Uint8Array.from(bytes))).toBe(encoded);
        const bytes = Uint8Array.from({ length: 10 }, (_, i) => i), randomBytes = vi.fn(() => bytes), provider = { ...nodeCrypto, randomBytes };
        const expected = '01HF7YAT00' + base32(bytes);
        expect(ulid(provider)).toBe(expected);
        expect(coreUlid(provider)).toBe(expected);
        expect(randomBytes).toHaveBeenCalledTimes(2);
        expect(randomBytes).toHaveBeenLastCalledWith(10);
    });
    it('does no crypto work for structurally invalid authentication inputs', () => {
        const hmacSha256 = vi.fn(nodeCrypto.hmacSha256), secretEqual = vi.fn(nodeCrypto.secretEqual), provider = { ...nodeCrypto, hmacSha256, secretEqual };
        expect(verifyCanary('invalid', { secret }, provider)).toEqual({ valid: false });
        expect(verifyMazeNode('invalid', secret, provider)).toBeUndefined();
        expect(verifyWebhookSignature({ body: '{}', timestamp, signature: 'invalid', secret }, provider)).toBe(false);
        expect(hmacSha256).not.toHaveBeenCalled(); expect(secretEqual).not.toHaveBeenCalled();
    });
    it('preserves incident IDs and sequence fields when the random provider is injected', () => {
        vi.useFakeTimers(); vi.setSystemTime(1700000000000);
        const bytes = Uint8Array.from({ length: 10 }, (_, i) => i), provider = { ...nodeCrypto, randomBytes: () => bytes };
        for (const incidents of [new Incidents(60_000, Date.now, 10, provider), new CoreIncidents(provider, 60_000, Date.now, 10)]) {
            expect(incidents.observe('fixture', 'D1')).toBeUndefined();
            expect(incidents.observe('fixture', 'D2')).toEqual({ id: '01HF7YAT00' + base32(bytes) + '-1', sequence: ['D1', 'D2'], first_seen: '2023-11-14T22:13:20.000Z', last_seen: '2023-11-14T22:13:20.000Z', confidence: 'medium' });
        }
    });
    it('adds no HMAC or random work to ordinary inspection and retains the client-key memo', async () => {
        const guard = createAgentGuard(config());
        const hmac = vi.spyOn(nodeCrypto, 'hmacSha256'), hash = vi.spyOn(nodeCrypto, 'sha256'), random = vi.spyOn(nodeCrypto, 'randomBytes');
        try {
            const req = request('/', { headers: { 'user-agent': 'Mozilla/5.0' } });
            expect(await guard.inspect(req)).toEqual({ action: 'pass', events: [] });
            expect(hash).toHaveBeenCalledTimes(1);
            expect(await guard.inspect(req)).toEqual({ action: 'pass', events: [] });
            expect(hash).toHaveBeenCalledTimes(1);
            expect(hmac).not.toHaveBeenCalled(); expect(random).not.toHaveBeenCalled();
        } finally { await guard.close(); }
    });
});
