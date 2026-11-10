# Middleware security review (v0.2)

Scope: middleware internals, existing Node/Express entry points, canary authentication/scanning, crawler verification, logging and alerts. Canaries remain inert. Only detect mode is supported; a replay/oversize input does not deny the host request. Existing configured decoy responses are preserved. No runtime dependencies were added.

## Limits

The optional `AgentGuardConfig.limits` object and exported `InspectionLimits` type document these defaults:

| Option | Default | Behavior on exhaustion |
| --- | ---: | --- |
| maxUrlLength | 8192 UTF-16 code units | Bound target before URL parsing and path inspection; an overlong path cannot match a decoy through truncation. |
| maxHeaders | 100 | Inspect at most 100 fields and 100 total array/scalar value visits. |
| maxHeaderBytes | 16384 UTF-8 bytes | Shared name/value budget (plus one work unit per value); oversized values are skipped completely, so a truncated credential cannot grant allowlist access. |
| maxBodyBytes | 16384 | Bound UTF-8 bytes and traversal work, including nodes and keys; scan only eligible body paths. |
| maxCanaryCandidates | 64 | Count candidate occurrences globally, including invalid and repeated candidates; skip the remainder. |
| maxQueryParams | 100 | Bound query fields/values; URL parsing counts repeated parameters individually. |
| maxQueryBytes | 16384 UTF-8 bytes | Shared query name/value budget (plus one work unit per value); skip oversized values. |

All new limits accept finite nonnegative safe integers; zero disables the corresponding inspection work. The existing `canaryScan.maxBodyBytes` option remains supported; `limits.maxBodyBytes` takes precedence. Arrays are read incrementally, never joined wholesale. Normalization uses null-prototype records, including for query keys such as `__proto__`. Input is not mutated, rejected, or consumed from the request stream. Malformed URLs and inspection errors fail open.

Body traversal never calls JSON.stringify, toJSON or accessor properties. It tracks cycles, limits nesting to 32, and charges visits/key bytes against the body budget, including empty/scalar values. It can scan a bounded prefix rather than requiring the entire parsed body to fit. Host body parsing and upstream wire-size limits remain the host's responsibility. Arbitrary executable host objects/proxies, operator callbacks and alert adapters are trusted application code; JavaScript cannot preempt a blocking callback.

## Timing-safe comparisons

A shared secretEqual helper encodes UTF-8 buffers, returns false for different byte lengths, and uses crypto.timingSafeEqual for equal lengths. It protects allowlist header tokens, canary checksums, exact registry authentication (including legacy/rotated tokens), and webhook signatures. Tests instrument the crypto call to check buffers and equal lengths, and cover Unicode, length differences, first/last-byte mutations and oversized credentials.

Registry lookup uses a public SHA-256 fingerprint as an index and confirms the complete candidate with secretEqual. This index is not an authentication comparison. Prefix/format parsing, Aho–Corasick legacy discovery, registry duplicate validation and event deduplication are content-dependent discovery/metadata operations; final authentication still uses timingSafeEqual. This does not claim whole-request constant-time behavior or hide token lengths/presence. Webhooks validate fixed signature length and bound timestamps before parsing. Registry contents/configuration are trusted operator inputs, loaded once; requests never grow the registry.

## Regular expression findings

Every literal in src/ is enumerated directly with the TypeScript AST, including non-exported regexes. Each is tested independently against 100k-character adversarial strings (letters, digits, whitespace, controls, slashes, suffix failures and route/UA prefixes), with a <50ms bound per execution. There were no nested/ambiguous repeated groups in the built-in expressions. The dynamic canary match-all regex was removed in favor of bounded fixed-prefix parsing and an Aho–Corasick index for legacy tokens. Decoy routing uses exact string/prefix comparisons; wildcard body paths use startsWith.

