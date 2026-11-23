import type { AGRequest, AgentGuardEvent } from '../types.js';
import type { WebBotAuthVerifier } from './web-bot-auth.js';

/** Only called by enabled guards, after taking the bounded request snapshot. */
export async function inspectWebBotAuth(verifier: WebBotAuthVerifier, req: AGRequest, source: Pick<AGRequest, 'method' | 'path' | 'url'>): Promise<AgentGuardEvent['web_bot_auth']> {
    try {
        // Direct AGRequest callers can provide url to cover scheme/target/query.
        // Without it, only the origin-form target and Host are available (HTTP).
        const host = req.headers.host;
        const target = source.url ?? (typeof host === 'string' && source.path.startsWith('/') && !source.path.startsWith('//') ? 'http://' + host + source.path : '');
        if (target) {
            const parsed = new URL(target);
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash)
                return { verified: false, trusted: false, reason: 'invalid_components' };
        }
        const result = await verifier.verify({ method: source.method, headers: req.headers, url: target });
        if (!result.verified && (result.reason === 'unsigned' || result.reason === 'disabled')) return;
        return { verified: result.verified, trusted: result.trusted,
            ...('agent_url' in result ? { agent_url: result.agent_url } : {}),
            ...('keyid' in result ? { keyid: result.keyid } : {}),
            ...(!result.verified ? { reason: result.reason } : {}) };
    } catch { return { verified: false, trusted: false, reason: 'malformed' }; }
}
