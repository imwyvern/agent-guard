# agent-guard

An AI-agent honeypot middleware for Node and the edge.

(Node와 엣지를 위한 AI 에이전트 허니팟 미들웨어.)

[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

## 왜 필요한가

공격자는 이제 AI agent를 사용해 서버를 탐색하고, 구성을 읽으며, 발견한 키를 재사용합니다. agent-guard는 애플리케이션의 HTTP/API 계층에 격리된 가짜 구성, 키, 엔드포인트(아무 권한도 열지 않는 비활성 카나리아)를 심습니다. 공격자의 AI가 이를 건드리면, 높은 신뢰도의 조기 알림과 키 교체, 접근 축소, 호스트 격리 같은 대응에 쓸 수 있는 시간 창을 얻게 됩니다.

이것은 서버 수준의 마지막 트립와이어이자 조기 경보 / 지연 계층입니다. 패치, WAF, 최소 권한을 대체하지 않습니다. 기본 모드는 탐지와 알림뿐입니다. 선택적이고 기본 꺼짐인 trap 모드는 확인된 클라이언트를 늦추거나 속도 제한할 수 있지만, 공격을 차단한다고 주장하지 않습니다.

**오늘 제공되는 것과 아직 제공되지 않는 것.**

- **오늘**의 범위는 HTTP/API 계층입니다. 격리된 다섯 개의 디코이 라우트, MCP 및 GraphQL 디코이, 비활성 카나리아 자격 증명(`AG-CANARY-…`). 런타임 의존성은 없으며, Node ≥20에서 Express, Node `http`, Hono, Fastify, Koa 어댑터를 제공합니다.
- **호스트 수준 honeyfile**(디스크상의 가짜 `.env`, 클라우드 자격 증명, SSH 키, kubeconfig와 접근 시 알림)은 **계획 중**이며 아직 제공되지 않습니다. 미래의 `agent-guard seed` 명령은 [로드맵](../roadmap.md)에 있습니다.
- **「가짜 성공」 기만** — 공격자의 AI가 침입에 성공했다고 믿게 만들 수 있는 시뮬레이션 환경 — 은 **계획 중**입니다(옵트인 필수, 먼저 안전성 평가). 아직 제공되지 않습니다. [deception.md](../deception.md)를 참고하세요.
- **공격자의 토큰을 소모한다**는 주장은 아직 **입증되지 않았습니다**. 실험적 미로의 바이트 비율은 시뮬레이션에서 1:1로, 하한인 3:1에 미치지 못합니다. 시간 비율 수치는 25 ms/request 모델이며 실제 LLM agent를 측정한 결과가 아닙니다. 그 측정이 끝나기 전에는 토큰 소모를 기대하고 미로를 켜지 마세요. [exhaust.md](../exhaust.md)와 [trap-mode.md](../trap-mode.md)를 참고하세요.
- 카나리아는 비활성 상태입니다. 이 프로젝트는 실제 자격 증명을 사용하지 않고, 리버스 프롬프트 인젝션을 수행하지 않으며, 외부 프로빙도 하지 않습니다. 역공하지 않습니다.

**이것이 하는 일 / 하지 않는 일.** agent-guard는 API를 향한 적대적이거나 탐색적인 AI agent 트래픽을 탐지하고, 유인하며, 관찰합니다. 역공하거나 누구를 공격하지 않습니다. 비목표, 옵트인 기능과 실험적 한계는 [이것이 아닌 것](#이것이-아닌-것)을 참고하세요.

이것은 오픈소스 연구 프로젝트이며 아직 npm에 게시되지 않았습니다. 소스에서 설치하거나 `npm pack`으로 로컬 tarball을 만드세요. 작업 중인 패키지 이름은 `@imwyvern/agent-guard`입니다. Apache-2.0, 저작권 2026 Wesley Wang.

[보안 정책](../../SECURITY.md), [기여 가이드](../../CONTRIBUTING.md), [포지셔닝](../positioning.md), [로드맵](../roadmap.md)을 참고하세요.

## 로드맵: 앞으로의 방향

별도 표기가 없는 항목은 계획 중이며 아직 제공되지 않습니다.

- **호스트 수준 honeyfile** — `agent-guard seed`가 디스크에 비활성 가짜 `.env`, 클라우드 자격 증명, SSH 키, kubeconfig를 심고 접근 시 알립니다.
- **가짜 성공 환경** — 옵트인 필수, 먼저 안전성 평가. 공격자의 AI가 가짜 데이터를 실제처럼 여길 수 있는 시뮬레이션 서비스 면입니다. [deception.md](../deception.md)를 참고하세요.
- **대응 시간 창** — 운영자용 인시던트 타임라인, 체류 시간(dwell-time) 지표, 그리고 운영자 자신의 키 교체 / 차단 스크립트에 연결하는 훅. 프로세스 내 인시던트 상관과 `dwell_ms`는 이미 제공됩니다. 운영자용 타임라인과 훅은 아직 없습니다.
- **격리된 디코이 호스트** — 프로덕션 애플리케이션 프로세스와 분리된 전용 디코이 환경.
- **실제 agent 토큰 비용 평가** — 실험적 미로를 켜기 전에 실제 AI agent의 토큰을 정말로 소모하는지 측정합니다. 현재 1:1 바이트 비율은 가설일 뿐입니다.
- **Edge 어댑터(v0.4b)** — Web 표준 코어와 Cloudflare Workers, Next.js middleware, Deno, Bun.

자세한 계획은 [docs/roadmap.md](../roadmap.md)에 있습니다. 범위와 정직한 주장은 [docs/positioning.md](../positioning.md)에 있습니다.

## 로컬 설치 및 검증

이 워크스페이스에는 개발 도구가 이미 설치되어 있습니다. 여기에 추가 의존성을 설치하지 마세요.

```sh
npm run build
npm run typecheck
npm run lint          # strict-compiler lint (tsc --noUnusedLocals --noUnusedParameters)
npm test
npm run test:coverage
npm run bench
npm pack --dry-run
```

별도의 로컬 사용처에서는 `npm pack`으로 tarball을 만든 뒤 `./imwyvern-agent-guard-0.1.0.tgz`를 설치하세요. tarball에는 `dist/`, `schema/`, readme/changelog, 법적 고지만 포함됩니다. `private: true`가 게시를 막습니다.

## Express

```ts
import express from 'express';
import { createAgentGuard, consoleAdapter } from '@imwyvern/agent-guard';
import { agentGuard } from '@imwyvern/agent-guard/express';

const guard = createAgentGuard({
  project: 'local-catalog', env: 'demo', mode: 'detect',
  projectSeed: 'stable-project-seed',
  canary: {
    secret: process.env.AG_CANARY_SECRET!, // operator-supplied HMAC secret
    registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] },
  },
  alerts: { adapters: [consoleAdapter()] },
  lures: { robots: 'append' },
});
const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(agentGuard(guard)); // body parsers must precede the guard
app.get('/', (_req, res) => res.send('<h1>Local catalog</h1>'));
app.use((_req, res) => res.status(404).send('Not Found\n'));
const server = app.listen(3000, '127.0.0.1');
// On shutdown: stop accepting requests, then await guard.close() to flush alerts.
```

레지스트리 파일 이름을 사용할 때는 CLI로 먼저 준비하세요. 빈 레지스트리는 메모리에서 정규 디코이 카나리아 여섯 개를 생성합니다. 재시작 후에도 토큰이 안정적으로 유지되어야 한다면, CLI로 레지스트리 배치를 영속화하세요. 시드가 제어하는 것은 무해한 가짜 데이터이며, 카나리아 ID는 암호학적으로 무작위인 상태로 남습니다.

## 네이티브 Node HTTP

```ts
import { createServer } from 'node:http';
import { agentGuardNode, wrap } from '@imwyvern/agent-guard/node';

// Reuse the guard configured above.
const middleware = agentGuardNode(guard);
const server = createServer((req, res) => {
  // If this host parses a body, attach the bounded parsed value as req.body
  // before calling middleware. The guard never consumes the request stream.
  middleware(req, res, () => {
    res.statusCode = 404;
    res.end('Not Found\n');
  });
});
// Equivalent for a host that already provides req.body:
const listener = wrap(guard, (_req, res) => res.end('Hello'));
```

`inspect(AGRequest)`는 `{ action: 'pass', events }` 또는 `{ action: 'respond', response, events }`를 반환합니다. 코어를 직접 사용하는 쪽은 코어가 내는 평범한 `404`를 스스로 처리해야 합니다. 어댑터는 검증된 크롤러를 호스트에 위임하여 호스트 고유의 없는 라우트 응답을 보존합니다. 디코이 경로를 예약하세요. 실제 라우트와 충돌하는 디코이는 비활성화하거나 재정의하세요.

옵트인 robots/HTML/llms 변환은 선택된 경로에서 최대 1 MiB까지 버퍼링하며, 일반 스트림은 그대로 통과합니다. 압축보다 앞에 설치하세요. 변환은 성공했고 압축되지 않은 응답에만 적용됩니다. 실제 HTML 페이지를 바꾸는 것은, 명시적으로 켠 경우에 한해 로그인 HTML 주석뿐입니다.

## Hono(Node 런타임)

v0.2 Hono 어댑터는 `@imwyvern/agent-guard/hono`로 제공되며, 선택적 `hono` peer를 가집니다. Node ≥20이 필요합니다. 공유 코어는 여전히 `node:crypto`와 Node DNS를 사용합니다. 에지 런타임과 WebCrypto 코어는 v0.4b 작업으로 남아 있습니다.

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { agentGuard } from '@imwyvern/agent-guard/hono';

// Reuse the guard configured in the Express example.
const app = new Hono();
app.use('*', agentGuard(guard));
app.post('/login', async c => c.json(await c.req.json()));
app.get('/', c => c.text('Local catalog'));
app.notFound(c => c.text('Not Found\n', 404));
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 3000 });
```

사용하는 앱에 Hono와 Node 서버 통합을 설치하세요. 이 저장소는 둘 다 개발 의존성으로만 설치하며, 어댑터는 런타임 의존성을 추가하지 않습니다. `agentGuard`는 guard 또는 config를 받고, 복제된 요청에서 대상 본문을 설정된 본문 상한(기본 16 KiB)까지 스캔하며, 원본 본문은 다운스트림 핸들러가 계속 사용할 수 있게 둡니다. JSON과 폼 본문을 지원하며, 형식이 잘못되었거나 잘린 입력은 유계 텍스트로 스캔합니다. 전송 크기 제한과 본문 읽기 기한은 여전히 호스트의 책임입니다. `@hono/node-server`가 소켓 IP를 제공하며, 전달 헤더를 쓰려면 명시적으로 신뢰하는 `clientIp` 콜백이 필요합니다.

기본 `mode: 'detect'`에서 탐지는 여전히 알림만 수행합니다. 카나리아 재사용은 호스트로 계속 진행되고, 디코이에는 noindex/no-store 헤더가 붙으며, 검증된 크롤러는 호스트 고유의 없는 라우트 핸들러에 도달합니다. 옵트인 robots/HTML/llms 변환은 기존 1 MiB 버퍼 상한을 유지합니다. `npm run demo:hono`를 실행하세요(`PORT`와 `AGENT_GUARD=off`는 다른 카탈로그 데모와 동일하게 동작합니다). Hono는 Express 및 Node와 동일한 공유 인수 테스트 스위트를 실행합니다.

## Fastify와 Koa(Node 런타임)

v0.3a(미출시)는 `@imwyvern/agent-guard/fastify`와 `@imwyvern/agent-guard/koa`의 `agentGuard`를 추가하며 동일한 guard 또는 config를 받습니다. Fastify 플러그인은 라우트보다 앞에 `await app.register(agentGuard(guard))`로 등록하고, 본문 파싱 후 `preHandler`에서 검사합니다. Koa에서는 크기를 제한하는 본문 파서 뒤에 `app.use(agentGuard(guard))`를 배치합니다. 두 어댑터 모두 요청 스트림을 소비하지 않으며, 호스트 고유의 크롤러 404, detect 모드에서 알림만 수행하는 재사용 탐지, 옵트인 lure 변환을 보존합니다. 프레임워크는 선택적 peer이며 코어 런타임 의존성은 늘지 않습니다. [Fastify 데모](../../examples/fastify-demo/server.ts), [Koa 데모](../../examples/koa-demo/server.ts), [어댑터 가이드](../community.md)를 참고하세요. 엣지 런타임은 계속 로드맵에 있습니다.

## MCP / LLM 도구 엔드포인트 디코이

```sh
npm run demo:mcp
curl -s http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"export_customer_records","arguments":{}}}'
```

로컬 Node HTTP 예제는 `POST /mcp`에서 최소 JSON-RPC `initialize`, `tools/list`, `tools/call`을 구현합니다. `echo`와 `get_time`은 무해한 실제 도구입니다. 목록에 있는 `export_customer_records` 디코이를 호출하면 일반 알림 파이프라인을 통해 `decoy.id: "MCP"`가 포함된 `decoy_hit`가 발생하고 JSON-RPC 권한 오류가 반환됩니다. 어떠한 업무 작업도 실행하지 않으며 레코드, 비밀, 카나리아도 반환하지 않습니다. 실제 도구 호출은 여전히 알림만 수행하며, 도구 인수에 대한 일반적인 비활성 카나리아 재사용 탐지도 포함합니다.

루트는 `mcpDecoyTools`, `inspectMcpRequest(guard, request, toolName?)`, `lintMcpDecoyDescription`을 내보냅니다. 유계 파싱 후에 헬퍼를 한 번 호출하고, 도구 이름은 `tools/call`일 때만 전달하세요. `crawler_bypass`는 호스트 고유의 404로 처리하세요. 이 예제는 발견 단계에도 이를 적용하므로, 검증된 크롤러는 디코이 도구를 보지 못합니다. 모든 MCP JSON 응답은 noindex/no-store입니다. 내장 설명은 중립 데이터이며, 테스트는 명령형 표현, URL, 숨은 문자를 거부합니다. 이 예제는 제한된 HTTP 시나리오이며, 완전한 MCP Streamable HTTP, 세션, SSE 지원은 포함하지 않습니다. OWASP MCP01/MCP08 위협 매핑, 스키마 세부 사항, 통합 경계는 [MCP 시나리오 및 안전 규칙（中文）](../scenarios/mcp.md)을 참고하세요.

## GraphQL과 API 전용 시나리오

v0.3a는 `graphqlDecoys()`와 `inspectGraphqlRequest(guard, request)`를 내보냅니다. 반환된 필드/타입 메타데이터를 호스트 스키마에 추가하여 introspection에 `internalAdminUsers`가 나타나게 하고, 유계 본문 파싱 후 실행 전에 한 번 검사하세요. 디코이가 선택되면 `decoy_hit`(`decoy.id: "GQL"`)를 내보내고 noindex/no-store가 포함된 표준 GraphQL `FORBIDDEN` 오류를 반환합니다. 해당 요청에서는 실제 resolver를 실행하지 않습니다. 디코이 자체에도 비활성 오류 resolver를 지정하세요. 실제 쿼리는 통과하며, 잘못되었거나 한도를 넘긴 쿼리는 호스트 검증기가 처리합니다. 검증된 크롤러는 호스트 고유의 404로 진행합니다. [GraphQL 데모](../../examples/graphql-demo/server.ts)를 참고하고 `npm run demo:graphql`을 실행하세요.

HTML이 없는 API는 [API 전용 가이드](../scenarios/api-only.md)를 참고하세요. OpenAPI `example`, 디코이 오류의 `docs_url`, 격리된 `/.well-known/` 파일에 비활성 카나리아를 배치하는 방법과 SDK 및 문서 클라이언트의 오탐 경계를 설명합니다.

## 구성

모든 공개 필드의 기본값은 [src/types.ts](../../src/types.ts)에 문서화되어 있습니다. 필수 필드: `project`, `env`, `mode: 'detect'`, `projectSeed`, 그리고 `canary.secret`/`canary.registry`.

| 옵션 | 기본값 / 동작 |
| --- | --- |
| `canary.prefix` | `AG-CANARY-`; 패턴 `^[A-Z][A-Z0-9]{1,15}-CANARY-$` |
| `canary.registry` | 필수 version-1 객체 또는 JSON 경로; secret은 저장되지 않음 |
| `incident.windowMs` | 900000; 고정 15분 상관관계 창, 0이면 비활성화; 메타데이터만 추가 |
| `decoys.enabled` | D1–D5; `/.env` 별칭, admin 하위 트리, ops notes, OpenAPI, 가짜 로그인 |
| `decoys.basePath` | `/api/internal` |
| `decoys.paths` / `siteName` | 선택적 경로 재정의 / `.invalid` 이메일 도메인 |
| `lures.robots` | `manual`; `append`는 호스트 robots 응답을 보존하고, `off`는 통합을 비활성화 |
| `lures.htmlComment` | `false`; `{ paths: ['/login'] }`로 옵트인; 페이지당 ≤120 bytes |
| `lures.llmsTxt` | `false`; 이미 성공한 응답에만 참조를 추가 |
| `canaryScan.headers` / `query` | 둘 다 `true`; 경로는 항상 스캔 |
| `canaryScan.bodyPaths` / `maxBodyBytes` | `['/login', '/api/auth/*']` / 16384; D5는 항상 스캔 |
| `crawler.verify` / `timeoutMs` / `failOpen` | `true` / 300 / `true` |
| `crawler.resolver` | Node DNS; 오프라인 사용을 위해 `{ reverse, resolve }`를 주입 |
| `crawler.extraSuffixes` / `ipRangesFile` | 선택적 크롤러 계열 접미사 / 오프라인 JSON `{ google: ['CIDR'] }` |
| `allowlist` | 선택적 정확 일치 `ips`, IPv4/IPv6 `cidrs`, `uaPatterns`, 정확 일치 `headerToken` |
| `alerts.adapters` | 기본 전송 대상 없음. webhook, console, Slack, Telegram, Feishu, SMTP/email 어댑터 제공 |
| `alerts.minSeverity` | 디코이/재사용은 `info`; 명시적 값은 probe/discovery 에스컬레이션도 활성화 |
| `alerts.dedupeWindowSec` | 600; 동일 이벤트 + placement/ID + client key |
| `alerts.ratePerMinute` | 채널당 30; 억제된 횟수는 다음 알림 요약으로 이월 |
| `alerts.redactIp` | `true`; 알림에서는 거친 IPv4/IPv6 네트워크 |
| `log.sink` / `level` / `keepIp` | stdout JSONL / `info` / `true` |
| `clientIp` | 소켓 IP; 신뢰할 수 있는 프록시를 검증한 뒤에만 재정의 |
| `onEvent` | 선택적 관찰자; 관찰자/sink 실패는 격리됨 |

`guard.robotsLines()`는 수동 robots 통합을 지원합니다. `guard.htmlCommentFor(path)`는 옵트인 주석 또는 null을 반환합니다. `guard.metrics()`는 요청/이벤트/전달 횟수와 유계의 최근 inspect 타이밍 분위수를 반환합니다. 타이밍 점수는 인스턴스별로 범위가 제한된 관측값입니다. 탐지 점수는 옵트인 trap의 진입 조건에 사용될 수 있습니다. 클라이언트 상태: 50k 항목, 30분 유휴 TTL. 크롤러 캐시: 10k, 양성 24h / 음성 1h. 전달 헤더는 자동으로 신뢰되지 않습니다.

detect 모드에서 D5는 항상 로그인을 거부하며 결정적인 300–600ms 지연을 둡니다. 모든 디코이는 `noindex`, `no-store`, ≤8KiB이며, 기본적으로 `.invalid` 가상 호스트 이름을 사용하며(명시적으로 설정한 자체 호스팅 callback URL은 예외), cookie를 만들거나 인증하거나 업무 서비스를 호출하지 않습니다. 선언된 AI 크롤러의 디코이 적중 심각도는 `info`입니다. detect에서는 디코이 라우트에서 검색 크롤러 DNS 검증을 수행합니다. 옵트인 trap과 callback 핸들러도 검증하여 크롤러를 보호합니다. 오류/시간 초과는 fail open되어 네이티브 404가 됩니다.

## 사건 상관관계와 카나리아 전파 추적

v0.3a는 동일한 `client_key`의 기존 이벤트에 선택적 `incident`를 붙입니다. 필드는 `id`, 순서 있는 `sequence`(예: `robots → D1 → D2`), `first_seen`, `last_seen`, `confidence`입니다. `incident.windowMs` 기본값은 900000(첫 관측부터 고정 15분)이며 0이면 상관관계를 끕니다. 상태는 50k 클라이언트 LRU와 최근 32개 관측으로 제한됩니다. 단일 적중의 반복은 low, 서로 다른 디코이나 발견과 디코이의 조합은 medium, `canary_replay`는 high로 올립니다. 같은 시간 창에서 신뢰도는 내려가지 않습니다. robots 방문은 내부 표식이며 이벤트 타입을 추가하지 않습니다. 공유 네트워크에서는 클라이언트가 합쳐질 수 있습니다. 상관관계는 심각도를 올리지 않습니다. 기본 detect에서는 HTTP 응답과 디코이 결정을 유지하지만, v0.4a 옵트인 trap은 high confidence를 진입 조건으로 사용할 수 있습니다. 검증된 크롤러와 allowlist는 항상 보호됩니다. [trap 모드](../trap-mode.md)를 참고하세요.

재사용 알림은 `canary.id`, `placement`, `env`, `found_in`, `field`를 유지하고 `leaked_at`(배치 위치), `replayed_at`(경로), `dwell_ms`(첫 디코이 전달부터의 시간), `client_keys_seen`(서로 다른 재사용 클라이언트 키 수, 최대 8)을 추가합니다. 반환하는 디코이 본문에 토큰이 있을 때만 전달을 기록하며 HEAD와 크롤러 우회는 제외합니다. 추적은 프로세스 메모리에만 있고 50k 항목 LRU와 24시간 TTL을 사용합니다. 퇴출, 재시작, 내장 디코이 이외의 전달로 시점을 알 수 없으면 `dwell_ms`를 생략합니다. 이 관측은 신원이나 악의의 증거를 확정하지 않습니다.

## 알림과 서명

webhook과 console 외에 `slackAdapter`, `telegramAdapter`, `feishuAdapter`, `smtpAdapter`를 제공합니다. 전송 대상과 자격 증명을 명시적으로 설정해야 하며 기본으로 켜지는 어댑터는 없습니다. 새 런타임 의존성도 없습니다. 새 HTTP 어댑터는 loopback 외에는 HTTPS를 요구하고 리디렉션을 거부합니다. SMTP는 암시적 TLS(465), STARTTLS(587), AUTH PLAIN/LOGIN을 지원합니다. 아래의 큐, 중복 제거, 전송 속도 제한, `close()` 시 전송 완료 대기를 공유합니다.

```ts
import { webhookAdapter, verifyWebhookSignature } from '@imwyvern/agent-guard';
const adapter = webhookAdapter({
  url: 'http://127.0.0.1:4000/events', secret: process.env.AG_WEBHOOK_SECRET!,
  timeoutMs: 5000,
});
// Receiver: verify the ORIGINAL body string before parsing JSON.
const valid = verifyWebhookSignature({
  body: rawBody, timestamp: timestampHeader, signature: signatureHeader,
  secret: process.env.AG_WEBHOOK_SECRET!, toleranceSec: 300,
});
```

HMAC 입력은 `timestamp + '.' + body`이고, 헤더는 `X-AgentGuard-Timestamp`와 `X-AgentGuard-Signature: sha256=<hex>`입니다. 리다이렉트는 거부됩니다. 수신 측은 추가로 이벤트 ID를 중복 제거하여 타임스탬프 창 안의 중복 전달을 거절해야 합니다. 전달은 비동기로 실행되며 워커 8개, 유계 큐, 5s 시도 기한, 재시도 2회를 사용하고, `close()`는 대기 중인 전달을 플러시합니다. 웹훅 전용 기한은 더 짧을 수 있습니다. 알림 기록에는 요청 메타데이터와 카나리아 ID/출처만 들어가며, body나 Cookie/Authorization 값은 절대 포함되지 않습니다. 요약 횟수는 억제된 알림을 나타내며, 백그라운드 타이머가 아니라 다음에 수락된 알림과 함께 방출됩니다. probe/discovery 트래픽은 기본적으로 알림 없이 로그만 남깁니다.

## 카나리아 CLI

```sh
# Set AG_CANARY_SECRET in your environment; never commit it.
node dist/cli/main.js canary new --env demo --placement 'D1:/.env#ADMIN_API_TOKEN'
node dist/cli/main.js canary list
node dist/cli/main.js canary scan ./config
node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
node dist/cli/main.js report --since 7d ./events.jsonl
node dist/cli/main.js lint ./config
```

`agent-guard lint <path>`(또는 위의 빌드된 CLI)는 내장 디코이/lure 출력과 배치 파일에서 명령형 문구, 숨은 문자, 예약되지 않은 URL 호스트, 실제 공급업체 키 접두사를 검사합니다. 위반은 종료 코드 1, 사용법 오류는 2입니다. 배치 안전성 검사이며, 의도치 않은 토큰 유출은 별도로 `canary scan`을 사용하세요.

레지스트리를 만들 때 `canary new`는 `--prefix ACME-CANARY-`와 `--registry <file>`도 받습니다. 정규 접두사나 레지스트리 토큰이 레지스트리/`src/decoys/*.ts` 허용 목록 밖에 나타나면, 스캔은 `file:line`을 출력하고 종료 코드 1로 끝납니다. 사용법 오류는 종료 코드 2입니다. 심볼릭 링크와 `.git`, `node_modules`, `dist`, `coverage`는 건너뜁니다. 문서/테스트에 의도적으로 넣은 예시를 피하려면 대상 구성 디렉터리를 스캔하세요. 레지스트리 정확 일치는 시크릿 교체 후에도 이전 토큰을 허용합니다. `report`는 관측된 이벤트/전달 지연을 요약합니다. FP/탐지율에는 레이블이 붙은 시뮬레이션 세션이 필요합니다.

도입 프로젝트용 CI 단계 예시(빌드된 CLI만 사용):

```yaml
- name: Prevent canaries in real configuration
  run: node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
```

## 데모와 벤치마크

```sh
npm run demo:express
npm run demo:hono
npm run demo:fastify
npm run demo:koa
npm run demo:graphql
npm run demo:mcp
PORT=3001 npm run demo:node
AGENT_GUARD=off npm run demo:express
npm run bench:simulate
npm run bench:exhaust-sim
npm run bench:deception-lint
npm run bench:latency
npm run bench:latency:hr
npm run lhci
npm run bench
```

데모 기본값은 `PORT=3000`, `AGENT_GUARD=on`, 콘솔 알림, 오프라인 주입 DNS입니다. 선택적 `AG_WEBHOOK_URL`은 서명된 웹훅을 추가하고, `AG_WEBHOOK_SECRET`과 `AG_CANARY_SECRET`은 로컬 데모 시크릿을 덮어씁니다. 이러한 데모 기본값은 로컬 연구용입니다.

두 데모는 `/`, `/list`, `/item/:id`, `/login`, `/logout`, `/pricing`, robots/sitemap/정적 콘텐츠, 네이티브 404를 공유합니다. 데모 로그인은 `demo@example.invalid` / `demo-password`를 사용합니다. 벤치마크는 지정된 세션 수와 고정 시드로 두 데모에서 S1–S5를 실행하고, 서명된 알림 도착을 검증하며, 지연 워밍업 + 세 번 실행의 중앙값을 구하고, 50k 클라이언트 메모리를 확인합니다. TCP를 사용할 수 있으면 각 실행마다 autocannon을 30 seconds / 100 connections로 돌립니다. Lighthouse는 로컬 Chrome, `--headless --no-sandbox`, 두 가지 폼 팩터, 다섯 개의 URL, URL/mode/demo마다 다섯 번 실행을 사용합니다.

실행 중인 데모에 대한 빠른 수동 확인(두 번째 터미널):

```sh
PORT=3000 npm run demo:express          # or: npm run demo:node
curl -s -A 'Mozilla/5.0 Chrome/130' http://127.0.0.1:3000/   # real page, no event
TOKEN=$(curl -s http://127.0.0.1:3000/.env | sed -n 's/^ADMIN_API_TOKEN=//p')   # decoy_hit (high)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/internal/admin/users   # canary_replay (critical)
```

데모 터미널은 한 줄 JSON 이벤트와 콘솔 알림을 출력합니다. 모든 토큰은 아무것도 잠금 해제하지 않는 비활성 `AG-CANARY-` 문자열입니다.

v0.2부터 Express, Node, Hono의 기본 AC-10 측정은 `npm run bench:latency:hr`입니다. 격리된 keep-alive 클라이언트/서버, µs 해상도 타이밍, 100/10 connections에서 세 번의 교차 실행, 그리고 코어 inspect ns/op(약 3분)입니다. 임계값은 그대로 Δp50 ≤200 µs, Δp99 ≤1000 µs, 50k-client heap ≤10 MB이며, 지연 합부는 100-connection 행만 결정합니다. [v0.2 결과 및 구성](../bench-v0.2.md)을 참고하세요. 원본 JSON은 `bench/results/latency-hr.json`이며, 과거의 autocannon 보조 증거도 포함합니다. 원래 `bench` 명령은 v0.1 autocannon 게이트를 유지합니다.

측정 게이트 실패는 벤치마크를 0이 아닌 종료 코드로 끝냅니다. `bench:latency`는 각 데모 서버를 자체 자식 프로세스에서 실행하고 autocannon으로 구동합니다(100 connections, 30 s, 3회 실행의 중앙값). 게이트 대상이 아닌 고정 속도 실행과 처리량에서 유도한 요청당 오버헤드 추정치도 기록합니다. Lighthouse 전체 매트릭스에는 약 35분이 필요합니다. 샌드박스가 로컬 소켓을 금지하면, 연구용 하네스는 메모리 Duplex 스트림 위로 실제 HTTP 요청/응답 객체를 사용합니다. TCP 지연은 **검증되지 않음**으로 남습니다. Chrome 시작 실패는 통과가 아니라 **건너뜀**입니다. 정확한 환경 제한은 [벤치마크 보고서](../bench-v0.1.md)와 [구현 노트](../implementation-notes.md)를 참고하세요. 이 라이브러리는 해당 하네스를 포함하지 않습니다.

v0.3b부터 `npm run bench:exhaust-sim`은 스크립트화된 탐욕 agent를 대상으로 유계 미로의 비용비 시뮬레이션을 메모리에서 실행하고, `npm run bench:deception-lint`는 현재 디코이 출력과 결정적 페르소나 프로토타입을 안전 검사합니다. 두 명령은 trap을 켜지 않습니다. v0.4a에는 별도로 옵트인 trap과 실험적 미로가 구현되어 있습니다. [v0.3b 오프라인 평가](../bench-v0.3b.md)를 참고하세요.

## 이것이 아닌 것

WAF, DDoS 방어, 인증 시스템이나 범용 봇 차단기가 아닙니다. 패치, 최소 권한, 비밀 위생을 대체하지 않습니다. 이 연구 프로젝트는 프로덕션 배포를 제공하지 않으며 검색 엔진의 동작을 보장하지 않습니다.

호스트 수준 honeyfile과 「가짜 성공」 기만은 계획 중이며 아직 제공되지 않습니다. 공격자의 토큰 소모는 입증되지 않았습니다. [포지셔닝](../positioning.md)과 위의 [로드맵 목록](#로드맵-앞으로의-방향)을 참고하세요.

리버스 프롬프트 인젝션 / counter-injection(E4)은 제품에 절대 포함하지 않습니다. 외부 프로빙이나 guard가 제3자에게 먼저 보내는 콜백은 수행하지 않습니다. 운영자가 설정한 알림 어댑터만 외부 알림 전송의 예외이며, 기존 크롤러 신원 확인용 DNS 검증은 유지합니다. 카나리아는 비활성 HMAC 토큰이며 실제 벤더 자격 증명을 사용하지 않습니다. 제3자 honeytoken 서비스(Canarytokens 등)를 사용하지 않으며 콜백 카나리아는 운영자가 직접 호스팅해야 합니다.

Edge 어댑터(Cloudflare Workers, Next.js middleware, Deno, Bun, Vercel Edge)는 **이번 릴리스에 포함되지 않습니다**. Web 표준 코어와 함께 다음 작업인 **v0.4b**로 남아 있습니다. Hono는 이미 **Node ≥20**에서 지원됩니다.

v0.4a는 다음 연동과 제어를 **명시적 옵트인, 기본 꺼짐**으로 제공합니다. 기본 모드는 여전히 `mode: 'detect'`입니다.

- Slack, Telegram, Feishu, SMTP/email 알림 어댑터. 새 런타임 의존성이 없으며 기본 전송 대상도 없습니다.
- `guard.prometheusText()` / `prometheusHandler(guard)` 텍스트 내보내기. 엔드포인트는 자동으로 등록되지 않으며 경로 label이 없습니다.
- `mode: 'trap'`과 독립적으로 켜는 `delay`, `rateLimit`, `block`, **실험적** `maze`. 검증된 크롤러와 allowlist는 trap 대상이 되지 않습니다.
- `canary.callback.baseUrl` + `callbackHandler(guard)`를 통한 자체 호스팅 콜백 카나리아. 핸들러는 명시적으로 등록해야 하며 guard는 `baseUrl`을 fetch하지 않습니다.

기계적인 요청 간격을 나타내는 `automation_score`도 구현되어 있지만 관측용입니다. 심각도를 올리거나 단독으로 block/maze를 실행하지 않습니다. 현재 코드는 충분한 표본이 모이면 자동으로 점수를 산출하며 별도의 활성화 플래그는 없습니다.

**실험적 미로**는 운영자가 실제 agent로 직접 측정한 뒤에야 활성화를 고려해야 합니다. [v0.3b 오프라인 시뮬레이션](../bench-v0.3b.md)에서 스크립트 agent의 시간 비율은 **25 ms/request** 모델에서 수백 대 일이었지만, **바이트 비율은 1:1로 하한인 3:1에 미치지 못했습니다**. 실제 agent의 비용 절감이 입증된 것은 아닙니다. [trap 설정과 위험](../trap-mode.md), [Exhaust](../exhaust.md)를 참고하세요.

## 로드맵 및 설계 문서

- [포지셔닝](../positioning.md) — 취지, 범위 경계, 정직한 주장 표(주장 / 상태 / 근거).
- [커뮤니티](../community.md) — 어댑터, 탐지 시그니처, 번역, RFC 기여 방법.
- [로드맵](../roadmap.md) — 진행 방향, v0.4a 완료 항목, v0.4b Edge 계획. persona/deception 확장은 설계 단계입니다.
- [Exhaust](../exhaust.md) — 구현된 옵트인 지연과 실험적 미로. 컨텍스트 소모(E3)는 아직 구현되지 않았습니다. 토큰 소모는 입증되지 않았습니다.
- [Deception](../deception.md) — 디코이 데이터의 신뢰도를 높여 공격자의 agent가 이를 실제 데이터로 여길 수 있게 합니다. 「가짜 성공」은 계획 중이며 아직 제공되지 않습니다.
- [설계](../design.md), [계약](../codex-contract.md), [KPI](../kpi.md), [위협 모델](../threat-model.md). 선행 사례는 개념만 참고했으며, 제3자 프로젝트 코드는 복사하지 않았습니다.
