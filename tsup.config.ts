import { defineConfig } from 'tsup';
export default defineConfig([{
  entry: { index: 'src/index.ts', express: 'src/adapters/express.ts', node: 'src/adapters/node.ts', hono: 'src/adapters/hono.ts', fastify: 'src/adapters/fastify.ts', koa: 'src/adapters/koa.ts', 'cli/main': 'src/cli/main.ts' },
  format: ['esm', 'cjs'], dts: true, clean: true, sourcemap: true,
  target: 'node20', external: ['express', 'hono', 'fastify', 'koa'], splitting: false,
}, {
  entry: { web: 'src/web/index.ts', workers: 'src/adapters/workers.ts', next: 'src/adapters/next.ts', deno: 'src/adapters/deno.ts', bun: 'src/adapters/bun.ts', 'hono-web': 'src/adapters/hono-web.ts' },
  platform: 'neutral', format: ['esm'], dts: true, clean: false, sourcemap: true,
  target: 'es2022', splitting: false,
}]);
