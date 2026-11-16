import { isIP } from 'node:net';
import { createAgentGuard } from '../index.js';
import { inCidr, ipNumber } from '../core/ip-parse.js';
import { createProxy, fixedUpstream } from '../proxy/server.js';
import { loadEntryConfig } from './entry-config.js';
import type { AGRequest, AgentGuard } from '../types.js';

export const PROXY_USAGE = 'agent-guard proxy --upstream <http(s)://host:port> [--listen 127.0.0.1:8080] [--allow-public-bind] [--config <file>] [--trusted-proxy <cidr>] [--timeout-ms 30000] [--init-secrets]';
export function proxyOptions(args: string[], warn: (line: string) => void = console.error): {
    upstream: string; host: string; port: number; configPath?: string; initSecrets: boolean; timeoutMs: number; trusted: string[];
} {
    const values = new Map<string, string>(), trusted: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const key = args[i];
        if (!['--upstream', '--listen', '--config', '--trusted-proxy', '--timeout-ms', '--allow-public-bind', '--init-secrets'].includes(key ?? '') || (values.has(key!) && key !== '--trusted-proxy')) throw new Error(PROXY_USAGE);
        if (key === '--allow-public-bind' || key === '--init-secrets') values.set(key, 'true');
        else {
            const value = args[++i];
            if (!value || value.startsWith('--')) throw new Error(PROXY_USAGE);
            values.set(key!, value);
            if (key === '--trusted-proxy') trusted.push(value);
        }
    }
    const upstream = values.get('--upstream');
    if (!upstream) throw new Error(PROXY_USAGE);
    fixedUpstream(upstream);
    const listen = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(values.get('--listen') ?? '127.0.0.1:8080');
    if (!listen) throw new Error(PROXY_USAGE);
    const host = listen[1] ?? listen[2]!, port = Number(listen[3]);
    if (!isIP(host) || port > 65535) throw new Error(PROXY_USAGE);
    const parsed = ipNumber(host)!;
    const loopback = parsed.bits === 32 ? parsed.value >> 24n === 127n : parsed.value === 1n;
    if (!loopback) {
        if (!values.has('--allow-public-bind')) throw new Error('proxy: public bind requires --allow-public-bind');
        warn('WARNING: proxy is listening on a non-loopback address; restrict access at your ingress.');
    }
    for (const cidr of trusted) {
        const [ip, width, extra] = cidr.split('/'), parsed = ipNumber(ip ?? '');
        if (!parsed || !width || extra !== undefined || !/^\d+$/.test(width) || Number(width) > parsed.bits) throw new Error('invalid trusted proxy CIDR');
    }
    const rawTimeout = values.get('--timeout-ms') ?? '30000', timeoutMs = Number(rawTimeout);
    if (!/^\d+$/.test(rawTimeout) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error(PROXY_USAGE);
    return { upstream, host, port, configPath: values.get('--config'), initSecrets: values.has('--init-secrets'), timeoutMs, trusted };
}
/** Walk XFF from the socket toward the client, stopping at the first untrusted hop. */
export function trustedClientIp(trusted: string[], request: AGRequest): string {
    let ip = request.ip;
    const header = request.headers['x-forwarded-for'];
    const hops = (Array.isArray(header) ? header.join(',') : header ?? '').split(',');
    for (let i = hops.length - 1; i >= 0 && trusted.some(cidr => inCidr(ip, cidr)); i--) {
        const candidate = hops[i]!.trim();
        if (!ipNumber(candidate)) break;
        ip = candidate;
    }
    return ip;
}
export async function runProxy(args: string[], out: (line: string) => void = console.log, err: (line: string) => void = console.error): Promise<number> {
    let guard: AgentGuard | undefined;
    try {
        const options = proxyOptions(args, err);
        const config = loadEntryConfig(options.configPath, options.initSecrets);
        if (options.trusted.length) config.clientIp = req => trustedClientIp(options.trusted, req);
        guard = createAgentGuard(config);
        const proxy = createProxy({ ...options, guard, config, onError: event => err(JSON.stringify(event)) });
        await new Promise<void>((resolve, reject) => {
            proxy.server.once('error', reject);
            proxy.server.listen(options.port, options.host, () => { proxy.server.off('error', reject); resolve(); });
        });
        const address = proxy.server.address();
        const local = `http://${options.host.includes(':') ? '[' + options.host + ']' : options.host}:${typeof address === 'object' && address ? address.port : options.port}`;
        out(`proxy listening at ${local}; detect / alert-only`);
        out(`curl -s '${local}/.env'`);
        out(`TOKEN=$(curl -s '${local}/.env' | sed -n 's/^ADMIN_API_TOKEN=//p'); curl -s -H "Authorization: Bearer $TOKEN" '${local}/api/internal/admin/users'`);
        let stopping = false;
        const stop = () => {
            if (stopping) return;
            stopping = true;
            process.off('SIGINT', stop); process.off('SIGTERM', stop);
            void (async () => {
                // The five-second deadline includes alert shutdown too.
                const deadline = setTimeout(() => process.exit(0), 5000);
                await proxy.close(); await guard!.close(); clearTimeout(deadline);
            })();
        };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        return 0;
    } catch {
        await guard?.close();
        err('proxy: invalid options/configuration or unable to listen\n' + PROXY_USAGE);
        return 2;
    }
}
