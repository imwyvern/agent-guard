import { it, expect, vi } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import { createAgentGuard, smtpAdapter } from '../../src/index.js';
import type { AgentGuardEvent, AlertPayload } from '../../src/index.js';
import { config, event, request } from '../helpers.js';
import { certificate, privateKey } from './smtp-tls-fixture.js';

interface ServerOptions {
    auth?: 'PLAIN' | 'LOGIN' | 'both';
    challengePlain?: boolean;
    rejectAuth?: boolean;
    hang?: boolean;
    hangData?: boolean;
    implicitTls?: boolean;
    startTls?: boolean;
    fragment?: boolean;
    badReply?: string;
    rejectRecipient?: boolean;
}

async function smtpServer(options: ServerOptions = {}) {
    const sockets = new Set<net.Socket>();
    const commands: string[] = [], deliveries: Array<{ from: string; to: string[]; message: string }> = [];
    const authentications: Array<{ method: string; valid: boolean; encrypted: boolean }> = [];
    let connections = 0;
    const attach = (initial: net.Socket, encrypted = false): void => {
        let socket = initial, buffer = '', data = false, from = '', to: string[] = [];
        let auth: 'plain' | 'user' | 'password' | undefined, validUser = false;
        sockets.add(socket);
        socket.on('error', () => { });
        socket.once('close', () => sockets.delete(initial));
        const write = (text: string): void => {
            if (options.fragment && text.length > 4) {
                socket.write(text.slice(0, 3));
                setImmediate(() => { if (!socket.destroyed) socket.write(text.slice(3)); });
            }
            else socket.write(text);
        };
        const authenticate = (method: string, valid: boolean): void => {
            authentications.push({ method, valid, encrypted });
            write(options.rejectAuth ? '535 authentication failed\r\n' : '235 authenticated\r\n');
        };
        const receive = (chunk: Buffer): void => {
            buffer += chunk.toString();
            while (buffer.includes('\r\n')) {
                if (data) {
                    const end = buffer.indexOf('\r\n.\r\n');
                    if (end === -1) return;
                    deliveries.push({ from, to: [...to], message: buffer.slice(0, end).replace(/^\.\./gm, '.') });
                    buffer = buffer.slice(end + 5);
                    data = false;
                    if (!options.hangData) write('250 queued\r\n');
                    continue;
                }
                const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (auth) {
                    const decoded = Buffer.from(line, 'base64').toString();
                    if (auth === 'plain') { auth = undefined; authenticate('PLAIN', decoded === '\0fixture-user\0fixture-password'); }
                    else if (auth === 'user') { validUser = decoded === 'fixture-user'; auth = 'password'; write('334 UGFzc3dvcmQ6\r\n'); }
                    else { auth = undefined; authenticate('LOGIN', validUser && decoded === 'fixture-password'); }
                    continue;
                }
                if (line.startsWith('AUTH PLAIN')) {
                    commands.push('AUTH PLAIN');
                    if (options.challengePlain) { auth = 'plain'; write('334 continue\r\n'); }
                    else authenticate('PLAIN', Buffer.from(line.slice(11), 'base64').toString() === '\0fixture-user\0fixture-password');
                }
                else if (line === 'AUTH LOGIN') { commands.push(line); auth = 'user'; write('334 VXNlcm5hbWU6\r\n'); }
                else {
                    commands.push(line);
                    if (line.startsWith('EHLO ')) {
                        const capabilities = ['loopback'];
                        if (options.startTls && !encrypted) capabilities.push('STARTTLS');
                        else if (options.auth) capabilities.push('AUTH ' + (options.auth === 'both' ? 'LOGIN PLAIN' : options.auth));
                        capabilities.push('SIZE 65536');
                        write(capabilities.map((value, i) => '250' + (i === capabilities.length - 1 ? ' ' : '-') + value + '\r\n').join(''));
                    }
                    else if (line === 'STARTTLS' && options.startTls && !encrypted) {
                        socket.write('220 begin TLS\r\n');
                        socket.off('data', receive);
                        socket = new tls.TLSSocket(socket, { isServer: true, secureContext: tls.createSecureContext({ key: privateKey, cert: certificate }) });
                        sockets.add(socket);
                        const upgraded = socket;
                        socket.once('close', () => sockets.delete(upgraded));
                        socket.on('error', () => { });
                        socket.on('data', receive);
                        encrypted = true;
                    }
                    else if (line.startsWith('MAIL FROM:')) { from = line.slice(10); to = []; write('250 sender ok\r\n'); }
                    else if (line.startsWith('RCPT TO:')) { to.push(line.slice(8)); write(options.rejectRecipient ? '550 recipient rejected\r\n' : '250 recipient ok\r\n'); }
                    else if (line === 'DATA') { data = true; write('354 send message\r\n'); }
                    else if (line === 'QUIT') { socket.end('221 goodbye\r\n'); }
                    else write('500 unsupported command\r\n');
                }
            }
        };
        socket.on('data', receive);
        if (options.badReply) write(options.badReply);
        else if (!options.hang) write('220 loopback SMTP\r\n');
    };
    const connected = (socket: net.Socket): void => { connections++; attach(socket, options.implicitTls); };
    const server = options.implicitTls ? tls.createServer({ key: privateKey, cert: certificate }, connected) : net.createServer(connected);
    server.on('tlsClientError', () => { });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing loopback port');
    return {
        port: address.port, commands, deliveries, authentications, connections: () => connections,
        async close() {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        },
    };
}

