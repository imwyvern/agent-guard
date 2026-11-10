import type { AGResponse } from '../types.js';
import { decoyHeaders } from './headers.js';
export function adminResponse(authorization: string, openapiPath: string): AGResponse {
    return { status: /^Bearer\s+/i.test(authorization) ? 403 : 401, headers: decoyHeaders('application/json'), body: JSON.stringify(/^Bearer\s+/i.test(authorization) ? { error: 'token expired' } : { error: 'missing internal token', hint: `see ${openapiPath}` }) };
}
