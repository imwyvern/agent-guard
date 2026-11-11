import type { AGDecision, AGRequest, AgentGuardConfig, AgentGuardEvent, Severity, UAClass } from '../types.js';
import { validateConfig } from '../config.js';
import { webCrypto } from '../crypto/web.js';
import { boundRequest, inspectionLimits } from '../core/limits.js';
import { clientKeyAsync } from '../core/client-key-core.js';
import { inCidr } from '../core/ip-parse.js';
import { boundedUAPattern } from '../core/ua-pattern.js';
import { pathSignal, weights, patterns as signalPatterns } from '../core/signals.js';
import { sanitizeEvent } from '../core/security-core.js';
import { ulid } from '../core/ulid-core.js';
import { claimedCrawler, classifyUA } from '../crawler/ua.js';
import { customCrawlerVerify } from '../crawler/custom.js';
import { Metrics } from '../metrics.js';
import { asciiAlphanumeric, onlyCharacters } from '../alerts/shared.js';
import { Dispatcher, severityRank } from '../alerts/dispatcher-core.js';
import type { StateStore } from '../state/store.js';
import { WebRegistry } from './registry.js';
import { WebDecoys } from './decoys.js';
import { WebState, stateTtl } from './state.js';
import { WebTrap, trapResponse, notFound } from './trap.js';
import { WebMaze } from './maze.js';
import { scanRequest, matchesPath } from './scan.js';
import { configIp, webRequest } from './request.js';
import { mcpDecoyTools } from '../scenarios/mcp.js';
import { graphqlDecoys, graphqlForbiddenResponse } from '../scenarios/graphql.js';
import { decoyHeaders } from '../decoys/headers.js';