const envelope = { host: '127.0.0.1', from: 'guard@example.invalid', to: ['one@example.invalid', 'two@example.invalid'], allowInsecureLocal: true };
const credentials = { username: 'fixture-user', password: 'fixture-password' };
const payload = (): AlertPayload => ({ event: event(), summary: { deduped: 0, rate_limited: 0 } });

function decodeMessage(message: string): { headers: string; text: string } {
    const end = message.indexOf('\r\n\r\n');
    return { headers: message.slice(0, end), text: Buffer.from(message.slice(end + 4), 'base64').toString('utf8') };
}

function trustLoopbackCertificate(): void {
    const connect = tls.connect;
    vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions) => connect({ ...options, ca: certificate })) as typeof tls.connect);
}

it.each(['PLAIN', 'LOGIN', 'both'] as const)('SMTP delivers one message to all recipients using advertised AUTH %s', async auth => {
    const r = await smtpServer({ auth, fragment: true });
    try {
        const adapter = smtpAdapter({ ...envelope, ...credentials, port: r.port });
        expect(adapter.name).toBe('smtp');
        expect(await adapter.send(payload(), new AbortController().signal)).toEqual({ ok: true });
        expect(r.deliveries).toHaveLength(1);
        expect(r.deliveries[0]).toMatchObject({ from: '<guard@example.invalid>', to: ['<one@example.invalid>', '<two@example.invalid>'] });
        const { headers, text } = decodeMessage(r.deliveries[0]!.message);
        expect(headers).toContain('Date: ');
        expect(headers).toContain('From: guard@example.invalid');
        expect(headers).toContain('To: one@example.invalid,\r\n two@example.invalid');
        expect(headers).toContain('Subject: [agent-guard] high decoy_hit');
        expect(headers).toContain('Content-Type: text/plain; charset=utf-8');
        for (const expected of ['decoy_hit', 'high', 'D1', '/.env', 'client_key: key']) expect(text).toContain(expected);
        expect(r.authentications).toEqual([{ method: auth === 'LOGIN' ? 'LOGIN' : 'PLAIN', valid: true, encrypted: false }]);
        expect(r.commands.at(-1)).toBe('QUIT');
    }
    finally { await r.close(); }
});

it('SMTP supports a single recipient and a PLAIN continuation challenge', async () => {
    const r = await smtpServer({ auth: 'PLAIN', challengePlain: true });
    try {
        const adapter = smtpAdapter({ ...envelope, ...credentials, to: 'one@example.invalid', port: r.port });
        expect(await adapter.send(payload(), new AbortController().signal)).toEqual({ ok: true });
        expect(r.authentications[0]?.valid).toBe(true);
        expect(r.deliveries[0]?.to).toEqual(['<one@example.invalid>']);
    }
    finally { await r.close(); }
});

it('SMTP omits raw body, cookies, authorization, query values and full canary tokens', async () => {
    const r = await smtpServer();
    const source = event({ canary: { id: 'canary-id', placement: 'D1', env: 'test', found_in: 'body', field: 'password' } });
    Object.assign(source, { body: 'private-body', headers: { Cookie: 'private-cookie', Authorization: 'private-authorization' } });
    Object.assign(source.req, { body: 'private-body', cookie: 'private-cookie', authorization: 'private-authorization' });
    Object.assign(source.canary!, { token: 'private-canary-token' });
    source.req.path = '/.env?credential=private-query';
    source.req.client_key = 'key\r\nInjected: value';
    try {
        expect(await smtpAdapter({ ...envelope, port: r.port }).send({ ...payload(), event: source }, new AbortController().signal)).toEqual({ ok: true });
        const { headers, text } = decodeMessage(r.deliveries[0]!.message);
        expect(text).toContain('canary: canary-id');
        expect(text).toContain('path: /.env\n');
        expect(text).toContain('client_key: keyInjected: value');
        expect(text.toLowerCase()).not.toMatch(/private-|cookie|authorization/);
        expect(headers).not.toContain('Injected:');
    }
    finally { await r.close(); }
});

