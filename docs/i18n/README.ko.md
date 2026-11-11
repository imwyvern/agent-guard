# agent-guard

[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

Node ≥20용 HTTP 미들웨어입니다. 격리된 다섯 개의 디코이 라우트와 비활성 카나리아 자격 증명으로 자격 증명 재사용(replay)과 탐색적 스캔을 탐지합니다. 이벤트를 기록하고 비동기로 알림을 보냅니다. 런타임 의존성은 없으며, Express는 선택적 peer입니다. Apache-2.0, 저작권 2026 Wesley Wang.

이것은 오픈소스 연구 프로젝트이며 아직 npm에 게시되지 않았습니다. 소스에서 설치하거나 `npm pack`으로 로컬 tarball을 만드세요. 작업 중인 패키지 이름은 `@imwyvern/agent-guard`입니다.

[보안 정책](../../SECURITY.md), [기여 가이드](../../CONTRIBUTING.md), [로드맵](../roadmap.md)을 참고하세요.

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

v0.2 Hono 어댑터는 `@imwyvern/agent-guard/hono`로 제공되며, 선택적 `hono` peer를 가집니다. Node ≥20이 필요합니다. 공유 코어는 여전히 `node:crypto`와 Node DNS를 사용합니다. 에지 런타임과 WebCrypto 코어는 로드맵의 v0.3 작업입니다.

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

탐지는 여전히 알림만 수행합니다. 카나리아 재사용은 호스트로 계속 진행되고, 디코이에는 noindex/no-store 헤더가 붙으며, 검증된 크롤러는 호스트 고유의 없는 라우트 핸들러에 도달합니다. 옵트인 robots/HTML/llms 변환은 기존 1 MiB 버퍼 상한을 유지합니다. `npm run demo:hono`를 실행하세요(`PORT`와 `AGENT_GUARD=off`는 다른 카탈로그 데모와 동일하게 동작합니다). Hono는 Express 및 Node와 동일한 공유 인수 테스트 스위트를 실행합니다.

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

## 구성

모든 공개 필드의 기본값은 [src/types.ts](../../src/types.ts)에 문서화되어 있습니다. 필수 필드: `project`, `env`, `mode: 'detect'`, `projectSeed`, 그리고 `canary.secret`/`canary.registry`.

| 옵션 | 기본값 / 동작 |
| --- | --- |
| `canary.prefix` | `AG-CANARY-`; 패턴 `^[A-Z][A-Z0-9]{1,15}-CANARY-$` |
| `canary.registry` | 필수 version-1 객체 또는 JSON 경로; secret은 저장되지 않음 |
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
| `alerts.adapters` | 기본 대상 없음; `webhookAdapter()`와 `consoleAdapter()` 사용 가능 |
| `alerts.minSeverity` | 디코이/재사용은 `info`; 명시적 값은 probe/discovery 에스컬레이션도 활성화 |
| `alerts.dedupeWindowSec` | 600; 동일 이벤트 + placement/ID + client key |
| `alerts.ratePerMinute` | 채널당 30; 억제된 횟수는 다음 알림 요약으로 이월 |
| `alerts.redactIp` | `true`; 알림에서는 거친 IPv4/IPv6 네트워크 |
| `log.sink` / `level` / `keepIp` | stdout JSONL / `info` / `true` |
| `clientIp` | 소켓 IP; 신뢰할 수 있는 프록시를 검증한 뒤에만 재정의 |
| `onEvent` | 선택적 관찰자; 관찰자/sink 실패는 격리됨 |

`guard.robotsLines()`는 수동 robots 통합을 지원합니다. `guard.htmlCommentFor(path)`는 옵트인 주석 또는 null을 반환합니다. `guard.metrics()`는 요청/이벤트/전달 횟수와 유계의 최근 inspect 타이밍 분위수를 반환합니다. 점수는 인스턴스별 유계 관측값이며, 강제에는 쓰이지 않습니다. 클라이언트 상태: 50k 항목, 30분 유휴 TTL. 크롤러 캐시: 10k, 양성 24h / 음성 1h. 전달 헤더는 자동으로 신뢰되지 않습니다.

D5는 항상 로그인을 거부하며 결정적인 300–600ms 지연을 둡니다. 모든 디코이는 `noindex`, `no-store`, ≤8KiB이며, `.invalid` 호스트 이름만 사용하고, cookie를 만들거나 인증하거나 업무 서비스를 호출하지 않습니다. 선언된 AI 크롤러의 디코이 적중 심각도는 `info`입니다. 검색 크롤러 DNS 검사는 디코이 라우트에서만 수행됩니다. 오류/시간 초과는 fail open되어 네이티브 404가 됩니다.

## 알림과 서명

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
```

레지스트리를 만들 때 `canary new`는 `--prefix ACME-CANARY-`와 `--registry <file>`도 받습니다. 정규 접두사나 레지스트리 토큰이 레지스트리/`src/decoys/*.ts` 허용 목록 밖에 나타나면, 스캔은 `file:line`을 출력하고 종료 코드 1로 끝납니다. 사용법 오류는 종료 코드 2입니다. 심볼릭 링크와 `.git`, `node_modules`, `dist`, `coverage`는 건너뜁니다. 문서/테스트에 의도적으로 넣은 예시를 피하려면 대상 구성 디렉터리를 스캔하세요. 레지스트리 정확 일치는 시크릿 교체 후에도 이전 토큰을 허용합니다. `report`는 관측된 이벤트/전달 지연을 요약합니다. FP/탐지율에는 레이블이 붙은 시뮬레이션 세션이 필요합니다.

도입 프로젝트용 CI 단계 예시(빌드된 CLI만 사용):

```yaml
- name: Prevent canaries in real configuration
  run: node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
```

## 데모와 벤치마크

```sh
npm run demo:express
PORT=3001 npm run demo:node
AGENT_GUARD=off npm run demo:express
npm run bench:simulate
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

## 이것이 아닌 것

WAF, DDoS 방어, 인증 시스템, 봇 차단기, 프로덕션 배포, 검색 엔진 동작에 대한 보장이 아닙니다. 자동 차단, 트래픽 제한, trap 모드, 미로, 리버스 프롬프트 인젝션, 외부 프로빙, 실제 벤더 자격 증명, 제3자 콜백 honeytoken은 없습니다. Slack/Telegram/Feishu/email과 Edge/Fastify/Hono 어댑터는 이후 작업으로 남아 있습니다. 기계적 타이밍과 Prometheus 엔드포인트는 선택적 설계 아이디어이며 v0.1에서는 활성화되어 있지 않습니다.

[설계](../design.md), [계약](../codex-contract.md), [KPI](../kpi.md), [위협 모델](../threat-model.md)을 참고하세요. 선행 사례는 개념만 참고했으며, 제3자 프로젝트 코드는 복사하지 않았습니다.
