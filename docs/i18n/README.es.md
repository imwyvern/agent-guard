# agent-guard

An AI-agent honeypot middleware for Node and the edge.

(Un middleware honeypot para agentes de IA en Node y el edge.)

[English](../../README.md) | [简体中文](../i18n/README.zh-CN.md) | [繁體中文](../i18n/README.zh-TW.md) | [日本語](../i18n/README.ja.md) | [한국어](../i18n/README.ko.md) | [Español](../i18n/README.es.md)

## Por qué

Los atacantes usan agentes de IA para explorar servidores, leer configuraciones y reutilizar las claves que encuentran. agent-guard planta configuraciones, claves y endpoints falsos y aislados —canarios inertes que no desbloquean nada— en la superficie HTTP/API y, opcionalmente, en honeyfiles del host. La reutilización ofrece una señal de alta confianza; las alertas de lectura requieren registros de acceso de Linux aportados por el operador. Las alertas y las líneas de tiempo ayudan a responder: rotar claves, restringir el acceso o detener el host.

Es una última línea de disparo (tripwire) y una capa de alerta temprana / retraso en el servidor. No sustituye al parcheo, a un WAF ni al principio de mínimo privilegio. El modo predeterminado solo detecta y alerta. Un modo trap opcional, desactivado por defecto, puede ralentizar o limitar a un cliente confirmado; no afirma bloquear ataques.

**Lo que se entrega hoy y lo que no.**

- **Hoy** la capa HTTP/API incluye cinco rutas señuelo aisladas, señuelos MCP y GraphQL y credenciales canario inertes (`AG-CANARY-…`). Cero dependencias de runtime; adaptadores para Express, Node `http`, Hono, Fastify y Koa en Node ≥20, más adaptadores Web / Edge desde v0.4b.
- **Los honeyfiles de host están implementados en este árbol v0.5a sin publicar**: `agent-guard seed` muestra por defecto el plan de archivos inertes; `--write` los crea con modo 0600, sin sobrescribir archivos existentes ni seguir rutas o enlaces simbólicos inseguros. El `watch` opcional es un analizador de solo lectura y exclusivo de Linux para registros auditd o `inotifywait -e access` aportados por el operador. El guard no observa lecturas por sí mismo; configurar la fuente puede requerir root, pero el analizador no lo necesita. Sin sondeos salientes. Véase [seed y watch](../seed.md).
- **La ventana de respuesta está implementada en este árbol v0.5a sin publicar**: campos de línea de tiempo, `log.file` opcional y acotado de Node, métricas, `incident list|show|ack` y escalada/recordatorios desactivados por defecto. Los hooks de respuesta de Node son opt-in y ejecutan scripts del operador con argv fijo y un entorno solo de metadatos; Web / Edge no tiene hooks. El guard no rota claves ni cambia cortafuegos. Véase [respuesta a incidentes](../incident-response.md) y los [ejemplos de hooks que solo registran](../examples/hooks/README.md).
- La **decepción de «éxito falso»** —un entorno simulado que puede hacer creer a la IA del atacante que ha comprometido el servidor— sigue **planificada, no implementada**. Requiere evaluación de seguridad y aprobación separada antes de su implementación opt-in. Véase [deception.md](../deception.md).
- **Consumir los tokens del atacante** **aún no está demostrado**. El laberinto experimental tuvo un ratio de bytes de 1:1 en simulación, por debajo del mínimo de 3:1; las cifras de ratio de tiempo corresponden a un modelo de 25 ms/petición, no a una medición con agentes LLM reales. No active el laberinto esperando un drenaje de tokens hasta que eso se mida. Véase [exhaust.md](../exhaust.md) y [trap-mode.md](../trap-mode.md).
- Los canarios permanecen inertes. El proyecto nunca usa credenciales reales, nunca realiza inyección inversa de prompts y nunca sondea hacia fuera. No contraataca.