it.each(['implicit', 'STARTTLS'] as const)('SMTP uses %s with certificate verification and authenticates after TLS', async transport => {
    trustLoopbackCertificate();
    const r = await smtpServer({ implicitTls: transport === 'implicit', startTls: transport === 'STARTTLS', auth: 'both' });
    try {
        const adapter = smtpAdapter({ ...envelope, ...credentials, allowInsecureLocal: false, port: r.port, secure: transport === 'implicit', startTls: transport === 'STARTTLS' });
        expect(await adapter.send(payload(), new AbortController().signal)).toEqual({ ok: true });
        expect(r.authentications).toEqual([{ method: 'PLAIN', valid: true, encrypted: true }]);
        expect(r.commands.filter(command => command.startsWith('EHLO'))).toHaveLength(transport === 'implicit' ? 1 : 2);
        if (transport === 'STARTTLS') expect(r.commands.indexOf('STARTTLS')).toBeLessThan(r.commands.indexOf('AUTH PLAIN'));
        expect(r.deliveries).toHaveLength(1);
    }
    finally { await r.close(); }
});

it('SMTP rejects an untrusted TLS certificate before credentials or message data are sent', async () => {
    const r = await smtpServer({ implicitTls: true, auth: 'PLAIN' });
    try {
        const adapter = smtpAdapter({ ...envelope, ...credentials, port: r.port, secure: true });
        expect(await adapter.send(payload(), new AbortController().signal)).toEqual({ ok: false });
        expect(r.authentications).toHaveLength(0);
        expect(r.deliveries).toHaveLength(0);
    }
    finally { await r.close(); }
});

it.each([465, 587])('SMTP automatically selects TLS on port %s', async port => {
    const r = await smtpServer({ implicitTls: port === 465, startTls: port === 587, auth: 'PLAIN' });
    const connectTls = tls.connect, connectNet = net.connect;
    vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions) => connectTls({ ...options, ...(options.socket ? {} : { port: r.port }), ca: certificate })) as typeof tls.connect);
    vi.spyOn(net, 'connect').mockImplementation(((options: net.NetConnectOpts) => connectNet({ ...options, port: r.port })) as typeof net.connect);
    try {
        expect(await smtpAdapter({ ...envelope, ...credentials, port, secure: false, startTls: false, allowInsecureLocal: false }).send(payload(), new AbortController().signal)).toEqual({ ok: true });
        expect(r.authentications).toEqual([{ method: 'PLAIN', valid: true, encrypted: true }]);
        expect(r.commands.includes('STARTTLS')).toBe(port === 587);
        expect(r.deliveries).toHaveLength(1);
    }
    finally { await r.close(); }
});

it.each([{ auth: undefined }, { auth: 'PLAIN' as const, rejectAuth: true }, { auth: 'LOGIN' as const, rejectAuth: true }])('SMTP isolates unavailable or rejected authentication', async options => {
    const r = await smtpServer(options), error = vi.spyOn(console, 'error'), log = vi.spyOn(console, 'log');
    try {
        expect(await smtpAdapter({ ...envelope, ...credentials, port: r.port }).send(payload(), new AbortController().signal)).toEqual({ ok: false });
        expect(r.deliveries).toHaveLength(0);
        expect(r.commands.some(command => command.startsWith('MAIL FROM'))).toBe(false);
        expect(error).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
    }
    finally { await r.close(); }
});

it('SMTP fails closed when required STARTTLS is unavailable', async () => {
    const r = await smtpServer({ auth: 'PLAIN' });
    try {
        expect(await smtpAdapter({ ...envelope, ...credentials, port: r.port, startTls: true }).send(payload(), new AbortController().signal)).toEqual({ ok: false });
        expect(r.authentications).toHaveLength(0);
        expect(r.deliveries).toHaveLength(0);
    }
    finally { await r.close(); }
});

it('SMTP requires TLS for remote hosts and explicit permission for insecure loopback', () => {
    expect(() => smtpAdapter({ host: '127.0.0.1', from: envelope.from, to: envelope.to, port: 25 })).toThrow('requires TLS');
    for (const host of ['mail.example.com', '127.0.0.1.example.com'])
        expect(() => smtpAdapter({ ...envelope, host, port: 25 })).toThrow('requires TLS');
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
        expect(() => smtpAdapter({ ...envelope, host, port: 25, allowInsecureLocal: false })).toThrow('requires TLS');
        expect(() => smtpAdapter({ ...envelope, host, port: 25 })).not.toThrow();
    }
    for (const options of [{ port: 465 }, { port: 587 }, { port: 25, secure: true }, { port: 25, startTls: true }])
        expect(() => smtpAdapter({ ...envelope, host: 'mail.example.com', ...options })).not.toThrow();
});

