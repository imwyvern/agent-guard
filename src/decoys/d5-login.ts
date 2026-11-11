import type { AGResponse } from '../types.js';
import { decoyHeaders } from './headers.js';
/** Shared by runtime and offline placement lint; no delay or request side effects. */
export function loginErrorResponse(method: string): AGResponse {
    if (method !== 'POST')
        return { status: 405, headers: { ...decoyHeaders('application/json'), Allow: 'POST' }, body: JSON.stringify({ error: 'method not allowed' }) };
    return { status: 401, headers: decoyHeaders('application/json'), body: JSON.stringify({ error: 'invalid credentials' }) };
}
export async function loginResponse(method: string, delay: number): Promise<AGResponse> {
    if (method === 'POST') await new Promise(resolve => setTimeout(resolve, delay));
    return loginErrorResponse(method);
}
