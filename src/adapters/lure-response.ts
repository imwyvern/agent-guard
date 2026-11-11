import type { AgentGuard, AgentGuardConfig } from '../types.js';
import { appendRobots } from '../lures/robots.js';

/** Framework response hooks only transform bounded, already buffered bodies. */
export function lureResponse(guard: AgentGuard, config: AgentGuardConfig | undefined, method: string, path: string, status: number, type: unknown, encoding: unknown, payload: unknown): string | undefined {
    if (method === 'HEAD' || status !== 200 || encoding || !(typeof payload === 'string' || Buffer.isBuffer(payload))) return;
    if (Buffer.byteLength(payload) > 1024 * 1024) return;
    const robots = path === '/robots.txt' && config?.lures?.robots === 'append';
    const llms = path === '/llms.txt' && config?.lures?.llmsTxt;
    const comment = String(type).includes('text/html') ? guard.htmlCommentFor(path) : null;
    if (!robots && !llms && !comment) return;
    let body = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
    if (robots) body = appendRobots(body, guard.robotsLines());
    if (llms) {
        const target = config?.decoys?.paths?.D4;
        body += '\nInternal API reference: ' + ((Array.isArray(target) ? target[0] : target) ?? (config?.decoys?.basePath ?? '/api/internal') + '/openapi.json') + '\n';
    }
    if (comment) body += comment;
    return body;
}
