import type { CryptoProvider, AsyncCryptoProvider } from '../crypto/types.js';
import { hex, base64 } from '../crypto/bytes.js';
import { patterns } from '../core/signals.js';

export function signWebhook(body: string, timestamp: string, secret: string, crypto: CryptoProvider): string { return 'sha256=' + hex(crypto.hmacSha256(secret, timestamp + '.' + body)); }
export function validWebhookSignature(o: { timestamp: string; signature: string; toleranceSec?: number }): boolean {
    return !(o.timestamp.length > 16 || o.signature.length !== 71 || !patterns.webhookTimestamp.test(o.timestamp) || Math.abs(Date.now() / 1000 - Number(o.timestamp)) > (o.toleranceSec ?? 300) || !patterns.webhookSignature.test(o.signature));
}
export function verifyWebhookSignature(o: { body: string; timestamp: string; signature: string; secret: string; toleranceSec?: number }, crypto: CryptoProvider): boolean {
    return validWebhookSignature(o) && crypto.secretEqual(o.signature, signWebhook(o.body, o.timestamp, o.secret, crypto));
}
export function signFeishu(timestamp: string, secret: string, crypto: CryptoProvider): string { return base64(crypto.hmacSha256(secret, timestamp + '\n' + secret)); }

export async function signWebhookAsync(body: string, timestamp: string, secret: string, crypto: AsyncCryptoProvider): Promise<string> {
    return 'sha256=' + hex(await crypto.hmacSha256(secret, timestamp + '.' + body));
}
export async function verifyWebhookSignatureAsync(o: { body: string; timestamp: string; signature: string; secret: string; toleranceSec?: number }, crypto: AsyncCryptoProvider): Promise<boolean> {
    return validWebhookSignature(o) && crypto.secretEqual(o.signature, await signWebhookAsync(o.body, o.timestamp, o.secret, crypto));
}