it('SMTP validates the envelope, paired credentials, port and timeout without echoing values', () => {
    const invalid = [
        { from: 'bad\r\nBcc: injected@example.invalid' }, { to: ['good@example.invalid', 'bad\n@example.invalid'] }, { to: [] },
        { from: 'bad' }, { to: 'bad' }, { port: 0 }, { port: 65536 }, { port: 1.5 }, { timeoutMs: -1 },
        { username: credentials.username }, { password: credentials.password }, { ...credentials, username: 'bad\0user' },
    ];
    for (const override of invalid) {
        let error: unknown;
        try { smtpAdapter({ ...envelope, port: 25, ...override }); }
        catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(Error);
        expect(String(error).includes(credentials.username)).toBe(false);
        expect(String(error).includes(credentials.password)).toBe(false);
    }
});

it('SMTP bounds the rendered message before connecting', async () => {
    const r = await smtpServer();
    try {
        const adapter = smtpAdapter({ ...envelope, to: Array.from({ length: 5000 }, () => 'recipient@example.invalid'), port: r.port });
        expect(await adapter.send(payload(), new AbortController().signal)).toEqual({ ok: false });
        expect(r.connections()).toBe(0);
        expect(r.deliveries).toHaveLength(0);
    }
    finally { await r.close(); }
});

it.each([{ hang: true }, { hangData: true }])('SMTP timeout and abort destroy stalled connections without hanging', async options => {
    const r = await smtpServer(options);
    try {
        expect(await smtpAdapter({ ...envelope, port: r.port, timeoutMs: 30 }).send(payload(), new AbortController().signal)).toEqual({ ok: false });
        const controller = new AbortController();
        const adapter = smtpAdapter({ ...envelope, port: r.port, timeoutMs: 5000 });
        const pending = adapter.send(payload(), controller.signal);
        setTimeout(() => controller.abort(new Error('private-abort-reason')), 20);
        expect(await pending).toEqual({ ok: false });
        const count = r.connections();
        expect(await adapter.send(payload(), controller.signal)).toEqual({ ok: false });
        expect(r.connections()).toBe(count);
    }
    finally { await r.close(); }
});

it.each([{ badReply: 'not SMTP\r\n' }, { badReply: '220 ' + 'x'.repeat(65536) }, { badReply: '220-first\r\n250 mismatch\r\n' }, { rejectRecipient: true }])('SMTP isolates malformed, oversized or rejected replies', async options => {
    const r = await smtpServer(options);
    try {
        expect(await smtpAdapter({ ...envelope, port: r.port }).send(payload(), new AbortController().signal)).toEqual({ ok: false });
        expect(r.deliveries).toHaveLength(0);
    }
    finally { await r.close(); }
});

it('SMTP integrates with inspect, Dispatcher dedupe/rate limits and close flush', async () => {
    const r = await smtpServer(), events: AgentGuardEvent[] = [];
    const g = createAgentGuard(config({ alerts: { adapters: [smtpAdapter({ ...envelope, port: r.port })], ratePerMinute: 1 }, log: { sink: e => events.push(e), level: 'debug' } }));
    try {
        await g.inspect(request('/.env'));
        await g.inspect(request('/.env'));
        await g.inspect(request('/.env', { ip: '198.51.100.1' }));
        await g.close();
        expect(r.deliveries).toHaveLength(1);
        expect(g.metrics().alerts_sent).toBe(1);
        expect(events.find(e => e.event === 'alert_sent')?.alert?.channel).toBe('smtp');
    }
    finally { await g.close(); await r.close(); }
});

it('SMTP stalled delivery leaves inspect fast and close records failure without credential leakage', async () => {
    const r = await smtpServer({ hang: true }), events: AgentGuardEvent[] = [];
    const g = createAgentGuard(config({ alerts: { adapters: [smtpAdapter({ ...envelope, ...credentials, port: r.port, timeoutMs: 60 })] }, log: { sink: e => events.push(e), level: 'debug' } }));
    try {
        const start = performance.now();
        expect((await g.inspect(request('/.env'))).action).toBe('respond');
        expect(performance.now() - start).toBeLessThan(50);
        await g.close();
        expect(g.metrics().alerts_failed).toBe(1);
        expect(events.find(e => e.event === 'alert_failed')?.alert?.channel).toBe('smtp');
        expect(JSON.stringify(events).includes(credentials.username)).toBe(false);
        expect(JSON.stringify(events).includes(credentials.password)).toBe(false);
    }
    finally { await g.close(); await r.close(); }
});
