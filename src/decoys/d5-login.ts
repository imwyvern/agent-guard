import type { AGResponse } from '../types.js';
import { decoyHeaders } from './headers.js';
export async function loginResponse(method: string, delay: number): Promise<AGResponse> {
    if (method !== 'POST')
        return { status: 405, headers: { ...decoyHeaders('application/json'), Allow: 'POST' }, body: JSON.stringify({ error: 'method not allowed' }) };
    await new Promise(resolve => setTimeout(resolve, delay));
    return { status: 401, headers: decoyHeaders('application/json'), body: JSON.stringify({ error: 'invalid credentials' }) };
}