export { memoryStore } from '../state/store.js';
export type { StateStore } from '../state/store.js';
export { webhookAdapter, slackAdapter, telegramAdapter, feishuAdapter } from './alerts.js';
export interface WebGuardConfig extends Omit<AgentGuardConfig, 'mode'> {
    mode?: AgentGuardConfig['mode'];
    store?: StateStore;
    ipHeader?: string;
}
export interface WebContext {
    waitUntil?(promise: Promise<unknown>): void;
    /** Direct connection address; used only when no ipHeader is configured. */
    clientIp?: string;
}
export interface WebInspectContext {
    mcp?: { toolName?: string };
    graphql?: { fieldName?: string };
}
export interface WebGuard {
    handle(request: Request, ctx?: WebContext): Promise<Response | null>;
    inspect(request: Request | AGRequest, context?: WebInspectContext): Promise<AGDecision>;
    prometheusText(): string;
    setTrapEnabled(enabled: boolean): void;
    close(): Promise<void>;
}
export function createWebGuard(input: WebGuardConfig): WebGuard {
    if (typeof input.canary?.registry === 'string') throw new Error('Web canary.registry requires an in-memory registry object; filesystem paths are Node-only');
    if (input.crawler?.ipRangesFile) throw new Error('crawler.ipRangesFile is Node-only');
    if (input.crawler?.verify === true || input.crawler?.verify === 'dns' || input.crawler?.resolver || input.crawler?.extraSuffixes)
        throw new Error('DNS crawler verification is Node-only; use ua-bypass or custom on Web');
    if (input.alerts?.adapters.some(adapter => ['smtp', 'tcp'].some(name => adapter.name.toLowerCase().includes(name)))) throw new Error('SMTP/TCP alerts are unavailable on Web; use webhook / Slack / Telegram / Feishu');
    if (input.store && !['get', 'set', 'delete'].every(method => typeof (input.store as unknown as Record<string, unknown>)[method] === 'function')) throw new Error('store must implement get, set and delete');
    if (input.ipHeader !== undefined && (!input.ipHeader || !onlyCharacters(input.ipHeader, asciiAlphanumeric + "!#$%&'*+.^_`|~-"))) throw new Error('ipHeader must be a header name');
    const delay = input.trap?.delay;
    if (delay?.ms !== undefined && (!Number.isSafeInteger(delay.ms) || delay.ms < 0)) throw new Error('trap.delay.ms must be a nonnegative safe integer');
    const config: AgentGuardConfig = { ...input, mode: input.mode ?? 'detect', crawler: { ...input.crawler, verify: input.crawler?.verify ?? 'ua-bypass' },
        trap: input.trap ? { ...input.trap, ...(delay ? { delay: { ...delay, ms: Math.min(delay.ms ?? 1000, 3000) } } : {}) } : undefined };
    validateConfig(config);
    const limits = inspectionLimits(config), registry = new WebRegistry(config.canary.registry as Exclude<AgentGuardConfig['canary']['registry'], string>, config.canary.secret, config.canary.prefix ?? 'AG-CANARY-');
    const decoys = new WebDecoys(config, registry), state = new WebState(input.store, config), trap = new WebTrap(config), metrics = new Metrics();
    const maze = config.mode === 'trap' && config.trap?.maze?.enabled ? new WebMaze(config, state) : undefined;
    const patterns = (config.allowlist?.uaPatterns ?? []).filter(boundedUAPattern);
    if (!input.store) console.warn('agent-guard Web: incident correlation, trap.rateLimit, trap.block, timing scores and maze session admission are off until a StateStore is provided');
    const emit = (event: AgentGuardEvent): void => {
        metrics.event(event);
        const local = sanitizeEvent(event);
        if (config.log?.keepIp === false) delete local.req.ip;
        try { config.onEvent?.(structuredClone(local)); } catch { /* Isolate observers. */ }
        if (severityRank[event.severity] >= severityRank[config.log?.level ?? 'info'])
            try { config.log?.sink?.(local); } catch { /* Isolate sinks. */ }
    };
    const alerts = new Dispatcher(config.alerts, emit, webCrypto);
    const allowed = (req: AGRequest, ua: string): boolean => {
        const allow = config.allowlist, token = allow?.headerToken, value = token && req.headers[token.name.toLowerCase()];
        return !!(allow?.ips?.includes(req.ip) || allow?.cidrs?.some(c => inCidr(req.ip, c)) || patterns.some(p => { p.lastIndex = 0; return p.test(ua); }) || token && typeof value === 'string' && webCrypto.secretEqual(value, token.value));
    };
    let lastIp: string | undefined, lastUa: string | undefined, lastKey: Promise<string> | undefined;
    let closed = false;
    const inspect = async (inputRequest: Request | AGRequest, ctx?: WebContext, context?: WebInspectContext): Promise<AGDecision> => {
        const start = performance.now();
        let enqueued = false;
        try {
            if (closed) throw new Error('agent-guard is closed');
            const inputReq = inputRequest instanceof Request ? await webRequest(inputRequest, { ...config, ...('ipHeader' in input ? { ipHeader: input.ipHeader } : {}) }, decoys, ctx?.clientIp, !!(context?.mcp || context?.graphql)) : inputRequest;
            const req = boundRequest(inputReq, limits), pathTruncated = inputReq.path.length > limits.maxUrlLength;
            req.path = req.path.split('?', 1)[0]!;
            req.ip = (config.clientIp?.(inputReq) ?? (inputRequest instanceof Request ? req.ip : input.ipHeader ? configIp(String(req.headers[input.ipHeader.toLowerCase()] ?? ''), input.ipHeader) : req.ip)).slice(0, 128);
            const ua = String(req.headers['user-agent'] ?? '').slice(0, 512);
            if (allowed(req, ua)) return { action: 'pass', events: [] };
            if (lastIp !== req.ip || lastUa !== ua || !lastKey) { lastIp = req.ip; lastUa = ua; lastKey = clientKeyAsync(req.ip, ua, webCrypto); }
            const key = await lastKey, events: AgentGuardEvent[] = [], signals: string[] = [];
            let uaClass: UAClass = classifyUA(ua);
            const id = context?.mcp ? 'MCP' : context?.graphql ? 'GQL' : pathTruncated ? undefined : decoys.match(req.path, req.method);
            const mazePath = !context?.mcp && !context?.graphql && !pathTruncated && !!maze?.matches(req.path), probe = pathSignal(req.path);
            const decoyHit = id && (id === 'MCP' ? mcpDecoyTools.some(tool => tool.name === context?.mcp?.toolName) : id === 'GQL' ? graphqlDecoys().some(decoy => decoy.field.name === context?.graphql?.fieldName) : true);
            const claimed = claimedCrawler(ua);
            let crawler: AgentGuardEvent['crawler'];
            if (claimed) {
                const verified = config.crawler?.verify === 'custom' ? await customCrawlerVerify(config.crawler, req.ip, ua) : false;
                crawler = { claimed, verified, cache: false };
                if (verified || config.crawler?.verify === 'ua-bypass') {
                    const event = sanitizeEvent({ v: 1, ts: new Date().toISOString(), event_id: ulid(webCrypto), event: 'crawler_bypass', severity: 'debug', project: config.project, env: config.env,
                        req: { method: req.method, path: req.path, query_keys: Object.keys(req.query), ip: req.ip, client_key: key, ua, ua_class: verified ? 'verified_crawler' : uaClass, has_session: req.headers.cookie !== undefined }, score: 0, signals: [], crawler });
                    emit(event);
                    return id || mazePath ? { action: 'respond', response: notFound(req.method === 'HEAD'), events: [event] } : { action: 'pass', events: [event] };
                }
                if (config.crawler?.verify === 'custom' || id || mazePath || trap.enabled) { uaClass = 'spoofed_crawler'; signals.push('ua_spoof_crawler'); }
            }
            if (uaClass === 'automation') signals.push('ua_automation');
            const scanBody = id === 'MCP' || id === 'GQL' || id === 'D5' || (config.canaryScan?.bodyPaths ?? ['/login', '/api/auth/*']).some(p => matchesPath(req.path, p));
            const hits = await scanRequest(req, registry, config, scanBody);
            const callback = await decoys.callback(req.path);
            if (hits.length) signals.push('canary_replay');
            const make = (event: AgentGuardEvent['event'], severity: Severity, score: number): AgentGuardEvent => ({ v: 1, ts: new Date().toISOString(), event_id: ulid(webCrypto), event, severity, project: config.project, env: config.env,
                req: { method: req.method, path: req.path, query_keys: Object.keys(req.query), ip: req.ip, client_key: key, ua, ua_class: uaClass, has_session: req.headers.cookie !== undefined }, score, signals: [...signals] });
            const result = await state.run(key, async client => {
                const previous = client.score, now = Date.now(), automation = state.timing(client);
                if (id) {
                    if (decoyHit) { signals.push('decoy_path'); if (client.robotsAt !== undefined && now - client.robotsAt < 60_000) signals.push('robots_then_disallowed'); }
                }
                else if (probe) signals.push(probe === 'probe' ? 'probe_path' : 'ai_discovery_path');
                client.score = Math.min(1023, client.score + signals.reduce((n, signal) => n + (weights[signal] ?? 0), 0));
                if (input.store && req.path === '/robots.txt') { client.robotsAt = now; state.incident(client, 'robots'); }
                const push = (event: AgentGuardEvent): void => {
                    if (automation !== undefined) event.automation_score = automation;
                    const step = event.event === 'decoy_hit' ? event.decoy!.id : ['probe', 'ai_discovery', 'canary_replay'].includes(event.event) ? event.event : undefined;
                    const incident = step ? state.incident(client, step) : undefined;
                    if (incident) event.incident = incident;
                    if (input.store && config.mode === 'trap' && (event.event === 'canary_replay' || incident?.confidence === 'high')) {
                        const fresh = (client.confirmedUntil ?? 0) <= now;
                        client.confirmedUntil = now + stateTtl;
                        if (trap.enabled && config.trap?.block?.enabled && (fresh || event.event === 'canary_replay')) client.blockedUntil = now + (config.trap.block.ttlMs ?? 900_000);
                    }
                    const safe = sanitizeEvent(event);
                    events.push(safe); emit(safe); alerts.enqueue(safe); enqueued = true;
                };
                if (trap.checkCircuit(() => metrics.snapshot().inspect_ns_p99)) push(make('trap_circuit_open', 'high', client.score));
                for (const hit of hits) push({ ...make('canary_replay', 'critical', client.score), canary: { id: hit.entry.id, placement: hit.entry.placement, env: hit.entry.env, found_in: hit.found_in, field: hit.field, leaked_at: hit.entry.placement, replayed_at: req.path } });
                if (callback) {
                    const event = make('canary_callback', 'high', client.score);
                    event.req = { method: req.method, path: '/ag/cb/' + callback.id, ip: req.ip, client_key: key };
                    push({ ...event, canary: { ...callback, env: config.env, found_in: 'path', field: 'callback' } });
                    return { response: { status: 204, headers: { 'Cache-Control': 'no-store' }, body: '' }, gated: false };
                }
                const blocked = trap.enabled && input.store && config.trap?.block?.enabled && (client.blockedUntil ?? 0) > now;
                const gated = trap.enabled && id !== 'MCP' && id !== 'GQL' && ((client.confirmedUntil ?? 0) > now || hits.length > 0 || previous > 0 && client.score >= (config.trap?.gate?.minScore ?? 200));
                if (!mazePath && blocked) { push(make('trap_block', 'high', client.score)); return { response: trapResponse(403, req.method === 'HEAD'), gated }; }
                if (decoyHit) {
                    const status = id === 'D2' ? (signalPatterns.bearer.test(String(req.headers.authorization ?? '')) ? 403 : 401) : id === 'D5' ? req.method === 'POST' ? 401 : 405 : 200;
                    push({ ...make('decoy_hit', uaClass === 'declared_ai_crawler' && id !== 'GQL' ? 'info' : id === 'D1' || id === 'D3' ? 'high' : 'medium', client.score), decoy: { id, status }, ...(crawler ? { crawler } : {}) });
                    if (gated && state.limited(client)) return { response: trapResponse(429, req.method === 'HEAD'), gated };
                } else if (probe && !mazePath) push(make(probe, 'info', client.score));
                return { gated, blocked, score: client.score };
            });
            if (result.response) return { action: 'respond', response: result.response, events };
            if (mazePath) {
                const valid = await maze!.verify(req.path);
                if (!result.gated && !valid) return { action: 'pass', events };
                if (!result.gated || !['GET', 'HEAD'].includes(req.method)) return { action: 'respond', response: notFound(req.method === 'HEAD'), events };
                if (result.blocked && valid) {
                    const event = sanitizeEvent(make('trap_block', 'high', result.score ?? 0)); events.push(event); emit(event); alerts.enqueue(event); enqueued = true;
                    return { action: 'respond', response: trapResponse(403, req.method === 'HEAD'), events };
                }
                const page = await maze!.respond(req.path, key, req.method === 'HEAD');
                if (page.spent) { const event = sanitizeEvent(make('exhaust_budget_spent', 'high', result.score ?? 0)); events.push(event); emit(event); alerts.enqueue(event); enqueued = true; }
                return { action: 'respond', response: page.response, events };
            }
            if (decoyHit) {
                const response = id === 'MCP' ? { status: 200, headers: decoyHeaders('application/json'), body: JSON.stringify({ error: 'permission denied' }) } : id === 'GQL' ? graphqlForbiddenResponse() : await decoys.respond(id, req, result.gated && input.store ? await maze?.entry() : undefined);
                if (result.gated && input.store) await trap.delay();
                if (req.method === 'HEAD') response.body = '';
                return { action: 'respond', response, events };
            }
            return { action: 'pass', events };
        }
        catch (error) { if (closed) throw error; return { action: 'pass', events: [] }; }
        finally {
            metrics.request((performance.now() - start) * 1e6);
            if (enqueued && ctx?.waitUntil) { const delivery = alerts.flush().catch(() => {}); try { ctx.waitUntil(delivery); } catch { /* Host lifecycle errors cannot affect responses. */ } }
        }
    };
    return {
        inspect: (request, context) => inspect(request, undefined, context),
        async handle(request, ctx) {
            const decision = await inspect(request, ctx);
            if (decision.action === 'pass') return null;
            return new Response(request.method === 'HEAD' || decision.response.status === 204 ? null : decision.response.body, { status: decision.response.status, headers: decision.response.headers });
        },
        prometheusText: () => metrics.prometheusText(state.clientCount, state.timingCount, { enabled: trap.enabled, blocked: state.blocked, delayed: trap.delayed, mazeActive: trap.enabled ? maze?.active ?? 0 : 0 }),
        setTrapEnabled: enabled => trap.setEnabled(enabled),
        async close() { closed = true; trap.setEnabled(false); await alerts.close(); },
    };
}