| Regex | File | Risk | Action |
| --- | --- | --- | --- |
| `/^\/[A-Za-z0-9/_-]*$/` | `src/adapters/node.ts` | Low: fixed alternatives or bounded/linear character scans | Linear fast-path validation after URL length guard |
| `/^\d+$/` | `src/alerts/webhook.ts` | Low: fixed alternatives or bounded/linear character scans | Length guards before validation; timing-safe authentication |
| `/^sha256=[a-f0-9]{64}$/` | `src/alerts/webhook.ts` | Low: fixed alternatives or bounded/linear character scans | Length guards before validation; timing-safe authentication |
| `/^[A-Z][A-Z0-9]{1,15}-CANARY-$/` | `src/canary/format.ts` | Low: fixed alternatives or bounded/linear character scans | Fixed-size token parsing; length guards and bounded candidates |
| `/^[0-9A-HJKMNP-TV-Z]{12}-[0-9A-HJKMNP-TV-Z]{6}$/` | `src/canary/format.ts` | Low: fixed alternatives or bounded/linear character scans | Fixed-size token parsing; length guards and bounded candidates |
| `/^[0-9A-HJKMNP-TV-Z]{12}-[0-9A-HJKMNP-TV-Z]{6}$/` | `src/canary/registry.ts` | Low: fixed alternatives or bounded/linear character scans | Fixed-size token parsing; length guards and bounded candidates |
| `/\/src\/decoys\/[^/]+\.ts$/` | `src/cli/commands.ts` | Low: fixed alternatives or bounded/linear character scans | CLI-only; retained linear/fixed-width scans and timing coverage |
| `/[A-Z][A-Z0-9]{1,15}-CANARY-/` | `src/cli/commands.ts` | Low: fixed alternatives or bounded/linear character scans | CLI-only; retained linear/fixed-width scans and timing coverage |
| `/^(\d+)([dhm])$/` | `src/cli/commands.ts` | Low: fixed alternatives or bounded/linear character scans | CLI-only; retained linear/fixed-width scans and timing coverage |
| `/^[A-Z][A-Z0-9]{1,15}-CANARY-$/` | `src/config.ts` | Low: fixed alternatives or bounded/linear character scans | Retained; adversarial timing regression coverage |
| `/^[a-z0-9.-]+\.invalid$/i` | `src/config.ts` | Low: fixed alternatives or bounded/linear character scans | Retained; adversarial timing regression coverage |
| `/[\s<>?#]/` | `src/config.ts` | Low: fixed alternatives or bounded/linear character scans | Retained; adversarial timing regression coverage |
| `/^\/[a-zA-Z0-9/_-]+$/` | `src/config.ts` | Low: fixed alternatives or bounded/linear character scans | Retained; adversarial timing regression coverage |
| `/^Bearer\s+/i` | `src/core/inspect.ts` | Low: fixed alternatives or bounded/linear character scans | Retained; adversarial timing regression coverage |
| `/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g` | `src/core/security.ts` | Low: fixed alternatives or bounded/linear character scans | Linear control stripping after a 512-character cap |
| `/^\/(?:llms\.txt\|\.well-known\/(?:mcp\|ai-plugin)\.json\|openapi\.json\|swagger[^/]*)$/` | `src/core/signals.ts` | Low: fixed alternatives or bounded/linear character scans | Anchored/disjoint routing alternatives on capped paths |
| `/^\/(?:wp-admin(?:\/\|$)\|\.git\/\|phpinfo\.php$\|actuator(?:\/\|$)\|admin$\|debug$)/` | `src/core/signals.ts` | Low: fixed alternatives or bounded/linear character scans | Anchored/disjoint routing alternatives on capped paths |
| `/Googlebot\|Google-InspectionTool\|GoogleOther/i` | `src/crawler/ua.ts` | Low: fixed alternatives or bounded/linear character scans | Fixed literal alternatives; inspector UA capped at 512 characters |
| `/bingbot/i` | `src/crawler/ua.ts` | Low: fixed alternatives or bounded/linear character scans | Fixed literal alternatives; inspector UA capped at 512 characters |
| `/Applebot/i` | `src/crawler/ua.ts` | Low: fixed alternatives or bounded/linear character scans | Fixed literal alternatives; inspector UA capped at 512 characters |
| `/DuckDuckBot/i` | `src/crawler/ua.ts` | Low: fixed alternatives or bounded/linear character scans | Fixed literal alternatives; inspector UA capped at 512 characters |
| `/YandexBot/i` | `src/crawler/ua.ts` | Low: fixed alternatives or bounded/linear character scans | Fixed literal alternatives; inspector UA capped at 512 characters |
| `/Baiduspider/i` | `src/crawler/ua.ts` | Low: fixed alternatives or bounded/linear character scans | Fixed literal alternatives; inspector UA capped at 512 characters |
| `/GPTBot\|ChatGPT-User\|OAI-SearchBot\|ClaudeBot\|Claude-Web\|Claude-User\|PerplexityBot\|Perplexity-User\|CCBot\|Bytespider\|Amazonbot\|cohere-ai/i` | `src/crawler/ua.ts` | Low: fixed alternatives or bounded/linear character scans | Fixed literal alternatives; inspector UA capped at 512 characters |
| `/curl\/\|python-requests\|python-httpx\|node-fetch\|axios\/\|Go-http-client\|HeadlessChrome\|wget\/\|undici/i` | `src/crawler/ua.ts` | Low: fixed alternatives or bounded/linear character scans | Fixed literal alternatives; inspector UA capped at 512 characters |
| `/Mozilla\/\|Chrome\/\|Safari\/\|Firefox\/\|Edg\//i` | `src/crawler/ua.ts` | Low: fixed alternatives or bounded/linear character scans | Fixed literal alternatives; inspector UA capped at 512 characters |
| `/\.$/` | `src/crawler/verify.ts` | Low: fixed alternatives or bounded/linear character scans | Retained; adversarial timing regression coverage |
| `/^Bearer\s+/i` | `src/decoys/d2-admin.ts` | Low: fixed alternatives or bounded/linear character scans | Retained; adversarial timing regression coverage |
| `/^Bearer\s+/i` | `src/decoys/d2-admin.ts` | Low: fixed alternatives or bounded/linear character scans | Retained; adversarial timing regression coverage |
| `/\/$/` | `src/decoys/index.ts` | Low: fixed alternatives or bounded/linear character scans | Retained; adversarial timing regression coverage |
| Dynamic prefix + fixed-width canary format (removed) | `src/canary/scan.ts` | Bounded format, but match-all allocated all candidates before limiting | Replaced by incremental prefix parsing and indexed legacy matching |
| Operator-supplied RegExp | `src/core/ua-pattern.ts`, `src/core/inspect.ts` | Potential catastrophic backtracking on request UAs | Execute only the bounded subset on at most 512 UA characters; skip unsupported patterns |