**Qué es y qué no es.** agent-guard detecta, atrae y observa el tráfico de agentes de IA hostiles o exploratorios que llegan a tus API. No contraataca ni ataca a nadie. Los no objetivos, las funciones opt-in y sus límites experimentales se explican en [Lo que NO es](#lo-que-no-es).

Este es un proyecto de investigación de código abierto. v0.5a está implementado en este árbol fuente aún sin publicar, sin publicación en npm ni etiqueta de versión. Instálelo desde las fuentes o cree un tarball local con `npm pack`. El nombre de paquete de trabajo es `@imwyvern/agent-guard`. Apache-2.0, copyright 2026 Wesley Wang.

Consulte la [política de seguridad](../../SECURITY.md), la [guía de contribución](../../CONTRIBUTING.md), el [posicionamiento](../positioning.md) y la [hoja de ruta](../roadmap.md).

## Hoja de ruta: hacia dónde vamos

Los elementos implementados están en el árbol sin publicar; los restantes siguen planificados:

- **Honeyfiles de host (v0.5a)** — **implementados, sin publicar**: archivos inertes con `seed` y análisis opcional de registros de acceso Linux con `watch`; la cobertura del host depende de la fuente del operador.
- **Entorno de éxito falso** — **planificado, no implementado**: requiere evaluación de seguridad y aprobación separada antes de su implementación opt-in. Véase [deception.md](../deception.md).
- **Ventana de respuesta (v0.5a)** — **implementada, sin publicar**: línea de tiempo, métricas dwell, CLI de incidentes, registro acotado, recordatorios opcionales y hooks de Node para scripts del operador.
- **Host señuelo aislado** — **planificado, no implementado**: un entorno separado; el alcance son programas/plantillas y el despliegue corresponde al operador.
- **Evaluación del coste en tokens con agentes reales** — **planificada, no implementada**: no hay presupuesto de modelos definido. Consumir tokens del atacante no está demostrado; el ratio de bytes de la simulación sigue en 1:1.
- **Adaptadores Edge (v0.4b)** — **implementados (sin publicar)**: núcleo de estándares web, Cloudflare Workers, Next.js middleware / Vercel Edge, Deno, Bun y Hono-web.

El plan detallado está en [docs/roadmap.md](../roadmap.md). El alcance y las afirmaciones honestas están en [docs/positioning.md](../positioning.md).

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

Si usa un nombre de archivo de registro, prepárelo con la CLI. Un registro vacío genera seis canarios señuelo canónicos en memoria. Persista las ubicaciones con la CLI si los tokens deben permanecer estables entre reinicios. `projectSeed` controla datos falsos inofensivos; los ID de los señuelos ordinarios son criptográficamente aleatorios. El comando separado `seed` para honeyfiles deriva nuevos ID de forma determinista a partir de la semilla del operador, el secreto HMAC, el entorno y la ubicación, y reutiliza las entradas coincidentes del registro.

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

El adaptador Hono de v0.2 está disponible como `@imwyvern/agent-guard/hono`, con un peer `hono` opcional. Requiere Node ≥20: su núcleo Node usa `node:crypto` y DNS de Node. Para Workers/Bun/Deno, use `@imwyvern/agent-guard/hono-web` con `createWebGuard` de `@imwyvern/agent-guard/web` (v0.4b, sin publicar).

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

v0.3a (sin publicar) añade `agentGuard` en `@imwyvern/agent-guard/fastify` y `@imwyvern/agent-guard/koa`, con el mismo guard o config. Registre el plugin Fastify con `await app.register(agentGuard(guard))` antes de las rutas; inspecciona en `preHandler` después de analizar el cuerpo. En Koa, use `app.use(agentGuard(guard))` después de su analizador de cuerpo acotado. Ninguno consume el flujo de la petición. Ambos preservan los 404 nativos para rastreadores, las alertas de reutilización en modo detect y las transformaciones opt-in; los frameworks son peers opcionales y el núcleo no añade dependencias de runtime. Consulte la [demo Fastify](../../examples/fastify-demo/server.ts), la [demo Koa](../../examples/koa-demo/server.ts) y la [guía de adaptadores](../community.md).

## Edge / Web runtimes

v0.4b está implementado en este **árbol aún sin publicar**, con cero dependencias de runtime. Instale desde git/fuentes o un tarball local de `npm pack`; el paquete aún no está publicado en npm. Las entradas Web usan WebCrypto y tipos estructurales del anfitrión; los adaptadores no importan `next` ni `hono`.

`createWebGuard(config)` devuelve un guard Web; `await guard.handle(request, ctx?)` produce `Response` al interceptar o `null` para continuar hacia el anfitrión.

| Runtime | Sufijo de importación tras `@imwyvern/agent-guard` | IP del cliente |
| --- | --- | --- |
| Anfitrión de estándares web | `/web` (`createWebGuard`) | `ctx.clientIp` del anfitrión o `ipHeader` explícito; si no, `unknown` |
| Cloudflare Workers | `/workers` (`fromEnv`, `withAgentGuard`) | `fromEnv` usa `CF-Connecting-IP` por defecto |
| Next.js middleware / Vercel Edge | `/next` (`agentGuardMiddleware`) | El operador debe configurar `ipHeader` |
| Deno | `/deno` (`denoHandler`) | `remoteAddr.hostname` |
| Bun | `/bun` (`bunHandler`) | `server.requestIP(request)` |
| Hono en edge | `/hono-web` (`honoWeb`) + `/web` | `ipHeader` explícito en el guard Web |
| Hono en Node ≥20 | `/hono` (`agentGuard`) + núcleo Node de la raíz | IP del socket; sustitución `clientIp` de confianza |

La siguiente tabla se aplica a `/web` y los cinco adaptadores Web anteriores, incluido Hono en Bun/Deno. `/hono` mantiene el núcleo Node (`node:crypto` / DNS de Node).

| Función | Núcleo Web / Workers / Next / Deno / Bun / Hono-web | Hono en Node (`/hono`) |
| --- | --- | --- |
| Funciones sin estado | Rutas señuelo, generación/detección de reutilización de canarios, **nodos** de laberinto HMAC sin estado, alertas fetch, Prometheus (vista de un isolate) | Disponibles; métricas por proceso |
| Correlación de incidentes, rateLimit, block, puntuaciones de temporización, admisión de sesiones del laberinto | Requieren `StateStore`; sin almacén → desactivadas automáticamente, un aviso de consola por guard. `memoryStore()` es por isolate, nunca global | Estado acotado en cada proceso |
| Política de rastreadores | Por defecto `ua-bypass`: quienes declaran ser Googlebot/Bingbot u otros rastreadores de búsqueda reconocidos nunca entran en trap/maze/block; `crawler.verified: false`. Se permite un verificador `custom`. Sin DNS / DoH | Verificación DNS de Node o política configurada |
| `trap.delay` | Desactivado por defecto; desaconsejado en edge por la facturación del tiempo transcurrido; máximo 3000 ms si se activa explícitamente | Desactivado por defecto, opt-in |
| Cabeceras reenviadas | Las no configuradas no son de confianza; `x-forwarded-for` explícito usa el salto no vacío de más a la derecha y requiere un proxy de confianza | Callback `clientIp` explícito de confianza |
| SMTP | No disponible; use webhook / Slack / Telegram / Feishu mediante fetch | SMTP solo en Node |

Trap sigue desactivado por defecto en todos los runtimes. Los nodos firmados no conceden admisión a sesiones sin almacén; el laberinto sigue siendo experimental (ratio de bytes simulado 1:1). El operador aporta los almacenes persistentes. Consulte la [guía de operación Edge](../edge.md) para ejemplos de StateStore, la tabla completa de degradación y la resolución de problemas. Los ejemplos posteriores de configuración y alertas de este README describen la API de Node.

**Workers** — proporcione `AG_CANARY_SECRET` y `AG_PROJECT_SEED` mediante bindings de entorno; `fromEnv(env)` rechaza valores ausentes/vacíos y no tiene secreto predeterminado. Este ejemplo mínimo no tiene StateStore.

```ts
import { fromEnv, withAgentGuard } from '@imwyvern/agent-guard/workers';
import type { WebContext, WebGuard } from '@imwyvern/agent-guard/web';

let guard: WebGuard | undefined;
export default {
  fetch(request: Request, env: Record<string, unknown>, ctx: WebContext) {
    // Bind AG_CANARY_SECRET and AG_PROJECT_SEED in the host environment.
    guard ??= fromEnv(env);
    return withAgentGuard(guard, {
      fetch: () => new Response('Hello'),
    }).fetch(request, env, ctx);
  },
};
```

**Next.js / Vercel Edge** — `middleware.ts`; configure una cabecera que su proxy de entrada de confianza sobrescriba. El adaptador devuelve `Response` al interceptar y `undefined` para continuar, sin importar `next`.

```ts
import { createWebGuard } from '@imwyvern/agent-guard/web';
import { agentGuardMiddleware } from '@imwyvern/agent-guard/next';

const secret = process.env.AG_CANARY_SECRET;
const projectSeed = process.env.AG_PROJECT_SEED;
if (!secret || !projectSeed) throw new Error('Set AG_CANARY_SECRET and AG_PROJECT_SEED');
const guard = createWebGuard({
  project: 'catalog', env: 'production', mode: 'detect', projectSeed,
  ipHeader: 'x-real-ip', // Only trust a header overwritten by your ingress.
  canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
});
export const middleware = agentGuardMiddleware(guard);
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|assets/).*)'],
};
```

**Deno** — instale el tarball en un consumidor local con `nodeModulesDir: "manual"` de Deno 2; permita el acceso a estos dos bindings de entorno y a la red para el servidor.

```ts
import { createWebGuard } from '@imwyvern/agent-guard/web';
import { denoHandler } from '@imwyvern/agent-guard/deno';

const secret = Deno.env.get('AG_CANARY_SECRET');
const projectSeed = Deno.env.get('AG_PROJECT_SEED');
if (!secret || !projectSeed) throw new Error('Set AG_CANARY_SECRET and AG_PROJECT_SEED');
const guard = createWebGuard({
  project: 'catalog', env: 'production', mode: 'detect', projectSeed,
  canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
});
Deno.serve(denoHandler(guard, () => new Response('Hello')));
```

**Bun** — el adaptador obtiene del servidor la IP de conexión.

```ts
import { createWebGuard } from '@imwyvern/agent-guard/web';
import { bunHandler } from '@imwyvern/agent-guard/bun';

const secret = Bun.env.AG_CANARY_SECRET;
const projectSeed = Bun.env.AG_PROJECT_SEED;
if (!secret || !projectSeed) throw new Error('Set AG_CANARY_SECRET and AG_PROJECT_SEED');
const guard = createWebGuard({
  project: 'catalog', env: 'production', mode: 'detect', projectSeed,
  canary: { secret, registry: { version: 1, prefix: 'AG-CANARY-', canaries: [] } },
});
Bun.serve({ fetch: bunHandler(guard, () => new Response('Hello')) });
```

**Hono en edge** — este ejemplo de Workers usa los mismos bindings obligatorios. En Bun/Deno, cree el guard Web con `createWebGuard` y configure un `ipHeader` de confianza para ese anfitrión. Instale Hono en la aplicación consumidora.

```ts
import { Hono } from 'hono';
import { fromEnv } from '@imwyvern/agent-guard/workers';
import { honoWeb } from '@imwyvern/agent-guard/hono-web';
import type { WebGuard } from '@imwyvern/agent-guard/web';

let guard: WebGuard | undefined;
const app = new Hono<{ Bindings: Record<string, unknown> }>();
app.use('*', (c, next) => honoWeb(guard ??= fromEnv(c.env))(c, next));
app.get('/', c => c.text('Hello'));
export default app;
```

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
| `log.file` / `maxBytes` | Solo Node, JSONL saneado opt-in, modo 0600; 10 MiB por defecto, se trunca antes de añadir una línea que supere el límite |
| `escalation` | Solo Node, desactivada por defecto; recordatorios cada 300000 ms desde la primera alerta entregada, máximo 2 por incidente |
| `hooks` | Solo Node, sin configurar/vacío por defecto; argv fijo, sin shell, entorno nuevo de metadatos y límites de tiempo, frecuencia y concurrencia |
| `clientIp` | IP del socket; sobrescriba solo después de validar un proxy de confianza |
| `onEvent` | Observador opcional; los fallos del observador/sink se aíslan |

`guard.robotsLines()` admite la integración manual de robots. `guard.htmlCommentFor(path)` devuelve el comentario opt-in o null. `guard.metrics()` devuelve recuentos de peticiones/eventos/entrega y cuantiles acotados de temporización reciente de inspect. Las puntuaciones de temporización son observaciones acotadas por instancia; las de detección pueden satisfacer los criterios del trap opt-in. Estado del cliente: 50k entradas, TTL de inactividad de 30 minutos; caché de rastreadores: 10k, positivo 24h / negativo 1h. Ninguna cabecera reenviada se considera de confianza de forma automática.

En modo detect, D5 siempre deniega el inicio de sesión con un retraso determinista de 300–600ms. Todos los señuelos son `noindex`, `no-store`, ≤8KiB, usan nombres de host ficticios `.invalid` por defecto (excepto la URL de callback autoalojada que se configure explícitamente) y nunca crean cookies, autentican ni llaman a servicios de negocio. Los aciertos de señuelo de rastreadores de IA declarados tienen gravedad `info`. En detect, las verificaciones DNS de rastreadores se realizan en las rutas señuelo; trap y el manejador de callback opt-in amplían la verificación para mantener su inmunidad. Los errores/tiempos de espera fallan de forma abierta hacia un 404 nativo.

## Correlación de incidentes y seguimiento de propagación

v0.3a adjunta metadatos `incident` opcionales a los eventos existentes del mismo `client_key`: `id`, `sequence` ordenada (por ejemplo `robots → D1 → D2`), `first_seen`, `last_seen` y `confidence`. `incident.windowMs` vale 900000 por defecto (15 minutos fijos desde la primera observación); 0 desactiva la correlación. El estado usa una LRU de 50k clientes y conserva las últimas 32 observaciones. Los aciertos aislados repetidos tienen confianza low; distintos señuelos o descubrimiento más un señuelo la elevan a medium; `canary_replay` la eleva a high. La confianza no baja dentro de la ventana. Las visitas a robots son marcas internas y no añaden tipos de evento. Las redes compartidas pueden agrupar clientes; la correlación no eleva la gravedad. En el modo detect predeterminado conserva las respuestas HTTP y las decisiones sobre señuelos; trap opt-in de v0.4a puede usar high confidence como criterio de entrada. Los rastreadores verificados y las listas de permitidos conservan su inmunidad. Consulte el [modo trap](../trap-mode.md).

Las alertas de reutilización conservan `canary.id`, `placement`, `env`, `found_in` y `field`, añadiendo `leaked_at` (ubicación), `replayed_at` (ruta), `dwell_ms` (tiempo desde la primera entrega del señuelo) y `client_keys_seen` (claves distintas de clientes que reutilizan el token, máximo 8). Solo se registra la entrega si el cuerpo señuelo devuelto contiene el token; HEAD y bypass de rastreadores no cuentan. El seguimiento vive en memoria del proceso, con una LRU de 50k entradas y TTL de 24 horas. La expulsión, el reinicio o la entrega fuera de señuelos integrados dejan el momento desconocido, por lo que se omite `dwell_ms`. Estas observaciones no prueban identidad ni intención maliciosa.

## Honeyfiles de host y respuesta a incidentes (v0.5a, sin publicar)

Use la CLI compilada de abajo (o `agent-guard` en una instalación consumidora local). Prepare un archivo de semilla UTF-8 no vacío y establezca `AG_CANARY_SECRET` con su mecanismo de secretos; los comandos no imprimen esos valores. El dry-run necesita un `--dir` existente; `--write` puede crearlo. Los perfiles son `node`, `python`, `k8s` y `generic`. El contenido es inerte y determinista con las mismas entradas/registro, sin formatos ni prefijos de credenciales reales de proveedores; cualquier URL de callback debe alojarla el operador.

```sh
node dist/cli/main.js seed --profile node --dir ./honeyfiles --seed-file ./operator-seed.txt --env demo
node dist/cli/main.js seed --profile node --dir ./honeyfiles --seed-file ./operator-seed.txt --env demo --write
node dist/cli/main.js seed --profile node --dir ./honeyfiles --seed-file ./operator-seed.txt --env demo --verify
```

`--write` persiste por defecto `agent-guard.canaries.json` y `agent-guard.seed.json`. Mantenga los metadatos fuera del directorio de honeyfiles. La verificación es de solo lectura e informa de archivos ausentes/modificados o permisos incorrectos; los hallazgos no son alertas de acceso. Véase [perfiles, seguridad de rutas y plantillas de fuentes de registros](../seed.md).

El operador configura auditd o ejecuta `inotifywait -e access`. `watch` sigue el registro desde el final salvo que se indique `--from-start`; no usa `fs.watch` ni atime para detectar lecturas. Elija una fuente:

```sh
node dist/cli/main.js watch --inotify-log ./access.log --dir ./honeyfiles --manifest ./agent-guard.seed.json --project local-catalog --env demo
# Alternative: use an operator-configured auditd log.
node dist/cli/main.js watch --auditd /var/log/audit/audit.log --dir ./honeyfiles --manifest ./agent-guard.seed.json --project local-catalog --env demo
```

`watch` emite JSONL `honeyfile_read` de gravedad medium por stdout, con alertas webhook opcionales si se configuran tanto `AG_ALERT_WEBHOOK_URL` como `AG_ALERT_WEBHOOK_SECRET`. Estos eventos nunca activan trap/block y no tienen ID de incidente HTTP; la CLI los muestra como registros adyacentes si se recopilan en su archivo de entrada. La CLI independiente de watch no tiene opción de configuración de hooks.

En Node, añada estas opciones al crear el guard. Cree primero el directorio padre del registro, use el registro generado por seed con el mismo secreto/semilla/entorno para conocer el origen de la reutilización HTTP y sustituya las rutas del ejecutable/script por rutas absolutas de su host. Este ejemplo solo añade una línea a un registro local; el directorio de ese registro debe existir. Véase [uso seguro de hooks](../incident-response.md) y la [configuración del ejemplo](../examples/hooks/README.md).

```ts
const responseOptions = {
  log: { file: './events.jsonl', maxBytes: 10 * 1024 * 1024, keepIp: false },
  escalation: { enabled: true, remindAfterMs: 300000, maxReminders: 2 },
  hooks: [{
    on: 'canary_replay' as const,
    run: ['/usr/bin/node', '/absolute/path/to/agent-guard/docs/examples/hooks/append-log.mjs'] as [string, ...string[]],
    timeoutMs: 1000, maxPerHour: 10, maxConcurrent: 1,
  }],
};
// Pass ...responseOptions into createAgentGuard({...}). Omit to keep these options off.
```

Los hooks usan `spawn` con `shell: false`, nunca interpolan contenido de peticiones en argv y reciben solo `AG_INCIDENT_ID`, `AG_EVENT_TYPE`, `AG_CLIENT_KEY_HASH`, `AG_CANARY_ID` y `AG_PLACEMENT` cuando están disponibles. No heredan secretos del padre. Al agotar el tiempo se envía SIGTERM y después SIGKILL; hay topes horarios y de concurrencia. Los fallos emiten `hook_result` y nunca afectan a `inspect`; stdout/stderr se descartan. Los hooks son exclusivos de Node y están desactivados por defecto.

La línea de tiempo vive en `event.incident`: `first_touch_at`, `alerted_at` (primera entrega correcta) y `dwell_ms` (desde el primer contacto hasta este evento, mínimo cero). Difiere de `event.canary.dwell_ms`, que mide desde una entrega conocida del señuelo hasta su reutilización y se omite cuando se desconoce la entrega, incluidos los archivos de seed. Los resúmenes Prometheus de Node `agent_guard_time_to_alert_seconds` y `agent_guard_incident_dwell_seconds` no tienen etiquetas de ruta, UA ni IP.

```sh
node dist/cli/main.js incident list --log ./events.jsonl
node dist/cli/main.js incident show INCIDENT_ID --log ./events.jsonl --json
node dist/cli/main.js incident ack INCIDENT_ID --log ./events.jsonl
```

Sustituya `INCIDENT_ID` por un ID de `list`. `list` y `show` son de solo lectura; `ack` añade `incident_ack`. La escalada y los recordatorios están desactivados por defecto. Al activarlos, el guard de Node solo ve las confirmaciones de la CLI mediante el mismo `log.file`; con otro archivo o sin `log.file`, los recordatorios siguen acotados pero no pueden ver esas confirmaciones. La retención y la correlación son acotadas y locales al proceso; véase [respuesta a incidentes](../incident-response.md) para los límites.

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

No es un WAF, una defensa DDoS, un sistema de autenticación ni un bloqueador general de bots. No sustituye al parcheo, al mínimo privilegio ni a la higiene de secretos. Este proyecto de investigación no proporciona un despliegue en producción ni garantiza el comportamiento de los buscadores.

La cobertura del host se limita a honeyfiles opcionales y registros Linux configurados por el operador; el guard no puede ver lecturas de archivos por sí mismo. El éxito falso y el host señuelo aislado siguen planificados, no implementados; el éxito falso requiere revisión de seguridad y aprobación separada, y no desplegamos hosts. El consumo de tokens del atacante no está demostrado; la evaluación con agentes reales no tiene presupuesto definido. Véase el [posicionamiento](../positioning.md) y la [lista de la hoja de ruta](#hoja-de-ruta-hacia-dónde-vamos) anterior.

La inyección inversa de prompts / contrainyección (E4) nunca formará parte del producto. No realiza sondeos de salida ni inicia callbacks hacia terceros; los adaptadores de alertas configurados por el operador son la única excepción para notificaciones salientes. Se mantienen las verificaciones DNS de identidad de los rastreadores. Los canarios son tokens HMAC inertes, nunca credenciales reales de proveedores. No se usa ningún servicio de honeytokens de terceros (Canarytokens, etc.); el canario de callback solo se aloja en infraestructura del operador.

Los runtimes Edge / Web **están soportados en este árbol v0.4b aún sin publicar**. No hay estado persistente salvo que el operador proporcione un almacén: sin `StateStore`, se desactivan la correlación de incidentes, rateLimit, block, las puntuaciones de temporización y la admisión de sesiones del laberinto, con un aviso. `memoryStore()` es solo por isolate. La política de rastreadores predeterminada es `ua-bypass` sin verificar (sin DNS / DoH); SMTP es solo para Node; `trap.delay` está desactivado por defecto, se desaconseja en edge y tiene un tope de 3000 ms si se activa explícitamente. Consulte la [guía de operación Edge](../edge.md).

v0.4a incluye estas integraciones y controles **opt-in, desactivados por defecto**. El modo predeterminado sigue siendo `mode: 'detect'`:

- Adaptadores de alertas Slack, Telegram, Feishu y SMTP/email, sin nuevas dependencias de runtime ni destinos predeterminados.
- Exportación de texto mediante `guard.prometheusText()` / `prometheusHandler(guard)`: ningún endpoint se monta automáticamente y no hay etiquetas de rutas.
- `mode: 'trap'` con interruptores independientes para `delay`, `rateLimit`, `block` y `maze` **experimental**. Los rastreadores verificados y las listas de permitidos nunca quedan sujetos a trap.
- Canarios de callback autoalojados mediante `canary.callback.baseUrl` + `callbackHandler(guard)`. El manejador debe montarse explícitamente; el guard nunca hace fetch de `baseUrl`.

También se incluye `automation_score` para observar la regularidad mecánica de las peticiones: nunca eleva la gravedad ni activa block/maze por sí solo. El código actual recopila intervalos automáticamente y calcula la puntuación cuando hay suficientes muestras, sin un interruptor de activación independiente.

El **laberinto experimental** requiere mediciones del operador con agentes reales antes de activarse. En la [simulación fuera de línea de v0.3b](../bench-v0.3b.md), los agentes programados mostraron ratios de tiempo de cientos a uno bajo un modelo de **25 ms/petición**, pero el **ratio de bytes fue 1:1, por debajo del mínimo de 3:1**. Esto no demuestra un ahorro de costes con agentes reales. Consulte [controles y riesgos de trap](../trap-mode.md) y [Exhaust](../exhaust.md).

## Hoja de ruta y documentos de diseño

- [Posicionamiento](../positioning.md) — el propósito, los límites de alcance y una tabla de afirmaciones honestas (afirmación / estado / evidencia).
- [Comunidad](../community.md) — cómo contribuir adaptadores, firmas de detección, traducciones y RFC.
- [Hoja de ruta](../roadmap.md) — v0.4a/v0.4b/v0.5a completados (sin publicar) y planes restantes; las extensiones persona/deception siguen en diseño.
- [Seed y watch](../seed.md) — honeyfiles inertes, permisos, verificación y registros de acceso Linux aportados por el operador.
- [Respuesta a incidentes](../incident-response.md) — línea de tiempo, registros acotados, métricas, confirmaciones, recordatorios opcionales y [hooks que solo registran](../examples/hooks/README.md).
- [Guía de operación Edge](../edge.md) — integración de runtimes, ejemplos de StateStore, degradación y resolución de problemas.
- [Exhaust](../exhaust.md) — retraso opt-in y laberinto experimental ya implementados; el consumo de contexto (E3) sigue sin implementarse; el drenaje de tokens no está demostrado.
- [Deception](../deception.md) — hacer que los datos señuelo resulten creíbles para que el agente del atacante pueda tratarlos como reales; el «éxito falso» está planificado, no entregado.
- [Diseño](../design.md), [contrato](../codex-contract.md), [KPI](../kpi.md) y [modelo de amenazas](../threat-model.md). El trabajo previo solo informó los conceptos; no se copió código de ningún proyecto de terceros.
