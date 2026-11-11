import type { CryptoProvider } from '../crypto/types.js';
import { alphabet, base32 } from './ulid-core.js';
import { patterns } from './signals.js';

export const mazeRoot = '0'.repeat(20);
export function mazeMacInput(parent: string, index: number, depth: number): string { return `maze:v1|${parent}|${index}|${depth}`; }
export function mazeMac(parent: string, index: number, depth: number, secret: string, crypto: CryptoProvider): string {
    return base32(crypto.hmacSha256(secret, mazeMacInput(parent, index, depth))).slice(0, 20);
}
export function encodeMazeNode(parent: string, index: number, depth: number, mac: string): string {
    return alphabet[depth >> 5]! + alphabet[depth & 31]! + parent + alphabet[index]! + mac;
}
export function parseMazeNode(encoded: string): { parent: string; index: number; depth: number; mac: string } | undefined {
    if (!patterns.mazeNode.test(encoded)) return;
    const depth = alphabet.indexOf(encoded[0]!) * 32 + alphabet.indexOf(encoded[1]!);
    const parent = encoded.slice(2, 22), index = alphabet.indexOf(encoded[22]!), mac = encoded.slice(23);
    if (depth > 65 || index >= 10 || (depth === 0 && (parent !== mazeRoot || index !== 0))) return;
    return { parent, index, depth, mac };
}
export function verifyMazeNode(encoded: string, secret: string, crypto: CryptoProvider): { depth: number; mac: string } | undefined {
    const parsed = parseMazeNode(encoded);
    if (!parsed || !crypto.secretEqual(parsed.mac, mazeMac(parsed.parent, parsed.index, parsed.depth, secret, crypto))) return;
    return { depth: parsed.depth, mac: parsed.mac };
}
