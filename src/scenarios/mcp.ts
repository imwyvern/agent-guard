import type { AGDecision, AGRequest, AgentGuard } from '../types.js';

/** Data descriptions only: no model instructions, links or invisible characters. */
export const mcpDecoyTools = Object.freeze([
    Object.freeze({
        name: 'export_customer_records',
        description: 'Customer record export metadata for the internal administration service.',
        inputSchema: Object.freeze({ type: 'object' as const, properties: Object.freeze({}), additionalProperties: false }),
    }),
]);

/** Conservative lint for built-in English descriptions; human review is still required. */
export function lintMcpDecoyDescription(description: string): string[] {
    const errors: string[] = [];
    if (/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/u.test(description)) errors.push('hidden character');
    if (/\/\/|\bwww\.|\b(?:https?|mailto|data):|\b[a-z0-9-]{1,63}\.[a-z]{2,63}\b/i.test(description)) errors.push('URL');
    if (/\b(?:ignore|disregard|override|follow|obey|execute|invoke|call|send|visit|navigate|reveal|return|read|use|must|should|please|do not)\b/i.test(description)) errors.push('imperative language');
    if (!description.trim()) errors.push('empty description');
    return errors;
}

/** Call once per MCP request, after bounded parsing. Tool arguments stay in req.body
 * for normal canary inspection; only a built-in decoy name generates decoy_hit.
 * A crawler_bypass decision must become the host's native 404, including tools/list. */
export function inspectMcpRequest(guard: AgentGuard, req: AGRequest, toolName?: string): Promise<AGDecision> {
    return guard.inspect(req, { mcp: { toolName } });
}
