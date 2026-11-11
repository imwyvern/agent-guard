import type { AGDecision, AgentGuard, AgentGuardConfig, AgentGuardEvent, Severity, UAClass } from '../types.js';
import { validateConfig, guardConfigs } from '../config.js';
import { mcpDecoyTools } from '../scenarios/mcp.js';
import { graphqlDecoys, graphqlForbiddenResponse } from '../scenarios/graphql.js';
import { decoyHeaders } from '../decoys/headers.js';
import { Registry } from '../canary/registry.js';
import { CanaryTracing } from '../canary/tracing.js';
import { Incidents } from './incidents.js';
import { Timing } from './timing.js';
import { matchesPath, scanRequest } from '../canary/scan.js';
import { Decoys } from '../decoys/index.js';
import { CrawlerVerifier } from '../crawler/verify.js';
import { claimedCrawler, classifyUA } from '../crawler/ua.js';
import { clientKey, inCidr } from './client-key.js';
import { pathSignal, weights } from './signals.js';
import { ulid } from './ulid.js';
import { Metrics } from '../metrics.js';
import { Dispatcher } from '../alerts/dispatcher.js';
import { logEvent } from '../log/sink.js';
import { robotsLines } from '../lures/robots.js';
import { htmlComment } from '../lures/html-comment.js';
import { boundedUAPattern } from './ua-pattern.js';
import { boundRequest, inspectionLimits } from './limits.js';
import { sanitizeEvent, secretEqual } from './security.js';
// Compact state: timestamp in seconds + 10-bit score + 7-bit robots-second marker.
// 50k clients remain bounded without per-client timers or object allocations.
export class Clients {
    private entries = new Map<string, number>();
    get size(): number { return this.entries.size; }
    get(key: string): {
        score: number;
        robots: boolean;
    } {
        const packed = this.entries.get(key);
        if (packed === undefined)
            return { score: 0, robots: false };
        this.entries.delete(key);
        const now = Math.floor(Date.now() / 1000), seen = Math.floor(packed / 131072);
        if (now - seen >= 1800)
            return { score: 0, robots: false };
        this.entries.set(key, packed);
        const marker = Math.floor(packed / 1024) % 128;
        return { score: packed % 1024, robots: marker !== 127 && now - seen < 60 && (now % 127 - marker + 127) % 127 < 60 };
    }
    set(key: string, score: number, robots: boolean, active: boolean): void {
        // Keep robot age precise across subsequent requests by retaining its marker.
        const old = this.entries.get(key), now = Math.floor(Date.now() / 1000);
        const marker = robots ? now % 127 : old === undefined || !active ? 127 : Math.floor(old / 1024) % 128;
        this.entries.delete(key);
        this.entries.set(key, now * 131072 + marker * 1024 + Math.min(score, 1023));
        if (this.entries.size > 50000)
            this.entries.delete(this.entries.keys().next().value!);
    }
}
export function createAgentGuard(config: AgentGuardConfig): AgentGuard {
    validateConfig(config);
    const limits = inspectionLimits(config);
    const uaPatterns = (config.allowlist?.uaPatterns ?? []).filter(boundedUAPattern);
    const registry = new Registry(config.canary.registry, config.canary.secret, config.canary.prefix ?? 'AG-CANARY-');
    const decoys = new Decoys(config, registry), crawler = new CrawlerVerifier(config.crawler), clients = new Clients(), metrics = new Metrics();
    const incidents = new Incidents(config.incident?.windowMs), tracing = new CanaryTracing(), timing = new Timing();
    const emit = (e: AgentGuardEvent): void => { metrics.event(e); logEvent(e, config); };
    const alerts = new Dispatcher(config.alerts, emit);
    // A single-entry memo avoids repeated IP parsing/hash/UA classification on keep-alive
    // traffic, without retaining another per-client cache alongside Clients.
    let lastIp: string | undefined, lastUa: string | undefined, lastKey = '', lastClass: UAClass = 'unknown';
    let closed = false;
    const guard: AgentGuard = {
        async inspect(input, context): Promise<AGDecision> {
            const start = process.hrtime.bigint();
            try {
                if (closed)
                    throw new Error('agent-guard is closed');
                const req = boundRequest(input, limits);
                const pathTruncated = input.path.length > limits.maxUrlLength;
                const queryAt = req.path.indexOf('?');
                if (queryAt >= 0) req.path = req.path.slice(0, queryAt);
                req.ip = (config.clientIp?.(input) ?? req.ip).slice(0, 128);
                let headers = req.headers;
                const ua = String(headers['user-agent'] ?? '').slice(0, 512), allow = config.allowlist;
                const token = allow?.headerToken;
                if (allow?.ips?.includes(req.ip) || allow?.cidrs?.some(c => inCidr(req.ip, c)) || uaPatterns.some(p => { p.lastIndex = 0; return p.test(ua); }) || (token && typeof headers[token.name.toLowerCase()] === 'string' && secretEqual(headers[token.name.toLowerCase()] as string, token.value)))
                    return { action: 'pass', events: [] };
                if (req.ip !== lastIp || ua !== lastUa) {
                    lastKey = clientKey(req.ip, ua);
                    lastClass = classifyUA(ua);
                    lastIp = req.ip;
                    lastUa = ua;
                }
                const key = lastKey, state = clients.get(key), signals: string[] = [], events: AgentGuardEvent[] = [];
                const automation = timing.record(key);
                let uaClass = lastClass;
                if (uaClass === 'automation')
                    signals.push('ua_automation');
                const id = context?.mcp ? 'MCP' : context?.graphql ? 'GQL' : pathTruncated ? undefined : decoys.match(req.path, req.method), probe = pathSignal(req.path);
                const decoyHit = id && (id === 'MCP' ? mcpDecoyTools.some(tool => tool.name === context?.mcp?.toolName) : id === 'GQL' ? graphqlDecoys().some(decoy => decoy.field.name === context?.graphql?.fieldName) : true);
                const scanBody = id === 'MCP' || id === 'GQL' || id === 'D5' || (config.canaryScan?.bodyPaths ?? ['/login', '/api/auth/*']).some(p => matchesPath(req.path, p));
                const hits = scanRequest(req, registry, config, scanBody);
                if (hits.length)
                    signals.push('canary_replay');
                let verified: Awaited<ReturnType<CrawlerVerifier['verify']>> | undefined;
                if (id) {
                    const claimed = claimedCrawler(ua);
                    if (claimed) {
                        // Preserve the header snapshot across the only inspection await
                        // that precedes use of request headers in a decoy response.
                        headers = { ...headers };
                        req.headers = headers;
                        verified = await crawler.verify(req.ip, claimed);
                        uaClass = verified.verified ? 'verified_crawler' : 'spoofed_crawler';
                        if (!verified.verified)
                            signals.push('ua_spoof_crawler');
                    }
                    if (decoyHit && !verified?.verified) {
                        signals.push('decoy_path');
                        if (state.robots)
                            signals.push('robots_then_disallowed');
                    }
                }
                else if (probe)
                    signals.push(probe === 'probe' ? 'probe_path' : 'ai_discovery_path');
                state.score = Math.min(1023, state.score + signals.reduce((n, s) => n + (weights[s] ?? 0), 0));
                clients.set(key, state.score, req.path === '/robots.txt', state.robots);
                // Internal observation only: robots requests keep their existing event behavior.
                if (req.path === '/robots.txt') incidents.observe(key, 'robots');
                if (!id && signals.length === 0)
                    return { action: 'pass', events };
                const make = (event: AgentGuardEvent['event'], severity: Severity): AgentGuardEvent => ({ v: 1, ts: new Date().toISOString(), event_id: ulid(), event, severity, project: config.project, env: config.env, req: { method: req.method, path: req.path, query_keys: Object.keys(req.query), ip: req.ip, client_key: key, ua, ua_class: uaClass, has_session: headers.cookie !== undefined }, score: state.score, signals: [...signals] });
                const push = (event: AgentGuardEvent): void => {
                    if (automation !== undefined) event.automation_score = automation;
                    const incident = incidents.event(event);
                    const safe = sanitizeEvent(incident ? { ...event, incident } : event);
                    events.push(safe); emit(safe); alerts.enqueue(safe);
                };
                for (const hit of hits)
                    push({ ...make('canary_replay', 'critical'), canary: { id: hit.entry.id, placement: hit.entry.placement, env: hit.entry.env, found_in: hit.found_in, field: hit.field, ...tracing.replay(hit.entry, req.path, key) } });
                if (id && verified?.verified) {
                    push({ ...make('crawler_bypass', 'debug'), crawler: verified });
                    return { action: 'respond', response: { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not Found\n' }, events };
                }
                if (decoyHit) {
                    // Log and enqueue before the fixed D5 login delay, so delivery latency stays low.
                    const status = id === 'D2' ? (/^Bearer\s+/i.test(String(headers.authorization ?? '')) ? 403 : 401) : id === 'D5' ? (req.method === 'POST' ? 401 : 405) : 200;
                    push({ ...make('decoy_hit', uaClass === 'declared_ai_crawler' && id !== 'GQL' ? 'info' : id === 'D1' || id === 'D3' ? 'high' : 'medium'), decoy: { id, status }, ...(verified ? { crawler: verified } : {}) });
                    const response = id === 'MCP' ? { status: 200, headers: decoyHeaders('application/json'), body: JSON.stringify({ error: 'permission denied' }) } : id === 'GQL' ? graphqlForbiddenResponse() : await decoys.respond(id, req);
                    if (req.method === 'HEAD')
                        response.body = '';
                    if (response.body) tracing.delivered(response.body, registry);
                    return { action: 'respond', response, events };
                }
                if (probe)
                    push(make(probe, 'info'));
                return { action: 'pass', events };
            }
            catch (error) {
                if (closed) throw error;
                return { action: 'pass', events: [] };
            }
            finally {
                metrics.request(Number(process.hrtime.bigint() - start));
            }
        },
        robotsLines: () => robotsLines(decoys.disallowed()),
        htmlCommentFor: path => config.lures?.htmlComment && config.lures.htmlComment.paths.includes(path) ? htmlComment(decoys.paths.D3[0]!) : null,
        metrics: () => metrics.snapshot(),
        prometheusText: () => metrics.prometheusText(clients.size, timing.size),
        async close() { closed = true; await alerts.close(); },
    };
    guardConfigs.set(guard, config);
    return guard;
}
