import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { index: 'src/index.ts', express: 'src/adapters/express.ts', node: 'src/adapters/node.ts', hono: 'src/adapters/hono.ts', 'cli/main': 'src/cli/main.ts' },
  format: ['esm', 'cjs'], dts: true, clean: true, sourcemap: true,
  target: 'node20', external: ['express', 'hono'], splitting: false,
});
