export interface CryptoProvider {
    hmacSha256(secret: string | Uint8Array, data: string | Uint8Array): Uint8Array;
    sha256(data: string | Uint8Array): Uint8Array;
    randomBytes(n: number): Uint8Array;
    secretEqual(a: string, b: string): boolean;
}

export interface AsyncCryptoProvider {
    hmacSha256(secret: string | Uint8Array, data: string | Uint8Array): Promise<Uint8Array>;
    sha256(data: string | Uint8Array): Promise<Uint8Array>;
    randomBytes(n: number): Uint8Array;
    secretEqual(a: string, b: string): boolean;
}
