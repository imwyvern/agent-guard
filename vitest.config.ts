import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  fileParallelism: false, testTimeout: 15000, hookTimeout: 15000, setupFiles: ['test/setup.ts'],
  coverage: { provider: 'v8', include: ['src/**/*.ts'], reporter: ['text','json-summary','html'],
    thresholds: { lines: 90, 'src/canary/**': { branches: 100 }, 'src/crawler/**': { branches: 100 } } }
} });
