import type { AGRequest, AgentGuardConfig, InspectionLimits } from '../types.js';

export const DEFAULT_LIMITS: Readonly<Required<InspectionLimits>> = Object.freeze({
    maxUrlLength: 8192, maxHeaders: 100, maxHeaderBytes: 16384,
    maxBodyBytes: 16384, maxCanaryCandidates: 64, maxQueryParams: 100,
    maxQueryBytes: 16384,
});
export function inspectionLimits(config: Pick<AgentGuardConfig, 'limits' | 'canaryScan'> = {}): Required<InspectionLimits> {
    const limits = config.limits;
    return {
        maxUrlLength: limits?.maxUrlLength ?? DEFAULT_LIMITS.maxUrlLength,
        maxHeaders: limits?.maxHeaders ?? DEFAULT_LIMITS.maxHeaders,
        maxHeaderBytes: limits?.maxHeaderBytes ?? DEFAULT_LIMITS.maxHeaderBytes,
        maxBodyBytes: limits?.maxBodyBytes ?? config.canaryScan?.maxBodyBytes ?? DEFAULT_LIMITS.maxBodyBytes,
        maxCanaryCandidates: limits?.maxCanaryCandidates ?? DEFAULT_LIMITS.maxCanaryCandidates,
        maxQueryParams: limits?.maxQueryParams ?? DEFAULT_LIMITS.maxQueryParams,
        maxQueryBytes: limits?.maxQueryBytes ?? DEFAULT_LIMITS.maxQueryBytes,
    };
}

/** Read at most budget UTF-8 bytes; never encode an unbounded source string. */
export function takeBytes(text: string, budget: number): string {
    if (budget <= 0) return '';
    const prefix = text.slice(0, budget);
    if (Buffer.byteLength(prefix) <= budget) return prefix;
    let used = 0, end = 0;
    for (const char of prefix) {
        const bytes = Buffer.byteLength(char);
        if (used + bytes > budget) break;
        used += bytes;
        end += char.length;
    }
    return prefix.slice(0, end);
}

/** Bound both entry visits and bytes, including array elements and field names. */
export function boundedFields(input: Record<string, unknown>, count: number, bytes: number, lower = false): Record<string, string | string[]> {
    const result = Object.create(null) as Record<string, string | string[]>;
    let visited = 0, valuesVisited = 0;
    for (const key in input) {
        if (visited++ >= count || bytes <= 0) break;
        if (!Object.hasOwn(input, key)) continue;
        const name = takeBytes(key, bytes);
        bytes -= Buffer.byteLength(name);
        if (name.length !== key.length) break;
        const raw = input[key], values: string[] = [];
        for (let i = 0; i < (Array.isArray(raw) ? raw.length : 1) && bytes > 0 && i < count; i++) {
            if (valuesVisited++ >= count) break;
            // Charge empty array elements too, so work remains bounded.
            const value: unknown = Array.isArray(raw) ? raw[i] : raw;
            if (typeof value !== 'string') continue;
            const text = takeBytes(value, Math.max(0, bytes - 1));
            bytes -= Buffer.byteLength(text) + 1;
            // Never authenticate a truncated allowlist/header credential.
            if (text.length === value.length) values.push(text);
        }
        if (values.length) result[lower ? name.toLowerCase() : name] = Array.isArray(raw) ? values : values[0]!;
    }
    return result;
}
export function boundRequest(input: AGRequest, limits: Required<InspectionLimits>): AGRequest {
    return {
        method: input.method.slice(0, 32).toUpperCase(), path: input.path.slice(0, limits.maxUrlLength),
        headers: boundedFields(input.headers, limits.maxHeaders, limits.maxHeaderBytes, true),
        query: boundedFields(input.query, limits.maxQueryParams, limits.maxQueryBytes),
        ip: input.ip.slice(0, 128), body: input.body,
    };
}
