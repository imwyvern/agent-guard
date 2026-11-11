# agent-guard

An AI-agent honeypot middleware for Node and the edge.

(Un middleware honeypot para agentes de IA en Node y el edge.)

[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

## Por qué

- Los agentes de IA y los escáneres exploran las API, leen archivos `.env` y reutilizan las credenciales que encuentran.
- Las rutas señuelo aisladas y las credenciales canario inertes detectan esa exploración y reutilización.
- Por defecto solo detecta y alerta: el middleware registra eventos y envía alertas de forma asíncrona; no bloquea, limita ni toma represalias.
- Cero dependencias de tiempo de ejecución; Express, Hono, Fastify y Koa son peers opcionales. Hoy funciona en Node ≥20; los runtimes de edge están en la hoja de ruta.

**Qué es y qué no es.** agent-guard detecta, atrae y observa el tráfico de agentes de IA hostiles o exploratorios que llegan a tus API. No contraataca ni ataca a nadie. Los no objetivos, las funciones opt-in y sus límites experimentales se explican en [Lo que NO es](#lo-que-no-es).

Middleware HTTP para Node ≥20: cinco rutas señuelo aisladas y credenciales canario inertes detectan la reutilización de credenciales y el escaneo exploratorio. Registra eventos y envía alertas asíncronas. Cero dependencias de runtime; Express es un peer opcional. Apache-2.0, copyright 2026 Wesley Wang.

Este es un proyecto de investigación de código abierto, todavía no publicado en npm. Instálelo desde el código fuente o cree un tarball local con `npm pack`. El nombre de paquete de trabajo es `@imwyvern/agent-guard`.

Consulte la [política de seguridad](../../SECURITY.md), la [guía de contribución](../../CONTRIBUTING.md) y la [hoja de ruta](../roadmap.md).

## Instalación y validación en local

Las herramientas de desarrollo ya están instaladas en este espacio de trabajo. No instale dependencias adicionales aquí.

```sh
npm run build
npm run typecheck
npm run lint          # strict-compiler lint (tsc --noUnusedLocals --noUnusedParameters)
npm test
npm run test:coverage
npm run bench
npm pack --dry-run
```

Para un consumidor local aparte, cree un tarball con `npm pack` e instale `./imwyvern-agent-guard-0.1.0.tgz`. El tarball contiene solo `dist/`, `schema/`, el readme/changelog y los avisos legales. `private: true` impide la publicación.

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

Si usa un nombre de archivo de registro, prepárelo con la CLI. Un registro vacío genera en memoria seis canarios señuelo canónicos. Persista las ubicaciones del registro con la CLI si los tokens deben permanecer estables entre reinicios. La semilla controla datos falsos inofensivos; los ID de canario siguen siendo criptográficamente aleatorios.

## HTTP nativo de Node

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

`inspect(AGRequest)` devuelve `{ action: 'pass', events }` o `{ action: 'respond', response, events }`. Quienes usan el núcleo de forma directa deben gestionar ellos mismos el `404` simple del núcleo. Los adaptadores delegan los rastreadores verificados al anfitrión para preservar su respuesta nativa de ruta inexistente. Reserve las rutas señuelo: desactive o sobrescriba cualquier señuelo que entre en conflicto con una ruta real.

Las transformaciones opt-in de robots/HTML/llms almacenan en búfer como máximo 1 MiB en las rutas seleccionadas; los flujos ordinarios pasan sin alterarse. Instálelas antes de la compresión. Las transformaciones se aplican solo a respuestas correctas y sin comprimir. Solo el comentario HTML de inicio de sesión modifica una página HTML real, cuando está habilitado de forma explícita.

## Hono (runtime de Node)

El adaptador Hono de v0.2 está disponible como `@imwyvern/agent-guard/hono`, con un peer `hono` opcional. Requiere Node ≥20: el núcleo compartido sigue usando `node:crypto` y el DNS de Node. Los runtimes edge y un núcleo WebCrypto quedan pendientes para v0.4b.

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

Instale Hono y su integración de servidor Node en la aplicación consumidora. Este repositorio instala ambos solo como dependencias de desarrollo; el adaptador no añade dependencias de runtime. `agentGuard` acepta un guard o un config, examina los cuerpos elegibles de una petición clonada hasta el tope de cuerpo configurado (16 KiB por defecto) y deja el cuerpo original disponible para los manejadores posteriores. Se admiten cuerpos JSON y de formulario; la entrada malformada o truncada se examina como texto acotado. El anfitrión sigue siendo responsable de los límites de tamaño en el cable y de los plazos de lectura del cuerpo. `@hono/node-server` proporciona la IP del socket; las cabeceras reenviadas requieren una devolución de llamada `clientIp` explícitamente de confianza.

En el modo predeterminado `mode: 'detect'`, la detección sigue siendo solo de alerta: la reutilización de canarios continúa hacia el anfitrión, los señuelos llevan cabeceras noindex/no-store, y los rastreadores verificados llegan al manejador nativo de ruta inexistente del anfitrión. Las transformaciones opt-in de robots/HTML/llms conservan el tope de búfer existente de 1 MiB. Ejecute `npm run demo:hono` (`PORT` y `AGENT_GUARD=off` funcionan como en las demás demos del catálogo). Hono ejecuta la misma suite de aceptación compartida que Express y Node.

## Fastify y Koa (runtime de Node)

v0.3a (sin publicar) añade `agentGuard` en `@imwyvern/agent-guard/fastify` y `@imwyvern/agent-guard/koa`, con el mismo guard o config. Registre el plugin Fastify con `await app.register(agentGuard(guard))` antes de las rutas; inspecciona en `preHandler` después de analizar el cuerpo. En Koa, use `app.use(agentGuard(guard))` después de su analizador de cuerpo acotado. Ninguno consume el flujo de la petición. Ambos preservan los 404 nativos para rastreadores, las alertas de reutilización en modo detect y las transformaciones opt-in; los frameworks son peers opcionales y el núcleo no añade dependencias de runtime. Consulte la [demo Fastify](../../examples/fastify-demo/server.ts), la [demo Koa](../../examples/koa-demo/server.ts) y la [guía de adaptadores](../community.md). Los runtimes edge siguen en la hoja de ruta.

## Señuelo de endpoint de herramientas MCP / LLM

```sh
npm run demo:mcp
curl -s http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"export_customer_records","arguments":{}}}'
```

El ejemplo local de HTTP de Node implementa un JSON-RPC mínimo de `initialize`, `tools/list` y `tools/call` en `POST /mcp`. `echo` y `get_time` son herramientas reales inofensivas. Llamar al señuelo listado `export_customer_records` emite `decoy_hit` con `decoy.id: "MCP"` a través de la canalización normal de alertas y devuelve un error de permiso JSON-RPC. No ejecuta ninguna operación de negocio y no devuelve registros, secretos ni canarios. Las llamadas a herramientas reales siguen siendo solo de alerta, incluida la detección normal de reutilización de canarios inertes en los argumentos de la herramienta.

La raíz exporta `mcpDecoyTools`, `inspectMcpRequest(guard, request, toolName?)` y `lintMcpDecoyDescription`. Llame al ayudante una vez después del análisis acotado, pasando un nombre de herramienta solo para `tools/call`; trate `crawler_bypass` como el 404 nativo del anfitrión. El ejemplo también aplica esto al descubrimiento, de modo que los rastreadores verificados nunca vean las herramientas señuelo. Todas las respuestas JSON de MCP son noindex/no-store. Las descripciones integradas son datos neutrales, y las pruebas rechazan el lenguaje imperativo, las URL y los caracteres ocultos. Este ejemplo es un escenario HTTP limitado, sin compatibilidad completa con MCP Streamable HTTP, sesiones o SSE. Consulte [escenario MCP y reglas de seguridad（中文）](../scenarios/mcp.md) para el mapeo de amenazas OWASP MCP01/MCP08, los detalles del esquema y los límites de integración.

## Escenarios GraphQL y solo API

v0.3a exporta `graphqlDecoys()` e `inspectGraphqlRequest(guard, request)`. Añada los metadatos de campos/tipos al esquema anfitrión para que la introspección liste `internalAdminUsers`, e inspeccione una vez tras analizar el cuerpo acotado y antes de ejecutarlo. Seleccionar un señuelo emite `decoy_hit` con `decoy.id: "GQL"` y devuelve un error GraphQL estándar `FORBIDDEN` con noindex/no-store; esa petición no ejecuta resolvers reales. Asigne también al señuelo su propio resolver de error inerte. Las consultas reales pasan; las malformadas o excesivas van al validador anfitrión. Los rastreadores verificados llegan al 404 nativo. Consulte la [demo GraphQL](../../examples/graphql-demo/server.ts) y ejecute `npm run demo:graphql`.

Para API sin HTML, consulte la [guía solo API](../scenarios/api-only.md): canarios inertes en OpenAPI `example`, `docs_url` de errores señuelo y archivos aislados `/.well-known/`, con límites de falsos positivos para SDK y clientes de documentación.

## Configuración

Todos los campos públicos tienen valores por defecto documentados en [src/types.ts](../../src/types.ts). Campos obligatorios: `project`, `env`, `mode: 'detect'`, `projectSeed`, y `canary.secret`/`canary.registry`.

| Opción | Valor por defecto / comportamiento |
| --- | --- |
| `canary.prefix` | `AG-CANARY-`; patrón `^[A-Z][A-Z0-9]{1,15}-CANARY-$` |
| `canary.registry` | Objeto version-1 obligatorio o ruta JSON; no se almacena ningún secret en él |
| `incident.windowMs` | 900000; ventana fija de correlación de 15 minutos, 0 desactiva; solo metadatos |
| `decoys.enabled` | D1–D5; alias de `/.env`, subárbol admin, ops notes, OpenAPI, inicio de sesión falso |
| `decoys.basePath` | `/api/internal` |
| `decoys.paths` / `siteName` | Sustituciones opcionales de ruta / dominio de correo `.invalid` |
| `lures.robots` | `manual`; `append` conserva la respuesta robots del anfitrión, `off` desactiva la integración |
| `lures.htmlComment` | `false`; `{ paths: ['/login'] }` lo activa; ≤120 bytes/página |
| `lures.llmsTxt` | `false`; añade una referencia solo a una respuesta correcta existente |
| `canaryScan.headers` / `query` | Ambos `true`; las rutas se examinan siempre |
| `canaryScan.bodyPaths` / `maxBodyBytes` | `['/login', '/api/auth/*']` / 16384; D5 se examina siempre |
| `crawler.verify` / `timeoutMs` / `failOpen` | `true` / 300 / `true` |
| `crawler.resolver` | DNS de Node; inyecte `{ reverse, resolve }` para uso sin conexión |
| `crawler.extraSuffixes` / `ipRangesFile` | Sufijos opcionales de familia de rastreadores / JSON sin conexión `{ google: ['CIDR'] }` |
| `allowlist` | Opcionales: `ips` exactas, `cidrs` IPv4/IPv6, `uaPatterns`, `headerToken` exacto |
| `alerts.adapters` | Sin destinos predeterminados; adaptadores webhook, console, Slack, Telegram, Feishu y SMTP/email disponibles |
| `alerts.minSeverity` | `info` para señuelo/reutilización; un valor explícito también habilita la escalada de probe/discovery |
| `alerts.dedupeWindowSec` | 600; mismo evento + placement/ID + client key |
| `alerts.ratePerMinute` | 30 por canal; los recuentos suprimidos se trasladan al siguiente resumen de alerta |
| `alerts.redactIp` | `true`; redes IPv4/IPv6 gruesas en las alertas |
| `log.sink` / `level` / `keepIp` | stdout JSONL / `info` / `true` |
| `clientIp` | IP del socket; sobrescriba solo después de validar un proxy de confianza |
| `onEvent` | Observador opcional; los fallos del observador/sink se aíslan |

`guard.robotsLines()` admite la integración manual de robots. `guard.htmlCommentFor(path)` devuelve el comentario opt-in o null. `guard.metrics()` devuelve recuentos de peticiones/eventos/entrega y cuantiles acotados de temporización reciente de inspect. Las puntuaciones de temporización son observaciones acotadas por instancia; las de detección pueden satisfacer los criterios del trap opt-in. Estado del cliente: 50k entradas, TTL de inactividad de 30 minutos; caché de rastreadores: 10k, positivo 24h / negativo 1h. Ninguna cabecera reenviada se considera de confianza de forma automática.

En modo detect, D5 siempre deniega el inicio de sesión con un retraso determinista de 300–600ms. Todos los señuelos son `noindex`, `no-store`, ≤8KiB, usan nombres de host ficticios `.invalid` por defecto (excepto la URL de callback autoalojada que se configure explícitamente) y nunca crean cookies, autentican ni llaman a servicios de negocio. Los aciertos de señuelo de rastreadores de IA declarados tienen gravedad `info`. En detect, las verificaciones DNS de rastreadores se realizan en las rutas señuelo; trap y el manejador de callback opt-in amplían la verificación para mantener su inmunidad. Los errores/tiempos de espera fallan de forma abierta hacia un 404 nativo.

## Correlación de incidentes y seguimiento de propagación

v0.3a adjunta metadatos `incident` opcionales a los eventos existentes del mismo `client_key`: `id`, `sequence` ordenada (por ejemplo `robots → D1 → D2`), `first_seen`, `last_seen` y `confidence`. `incident.windowMs` vale 900000 por defecto (15 minutos fijos desde la primera observación); 0 desactiva la correlación. El estado usa una LRU de 50k clientes y conserva las últimas 32 observaciones. Los aciertos aislados repetidos tienen confianza low; distintos señuelos o descubrimiento más un señuelo la elevan a medium; `canary_replay` la eleva a high. La confianza no baja dentro de la ventana. Las visitas a robots son marcas internas y no añaden tipos de evento. Las redes compartidas pueden agrupar clientes; la correlación no eleva la gravedad. En el modo detect predeterminado conserva las respuestas HTTP y las decisiones sobre señuelos; trap opt-in de v0.4a puede usar high confidence como criterio de entrada. Los rastreadores verificados y las listas de permitidos conservan su inmunidad. Consulte el [modo trap](../trap-mode.md).

Las alertas de reutilización conservan `canary.id`, `placement`, `env`, `found_in` y `field`, añadiendo `leaked_at` (ubicación), `replayed_at` (ruta), `dwell_ms` (tiempo desde la primera entrega del señuelo) y `client_keys_seen` (claves distintas de clientes que reutilizan el token, máximo 8). Solo se registra la entrega si el cuerpo señuelo devuelto contiene el token; HEAD y bypass de rastreadores no cuentan. El seguimiento vive en memoria del proceso, con una LRU de 50k entradas y TTL de 24 horas. La expulsión, el reinicio o la entrega fuera de señuelos integrados dejan el momento desconocido, por lo que se omite `dwell_ms`. Estas observaciones no prueban identidad ni intención maliciosa.

## Alertas y firmas

Además de webhook y console, se incluyen `slackAdapter`, `telegramAdapter`, `feishuAdapter` y `smtpAdapter`. Configure los destinos y las credenciales explícitamente; ninguno se activa por defecto y no añaden dependencias de runtime. Los nuevos adaptadores HTTP exigen HTTPS salvo en loopback y rechazan redirecciones; SMTP admite TLS implícito (465), STARTTLS (587) y AUTH PLAIN/LOGIN. Comparten la cola, deduplicación, límites de envío y vaciado con `close()` descritos a continuación.

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

La entrada HMAC es `timestamp + '.' + body`; las cabeceras son `X-AgentGuard-Timestamp` y `X-AgentGuard-Signature: sha256=<hex>`. Los redireccionamientos se rechazan. El receptor debería además deduplicar los ID de evento para rechazar entregas duplicadas dentro de la ventana de marca de tiempo. La entrega se ejecuta de forma asíncrona con ocho trabajadores, una cola acotada, un plazo de intento de 5s y dos reintentos; `close()` vacía las entregas pendientes. Los plazos específicos del webhook pueden ser más cortos. Los registros de alerta contienen solo metadatos de la petición y el ID/procedencia del canario, nunca el body ni valores de Cookie/Authorization. Los recuentos de resumen representan notificaciones suprimidas y se emiten con la siguiente alerta admitida, no con un temporizador en segundo plano. El tráfico de probe/discovery se registra sin alertar por defecto.

## CLI de canarios

```sh
# Set AG_CANARY_SECRET in your environment; never commit it.
node dist/cli/main.js canary new --env demo --placement 'D1:/.env#ADMIN_API_TOKEN'
node dist/cli/main.js canary list
node dist/cli/main.js canary scan ./config
node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
node dist/cli/main.js report --since 7d ./events.jsonl
node dist/cli/main.js lint ./config
```

`agent-guard lint <path>` (o la CLI compilada de arriba) comprueba las salidas señuelo/lure integradas y los archivos de ubicación: lenguaje imperativo, caracteres ocultos, hosts URL no reservados y prefijos de claves reales de proveedores. Los hallazgos salen con código 1; los errores de uso, con 2. Comprueba la seguridad de la ubicación; use `canary scan` por separado para detectar fugas accidentales de tokens.

Al crear un registro, `canary new` también acepta `--prefix ACME-CANARY-` y `--registry <file>`. El escaneo termina con código 1 y `file:line` cuando aparecen prefijos canónicos o tokens del registro fuera de la lista blanca del registro/`src/decoys/*.ts`; los errores de uso terminan con código 2. Se omiten los enlaces simbólicos y `.git`, `node_modules`, `dist`, `coverage`. Examine un directorio de configuración concreto para evitar ejemplos intencionados de documentación/pruebas. Las coincidencias exactas del registro permiten tokens antiguos tras la rotación del secreto. `report` resume los eventos observados y la latencia de entrega; las tasas de FP/detección requieren sesiones de simulación etiquetadas.

Ejemplo de paso de CI en un proyecto que lo adopta (usa solo la CLI ya compilada):

```yaml
- name: Prevent canaries in real configuration
  run: node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
```

## Demos y pruebas comparativas

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

Las demos usan por defecto `PORT=3000`, `AGENT_GUARD=on`, alertas en consola y DNS inyectado sin conexión. El `AG_WEBHOOK_URL` opcional añade el webhook firmado; `AG_WEBHOOK_SECRET` y `AG_CANARY_SECRET` sustituyen los secretos locales de la demo. Estos valores por defecto de las demos son para investigación local.

Ambas demos comparten `/`, `/list`, `/item/:id`, `/login`, `/logout`, `/pricing`, contenido robots/sitemap/estático y el 404 nativo. El inicio de sesión de la demo usa `demo@example.invalid` / `demo-password`. La prueba comparativa ejecuta S1–S5 en ambas demos con los recuentos de sesión indicados y una semilla fija, valida la llegada de alertas firmadas, ejecuta un calentamiento de latencia + la mediana de tres ejecuciones y comprueba la memoria de 50k clientes. Si hay TCP disponible, ejecuta autocannon durante 30 seconds / 100 connections por ejecución. Lighthouse usa Chrome local, `--headless --no-sandbox`, ambos factores de forma, cinco URL y cinco ejecuciones por URL/mode/demo.

Comprobación manual rápida contra una demo en ejecución (segunda terminal):

```sh
PORT=3000 npm run demo:express          # or: npm run demo:node
curl -s -A 'Mozilla/5.0 Chrome/130' http://127.0.0.1:3000/   # real page, no event
TOKEN=$(curl -s http://127.0.0.1:3000/.env | sed -n 's/^ADMIN_API_TOKEN=//p')   # decoy_hit (high)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/internal/admin/users   # canary_replay (critical)
```

La terminal de la demo imprime eventos JSON de una línea y alertas de consola. Todos los tokens son cadenas inertes `AG-CANARY-` que no desbloquean nada.

Desde v0.2, `npm run bench:latency:hr` es la medición principal de AC-10 para Express, Node y Hono: clientes/servidores keep-alive aislados, temporización con resolución de µs, tres ejecuciones intercaladas a 100/10 connections, e inspect del núcleo en ns/op (unos 3 minutos). Los umbrales siguen siendo Δp50 ≤200 µs, Δp99 ≤1000 µs y heap de 50k-client ≤10 MB; solo la fila de 100-connection decide la latencia. Véase [resultados y configuración de v0.2](../bench-v0.2.md); el JSON en bruto es `bench/results/latency-hr.json`, e incluye evidencia secundaria histórica de autocannon. El comando `bench` original conserva su umbral autocannon de v0.1.

Los fallos medidos del umbral producen una salida distinta de cero de la prueba comparativa. `bench:latency` ejecuta cada servidor de demo en su propio proceso hijo y lo impulsa con autocannon (100 connections, 30 s, mediana de 3 ejecuciones); también registra una ejecución de tasa fija que no actúa como umbral y una estimación de sobrecarga por petición derivada del rendimiento. Lighthouse necesita unos 35 minutos para la matriz completa. Si un entorno aislado prohíbe los sockets locales, el arnés de investigación usa objetos reales de petición/respuesta HTTP sobre flujos Duplex en memoria; la latencia TCP permanece **sin validar**. Los fallos de arranque de Chrome se **omiten**, no se dan por superados. Véase el [informe de pruebas comparativas](../bench-v0.1.md) y las [notas de implementación](../implementation-notes.md) para las limitaciones exactas del entorno. La biblioteca no incluye este arnés.

Desde v0.3b, `npm run bench:exhaust-sim` ejecuta en memoria una simulación de ratio de coste de un laberinto acotado frente a agentes codiciosos programados, y `npm run bench:deception-lint` examina por seguridad la salida actual de los señuelos y un prototipo de persona determinista. Ningún comando activa trap; v0.4a incluye por separado el modo trap opt-in y un laberinto experimental. Véase la [evaluación fuera de línea de v0.3b](../bench-v0.3b.md).

## Lo que NO es

No es un WAF, una defensa DDoS, un sistema de autenticación ni un bloqueador general de bots. Este proyecto de investigación no proporciona un despliegue en producción ni garantiza el comportamiento de los buscadores.

La inyección inversa de prompts / contrainyección (E4) nunca formará parte del producto. No realiza sondeos de salida ni inicia callbacks hacia terceros; los adaptadores de alertas configurados por el operador son la única excepción para notificaciones salientes. Se mantienen las verificaciones DNS de identidad de los rastreadores. Los canarios son tokens HMAC inertes, nunca credenciales reales de proveedores. No se usa ningún servicio de honeytokens de terceros (Canarytokens, etc.); el canario de callback solo se aloja en infraestructura del operador.

Los adaptadores Edge (Cloudflare Workers, Next.js middleware, Deno, Bun y Vercel Edge) **no están en esta entrega**; quedan para el siguiente lote, **v0.4b**, junto con el núcleo basado en estándares web. Hono ya está disponible para **Node ≥20**.

v0.4a incluye estas integraciones y controles **opt-in, desactivados por defecto**. El modo predeterminado sigue siendo `mode: 'detect'`:

- Adaptadores de alertas Slack, Telegram, Feishu y SMTP/email, sin nuevas dependencias de runtime ni destinos predeterminados.
- Exportación de texto mediante `guard.prometheusText()` / `prometheusHandler(guard)`: ningún endpoint se monta automáticamente y no hay etiquetas de rutas.
- `mode: 'trap'` con interruptores independientes para `delay`, `rateLimit`, `block` y `maze` **experimental**. Los rastreadores verificados y las listas de permitidos nunca quedan sujetos a trap.
- Canarios de callback autoalojados mediante `canary.callback.baseUrl` + `callbackHandler(guard)`. El manejador debe montarse explícitamente; el guard nunca hace fetch de `baseUrl`.

También se incluye `automation_score` para observar la regularidad mecánica de las peticiones: nunca eleva la gravedad ni activa block/maze por sí solo. El código actual recopila intervalos automáticamente y calcula la puntuación cuando hay suficientes muestras, sin un interruptor de activación independiente.

El **laberinto experimental** requiere mediciones del operador con agentes reales antes de activarse. En la [simulación fuera de línea de v0.3b](../bench-v0.3b.md), los agentes programados mostraron ratios de tiempo de cientos a uno bajo un modelo de **25 ms/petición**, pero el **ratio de bytes fue 1:1, por debajo del mínimo de 3:1**. Esto no demuestra un ahorro de costes con agentes reales. Consulte [controles y riesgos de trap](../trap-mode.md) y [Exhaust](../exhaust.md).

## Hoja de ruta y documentos de diseño

- [Comunidad](../community.md) — cómo contribuir adaptadores, firmas de detección, traducciones y RFC.
- [Hoja de ruta](../roadmap.md) — elementos completados en v0.4a y planes Edge para v0.4b; las extensiones persona/deception siguen en diseño.
- [Exhaust](../exhaust.md) — retraso opt-in y laberinto experimental ya implementados; el consumo de contexto (E3) sigue sin implementarse.
- [Deception](../deception.md) — hacer que los datos señuelo resulten creíbles para que el agente del atacante pueda tratarlos como reales.
- [Diseño](../design.md), [contrato](../codex-contract.md), [KPI](../kpi.md) y [modelo de amenazas](../threat-model.md). El trabajo previo solo informó los conceptos; no se copió código de ningún proyecto de terceros.
