import { defineConfig } from 'vitest/config';
import { srcAliases } from './vitest.config';

// Timing-sensitive suites (`*.perf.test.ts`) assert tight latency bounds
// (e.g. sub-millisecond p50) that flake when the full parallel suite loads the
// machine, so they live in their OWN tier instead of the default `pnpm test`
// (excluded there via `test.exclude` in `vitest.config.ts`). Run with `pnpm
// test:perf`, ideally on a quiet machine.
//
// Standalone rather than `mergeConfig(baseConfig, ...)` for the same reason as
// `vitest.integration.config.ts`: `mergeConfig` concatenates `test.include`/
// `test.exclude` arrays instead of replacing them, which would re-run or
// re-exclude the default suite here. Reusing the `srcAliases` export keeps
// `@ethosagent/*` resolution identical.
export default defineConfig({
  resolve: {
    alias: srcAliases,
    extensions: ['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
  },
  test: {
    include: [
      'packages/*/src/**/__tests__/**/*.perf.test.ts',
      'packages/safety/*/src/**/__tests__/**/*.perf.test.ts',
      'extensions/*/src/**/__tests__/**/*.perf.test.ts',
    ],
    testTimeout: 30_000,
  },
});