Operator-supplied `allowlist.uaPatterns` are also evaluated against attacker-controlled UAs. Their RegExp API is retained, but only a conservative bounded subset is executed: up to 256 source characters, literal alternatives/groups and at most one repeated character/class. Quantified groups, multiple repetition operators, backreferences, lookarounds, Unicode set (v) syntax and other unsupported forms are skipped. UAs are capped at 512 characters; supported expressions have at most quadratic restart work on that fixed input bound. Unsafe examples such as `/(a+)+$/` and `/(a|aa)+$/` are tested without executing them. This restriction may require operators using complex patterns to express them as simpler alternatives.

## Reflection and injection

sanitizeHeader strips C0/C1 controls, CR/LF, DEL and Unicode line/paragraph separators, and caps the inspected/output prefix at 512 characters. The middleware sanitizes every event string (including request methods/paths/UAs/query keys/IPs, imported canary IDs/placements/environments, project labels, DNS metadata and adapter names) before exposing decisions, observers, local logs or alerts. Formatting and built-in console/webhook adapters sanitize independently too. Raw credentials and request bodies are not logged. Response headers are static except the internal content-type helper, which sanitizes its value; tests validate headers using Node's header validator. Matching and checksum verification use original bounded values before display sanitization.

## State and concurrency bounds

| State | Bound | Verification |
| --- | ---: | --- |
| Client score/robots history | 50000 entries, 30-minute lazy expiry | Fill/eviction test plus existing TTL tests |
| Crawler result LRU | 10000 entries; 24-hour positive/1-hour negative TTL | Fill test and existing cache/TTL tests |
| Pending crawler checks | 128 | Concurrent unresolved resolver test |
| Actual DNS jobs | 128, including jobs surviving a timeout | A second wave after timeout starts no additional jobs |
| DNS result inspection | 16 reverse hosts, 64 forward addresses per host; host length <=253 | Bounded loops; resolver tests |
| Alert dedupe LRU | 50000 entries | Fill/eviction test |
| Alert delivery queue | 1024 queued + 8 active | Saturation and drain test |
| Alert pump scheduling | One queued microtask | Coalesced scheduling; saturation test |
| Latency samples | 2048 | Ring-buffer saturation test |
| Request memo | One IP/UA entry | Existing changing-IP/UA tests |

Crawler saturation follows the existing failOpen setting (default true) without starting further DNS work. DNS timeouts cannot release an actual-work slot until the underlying resolver settles. This prevents ignored cancellation from causing unbounded background work. Alert adapters retain the existing retry/time limits and per-channel rate limit. Adapters/resolvers are trusted configuration code; the host controls their internal resource use.

## Property and regression coverage

A tiny seeded Mulberry32 generator in test/helpers/prng.ts supplies reproducible cases without new dependencies: 1000 canary round-trips/tamper cases, 500 arbitrary request cases with a per-inspection <50ms bound, and 2000 sanitizer cases checking control removal, caps and idempotence. Additional deterministic cases cover 100k/1M inputs, cycles, deep/wide bodies, getter/toJSON isolation, UTF-8 budgets, duplicate query parameters, prototype keys, global candidate exhaustion, legacy overlap matching, truncation authentication mistakes, reflection, state saturation and DNS timeouts. Timing assertions are regression checks on this test environment, not a hardware-independent latency guarantee. The existing D5 intentional login delay and configured DNS/alert I/O are separate from CPU inspection timing.
