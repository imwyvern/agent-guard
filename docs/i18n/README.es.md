# agent-guard

[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

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

El adaptador Hono de v0.2 está disponible como `@imwyvern/agent-guard/hono`, con un peer `hono` opcional. Requiere Node ≥20: el núcleo compartido sigue usando `node:crypto` y el DNS de Node. Los runtimes edge y un núcleo WebCrypto son trabajo de la hoja de ruta para v0.3.

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

La detección sigue siendo solo de alerta: la reutilización de canarios continúa hacia el anfitrión, los señuelos llevan cabeceras noindex/no-store, y los rastreadores verificados llegan al manejador nativo de ruta inexistente del anfitrión. Las transformaciones opt-in de robots/HTML/llms conservan el tope de búfer existente de 1 MiB. Ejecute `npm run demo:hono` (`PORT` y `AGENT_GUARD=off` funcionan como en las demás demos del catálogo). Hono ejecuta la misma suite de aceptación compartida que Express y Node.

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

## Configuración

Todos los campos públicos tienen valores por defecto documentados en [src/types.ts](../../src/types.ts). Campos obligatorios: `project`, `env`, `mode: 'detect'`, `projectSeed`, y `canary.secret`/`canary.registry`.

| Opción | Valor por defecto / comportamiento |
| --- | --- |
| `canary.prefix` | `AG-CANARY-`; patrón `^[A-Z][A-Z0-9]{1,15}-CANARY-$` |
| `canary.registry` | Objeto version-1 obligatorio o ruta JSON; no se almacena ningún secret en él |
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
| `alerts.adapters` | Sin destinos por defecto; están disponibles `webhookAdapter()` y `consoleAdapter()` |
| `alerts.minSeverity` | `info` para señuelo/reutilización; un valor explícito también habilita la escalada de probe/discovery |
| `alerts.dedupeWindowSec` | 600; mismo evento + placement/ID + client key |
| `alerts.ratePerMinute` | 30 por canal; los recuentos suprimidos se trasladan al siguiente resumen de alerta |
| `alerts.redactIp` | `true`; redes IPv4/IPv6 gruesas en las alertas |
| `log.sink` / `level` / `keepIp` | stdout JSONL / `info` / `true` |
| `clientIp` | IP del socket; sobrescriba solo después de validar un proxy de confianza |
| `onEvent` | Observador opcional; los fallos del observador/sink se aíslan |

`guard.robotsLines()` admite la integración manual de robots. `guard.htmlCommentFor(path)` devuelve el comentario opt-in o null. `guard.metrics()` devuelve recuentos de peticiones/eventos/entrega y cuantiles acotados de temporización reciente de inspect. Las puntuaciones son observaciones acotadas por instancia, nunca un mecanismo de imposición. Estado del cliente: 50k entradas, TTL de inactividad de 30 minutos; caché de rastreadores: 10k, positivo 24h / negativo 1h. Ninguna cabecera reenviada se considera de confianza de forma automática.

D5 siempre deniega el inicio de sesión con un retraso determinista de 300–600ms. Todos los señuelos son `noindex`, `no-store`, ≤8KiB, usan solo nombres de host `.invalid` y nunca crean cookies, autentican ni llaman a servicios de negocio. Los aciertos de señuelo de rastreadores de IA declarados tienen gravedad `info`. Las comprobaciones DNS de rastreadores de búsqueda ocurren solo en las rutas señuelo. Los errores/tiempos de espera fallan de forma abierta hacia un 404 nativo.

## Alertas y firmas

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
```

Al crear un registro, `canary new` también acepta `--prefix ACME-CANARY-` y `--registry <file>`. El escaneo termina con código 1 y `file:line` cuando aparecen prefijos canónicos o tokens del registro fuera de la lista blanca del registro/`src/decoys/*.ts`; los errores de uso terminan con código 2. Se omiten los enlaces simbólicos y `.git`, `node_modules`, `dist`, `coverage`. Examine un directorio de configuración concreto para evitar ejemplos intencionados de documentación/pruebas. Las coincidencias exactas del registro permiten tokens antiguos tras la rotación del secreto. `report` resume los eventos observados y la latencia de entrega; las tasas de FP/detección requieren sesiones de simulación etiquetadas.

Ejemplo de paso de CI en un proyecto que lo adopta (usa solo la CLI ya compilada):

```yaml
- name: Prevent canaries in real configuration
  run: node dist/cli/main.js canary scan ./config --registry agent-guard.canaries.json
```

## Demos y pruebas comparativas

```sh
npm run demo:express
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

Desde v0.3b, `npm run bench:exhaust-sim` ejecuta en memoria una simulación de ratio de coste de un laberinto acotado frente a agentes codiciosos programados, y `npm run bench:deception-lint` examina por seguridad la salida actual de los señuelos y un prototipo de persona determinista. Ningún comando cambia el comportamiento en tiempo de ejecución; `mode` sigue aceptando solo `detect`. Véase la [evaluación fuera de línea de v0.3b](../bench-v0.3b.md).

## Lo que NO es

Un WAF, una defensa DDoS, un sistema de autenticación, un bloqueador de bots, un despliegue en producción ni una garantía del comportamiento de los buscadores. No hay bloqueo automático, limitación de tráfico, modo trap, laberinto, inyección inversa de indicaciones, sondeo de salida, credencial real de un proveedor ni honeytoken de devolución de llamada de terceros. Slack/Telegram/Feishu/email y los adaptadores Edge/Fastify/Hono siguen siendo trabajo futuro. El temporizado mecánico y un endpoint de Prometheus son ideas de diseño opcionales y no están habilitados en v0.1.

## Hoja de ruta y documentos de diseño

- [Hoja de ruta](../roadmap.md) — trabajo previsto para v0.3/v0.4. Exhaust y Deception son borradores de diseño y permanecen desactivados por defecto.
- [Exhaust](../exhaust.md) — imposición de coste acotada (retraso, laberinto, consumo de contexto) sobre sesiones maliciosas confirmadas.
- [Deception](../deception.md) — hacer que los datos señuelo resulten creíbles para que el agente del atacante pueda tratarlos como reales.
- [Diseño](../design.md), [contrato](../codex-contract.md), [KPI](../kpi.md) y [modelo de amenazas](../threat-model.md). El trabajo previo solo informó los conceptos; no se copió código de ningún proyecto de terceros.
