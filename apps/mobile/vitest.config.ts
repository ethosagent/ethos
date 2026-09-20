import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// The app's own vitest project for its pure-TS cases (Testing, R13): the root
// config excludes apps/mobile, and `pnpm test` runs this one explicitly.
// `@ethosagent/types` exports only `./dist`, so tests read its source, as the
// root config and the app's tsconfig `paths` (which Metro honours) do.
export default defineConfig({
  resolve: {
    alias: { '@ethosagent/types': resolve(import.meta.dirname, '../../packages/types/src') },
  },
  test: { include: ['src/**/__tests__/**/*.test.ts'] },
});
