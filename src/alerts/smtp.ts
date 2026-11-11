import net from 'node:net';
import tls from 'node:tls';
import type { AlertAdapter, AlertPayload } from '../types.js';
import { alertText, alertTimeout, asciiAlphanumeric, isLoopback, onlyCharacters } from './shared.js';

interface SmtpConfig {
    host: string;
    port: number;
    secure?: boolean;
    username?: string;
    password?: string;
    from: string;
    to: string | string[];
    timeoutMs?: number;
    startTls?: boolean;
    allowInsecureLocal?: boolean;
}
interface Reply { code: number; lines: string[] }

class SmtpConnection {
    private buffer = '';
    private lines: string[] = [];
    private replyBytes = 0;
    private replies: Reply[] = [];
    private failure?: Error;
    private waiting?: { resolve: (reply: Reply) => void; reject: (error: Error) => void };
    constructor(private socket: net.Socket, private signal: AbortSignal) {
        this.attach();
        signal.addEventListener('abort', this.abort, { once: true });
        if (signal.aborted) this.abort();
    }
    private abort = (): void => { this.fail(); };
    private fail = (): void => {
        this.failure ??= new Error('smtp request failed');
        this.waiting?.reject(this.failure);
        this.waiting = undefined;
        this.socket.destroy();
    };
    private data = (chunk: Buffer): void => {
        this.buffer += chunk.toString('utf8');
        if (this.buffer.length + this.replyBytes > 65536) { this.fail(); return; }
        let end: number;
        while ((end = this.buffer.indexOf('\r\n')) !== -1) {
            const line = this.buffer.slice(0, end);
            this.buffer = this.buffer.slice(end + 2);
            if (line.length < 4 || !onlyCharacters(line.slice(0, 3), '0123456789') || !['-', ' '].includes(line[3]!) || (this.lines.length && line.slice(0, 3) !== this.lines[0]!.slice(0, 3))) { this.fail(); return; }
            this.lines.push(line);
            this.replyBytes += line.length + 2;
            if (line[3] === '-') continue;
            const reply = { code: Number(line.slice(0, 3)), lines: this.lines };
            this.lines = [];
            this.replyBytes = 0;
            if (this.waiting) {
                this.waiting.resolve(reply);
                this.waiting = undefined;
            }
            else {
                if (this.replies.length >= 16) { this.fail(); return; }
                this.replies.push(reply);
            }
        }
    };
    private attach(): void {
        this.socket.on('data', this.data);
        this.socket.on('error', this.fail);
        this.socket.on('close', this.fail);
    }
    private detach(): void {
        this.socket.off('data', this.data);
        this.socket.off('error', this.fail);
        this.socket.off('close', this.fail);
    }
    async expect(codes: number[]): Promise<Reply> {
        if (this.failure) throw this.failure;
        const reply = this.replies.shift() ?? await new Promise<Reply>((resolve, reject) => { this.waiting = { resolve, reject }; });
        if (!codes.includes(reply.code)) throw new Error('smtp request failed');
        return reply;
    }
    async command(command: string, codes: number[]): Promise<Reply> {
        if (this.failure) throw this.failure;
        this.socket.write(command + '\r\n');
        return this.expect(codes);
    }
    upgrade(host: string): void {
        if (this.failure || this.buffer || this.lines.length || this.replies.length)
            throw new Error('smtp request failed');
        const socket = tls.connect({ socket: this.socket, host, servername: net.isIP(host) ? undefined : host });
        this.detach();
        this.socket = socket;
        this.attach();
    }
    close(): void {
        this.signal.removeEventListener('abort', this.abort);
        this.socket.destroy();
    }
}

function mailbox(value: string): boolean {
    const at = value.indexOf('@'), local = value.slice(0, at), domain = value.slice(at + 1);
    return value.length <= 254 && at > 0 && !!domain &&
        onlyCharacters(local, asciiAlphanumeric + ".!#$%&'*+/=?^_`{|}~-") &&
        onlyCharacters(domain, asciiAlphanumeric + '.-') &&
        asciiAlphanumeric.includes(domain[0]!) && asciiAlphanumeric.includes(domain[domain.length - 1]!);
}

