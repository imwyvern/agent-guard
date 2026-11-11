import type { AGRequest, AgentGuardConfig } from '../types.js';
import { inspectionLimits, takeBytes } from '../core/limits.js';
import { utf8ByteLength } from '../crypto/bytes.js';
import { matchesPath } from './scan.js';
import type { WebDecoys } from './decoys.js';

export async function webRequest(request: Request, config: AgentGuardConfig, decoys: WebDecoys): Promise<AGRequest> {
    const limits = inspectionLimits(config), url = new URL(request.url);
    const headers = Object.create(null) as AGRequest['headers'], query = Object.create(null) as AGRequest['query'];
    let count = 0, remainingBytes = limits.maxHeaderBytes;
    for (const [name, value] of request.headers) {
        if (count++ >= limits.maxHeaders || remainingBytes <= 0) break;
        const field = takeBytes(name, remainingBytes);
        remainingBytes -= utf8ByteLength(field);
        if (field.length !== name.length) break;
        const text = takeBytes(value, Math.max(0, remainingBytes - 1));
        remainingBytes -= utf8ByteLength(text) + 1;
        if (text.length === value.length) headers[name.toLowerCase()] = text;
    }
    count = 0; remainingBytes = limits.maxQueryBytes;
    if ((url.pathname + url.search).length <= limits.maxUrlLength) for (const [name, value] of url.searchParams) {
        if (count++ >= limits.maxQueryParams || remainingBytes <= 0) break;
        const field = takeBytes(name, remainingBytes);
        remainingBytes -= utf8ByteLength(field);
        if (field.length !== name.length) break;
        const text = takeBytes(value, Math.max(0, remainingBytes - 1));
        remainingBytes -= utf8ByteLength(text) + 1;
        if (text.length !== value.length) continue;
        const previous = query[name];
        if (previous === undefined) query[name] = text;
        else if (Array.isArray(previous)) previous.push(text);
        else query[name] = [previous, text];
    }
    const path = url.pathname + url.search;
    const req: AGRequest = { method: request.method, path, query, headers, ip: config.clientIp ? 'unknown' : configIp(request, config) };
    const scanBody = decoys.match(url.pathname, request.method) === 'D5' || (config.canaryScan?.bodyPaths ?? ['/login', '/api/auth/*']).some(p => matchesPath(url.pathname, p));
    if (path.length <= limits.maxUrlLength && scanBody && limits.maxBodyBytes > 0 && limits.maxCanaryCandidates > 0 && request.body) {
        const reader = request.clone().body!.getReader(), decoder = new TextDecoder();
        let remaining = limits.maxBodyBytes, body = '';
        try {
            while (remaining > 0) {
                const chunk = await reader.read();
                if (chunk.done) break;
                const part = chunk.value.subarray(0, remaining);
                body += decoder.decode(part, { stream: true });
                remaining -= part.length;
            }
            req.body = body + decoder.decode();
        }
        finally { void reader.cancel().catch(() => {}); }
    }
    return req;
}
function configIp(request: Request, config: AgentGuardConfig & { ipHeader?: string }): string {
    return config.ipHeader ? request.headers.get(config.ipHeader) ?? 'unknown' : 'unknown';
}
