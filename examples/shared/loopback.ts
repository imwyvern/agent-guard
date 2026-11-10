/** Offline HTTP transport used only when the managed sandbox forbids local sockets.
 * Runs the actual Server request listener and ServerResponse framing over a Duplex.
 * Production middleware never imports this module.
 */
import { IncomingMessage, ServerResponse, type Server } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
let nextPort = 60000;
const virtualServers = new Map<number, Server>();
export let socketFallback = false;
const originalFetch = globalThis.fetch;
class MemorySocket extends Duplex {
    chunks: Buffer[] = [];
    override _read(): void { }
    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { this.chunks.push(Buffer.from(chunk)); callback(); }
}
export async function memoryFetch(server: Server, url: URL, init?: RequestInit, input?: Request): Promise<Response> {
    const socket = new MemorySocket();
    Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
    const req = new IncomingMessage(socket as unknown as Socket);
    req.url = url.pathname + url.search;
    req.method = init?.method ?? input?.method ?? 'GET';
    const headers = new Headers(init?.headers ?? input?.headers);
    headers.set('host', url.host);
    req.headers = Object.fromEntries(headers.entries());
    const body = init?.body !== undefined ? String(init.body) : input ? await input.text() : '';
    if (body) {
        req.headers['content-length'] = String(Buffer.byteLength(body));
    }
    req.complete = true;
    const res = new ServerResponse(req);
    res.assignSocket(socket as unknown as Socket);
    const result = new Promise<Response>((resolve, reject) => {
        const abort = (): void => { socket.destroy(); req.destroy(); reject(new DOMException('Aborted', 'AbortError')); };
        const signal = init?.signal ?? input?.signal;
        if (signal?.aborted) {
            abort();
            return;
        }
        signal?.addEventListener('abort', abort, { once: true });
        res.once('finish', () => {
            signal?.removeEventListener('abort', abort);
            const raw = Buffer.concat(socket.chunks), split = raw.indexOf('\r\n\r\n'), head = raw.subarray(0, split).toString(), lines = head.split('\r\n');
            const status = Number(lines.shift()!.split(' ')[1]), responseHeaders = new Headers();
            for (const line of lines) {
                const colon = line.indexOf(':');
                responseHeaders.append(line.slice(0, colon), line.slice(colon + 1).trim());
            }
            let responseBody = raw.subarray(split + 4);
            if (responseHeaders.get('transfer-encoding') === 'chunked') {
                const chunks: Buffer[] = [];
                while (responseBody.length) {
                    const end = responseBody.indexOf('\r\n'), size = parseInt(responseBody.subarray(0, end).toString(), 16);
                    if (!size)
                        break;
                    chunks.push(responseBody.subarray(end + 2, end + 2 + size));
                    responseBody = responseBody.subarray(end + 2 + size + 2);
                }
                responseBody = Buffer.concat(chunks);
                responseHeaders.delete('transfer-encoding');
            }
            const empty = req.method === 'HEAD' || [204, 205, 304].includes(status);
            resolve(new Response(empty ? null : new Uint8Array(responseBody), { status, headers: responseHeaders }));
            socket.destroy();
        });
        res.once('error', reject);
        server.emit('request', req, res);
        req.push(body ? Buffer.from(body) : null);
        if (body)
            req.push(null);
    });
    return result;
}
// Intercept only our registered virtual loopback endpoints; real loopback still uses fetch.
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const server = url.hostname === '127.0.0.1' ? virtualServers.get(Number(url.port)) : undefined;
    return server ? memoryFetch(server, url, init, input instanceof Request ? input : undefined) : originalFetch(input, init);
}) as typeof fetch;
export async function listenLocal(server: Server, port = 0): Promise<{
    url: string;
    close(): Promise<void>;
    virtual: boolean;
}> {
    try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('missing server address');
        return { url: `http://127.0.0.1:${address.port}`, virtual: false, async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } };
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM')
            throw error;
        socketFallback = true;
        const virtualPort = nextPort++;
        virtualServers.set(virtualPort, server);
        return { url: `http://127.0.0.1:${virtualPort}`, virtual: true, async close() { virtualServers.delete(virtualPort); } };
    }
}