function message(alert: AlertPayload, from: string, to: string[]): string {
    const { subject, text } = alertText(alert);
    const encoded = Buffer.from(text).toString('base64'), lines: string[] = [];
    for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
    const body = lines.join('\r\n');
    const headers = [
        `Date: ${new Date().toUTCString()}`, `From: ${from}`, `To: ${to.join(',\r\n ')}`,
        `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64',
    ];
    const rendered = headers.join('\r\n') + '\r\n\r\n' + body + '\r\n';
    if (Buffer.byteLength(rendered) > 65536 || headers.some(header => header.split('\r\n').some(line => Buffer.byteLength(line) > 998)))
        throw new Error('smtp message is too large');
    return rendered;
}

async function authenticate(client: SmtpConnection, ehlo: Reply, username: string, password: string): Promise<void> {
    const methods = ehlo.lines.flatMap(line => {
        const capability = line.slice(4).toUpperCase();
        return capability.startsWith('AUTH ') || capability.startsWith('AUTH=') ? capability.slice(5).replaceAll('\t', ' ').split(' ').filter(Boolean) : [];
    });
    if (methods.includes('PLAIN')) {
        const auth = Buffer.from('\0' + username + '\0' + password).toString('base64');
        const reply = await client.command('AUTH PLAIN ' + auth, [235, 334]);
        if (reply.code === 334) await client.command(auth, [235]);
    }
    else if (methods.includes('LOGIN')) {
        await client.command('AUTH LOGIN', [334]);
        await client.command(Buffer.from(username).toString('base64'), [334]);
        await client.command(Buffer.from(password).toString('base64'), [235]);
    }
    else throw new Error('smtp authentication unavailable');
}

export function smtpAdapter(o: SmtpConfig): AlertAdapter {
    const { host, port, from, username, password } = o;
    const to = typeof o.to === 'string' ? [o.to] : [...o.to];
    const timeoutMs = alertTimeout(o.timeoutMs), secure = o.secure === true || port === 465;
    const startTls = !secure && (o.startTls === true || port === 587);
    if (!host || host.length > 253 || [...host].some(character => !character.trim() || character < ' ' || character === '\x7f' || '/@\\'.includes(character)) || !Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('smtp host or port is invalid');
    if (!secure && !startTls && !(isLoopback(host) && o.allowInsecureLocal === true))
        throw new Error('smtp requires TLS (or explicit insecure loopback)');
    if (!mailbox(from) || !to.length || to.some(value => !mailbox(value)))
        throw new Error('smtp requires valid sender and recipient mailboxes');
    if ((username !== undefined || password !== undefined) && (username === undefined || password === undefined || !username || username.length > 4096 || password.length > 4096 || (username + password).includes('\0')))
        throw new Error('smtp requires valid paired credentials');
    return { name: 'smtp', async send(alert, signal) {
        let client: SmtpConnection | undefined;
        try {
            const rendered = message(alert, from, to);
            const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
            if (combined.aborted) return { ok: false };
            const socket = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });
            client = new SmtpConnection(socket, combined);
            await client.expect([220]);
            let ehlo = await client.command('EHLO agent-guard', [250]);
            if (startTls) {
                if (!ehlo.lines.some(line => line.slice(4).trim().toUpperCase() === 'STARTTLS'))
                    throw new Error('smtp TLS unavailable');
                await client.command('STARTTLS', [220]);
                client.upgrade(host);
                ehlo = await client.command('EHLO agent-guard', [250]);
            }
            if (username !== undefined && password !== undefined) await authenticate(client, ehlo, username, password);
            await client.command(`MAIL FROM:<${from}>`, [250]);
            for (const recipient of to) await client.command(`RCPT TO:<${recipient}>`, [250, 251]);
            await client.command('DATA', [354]);
            await client.command(rendered + '.', [250]);
            await client.command('QUIT', [221]);
            return { ok: true };
        }
        catch { return { ok: false }; }
        finally { client?.close(); }
    } };
}
