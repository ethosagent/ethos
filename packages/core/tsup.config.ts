import { defineConfig } from 'tsup';

// Bundle every PRIVATE @ethosagent workspace dep into core's dist so npm
// consumers don't need them as separate runtime installs. The private
// packages have `version: 0.0.0` and `private: true` in package.json —
// they're never published to npm. If tsup leaves them external, pnpm's
// publish step rewrites `workspace:*` → `0.0.0` in the published
// dependencies, and `npm install @ethosagent/cli` (which transitively
// pulls @ethosagent/core) 404s on `@ethosagent/safety-injection@0.0.0`
// or its siblings.
//
// `@ethosagent/types` stays external because it IS published — it's the
// zero-dep contract package every plugin author imports directly, so it
// needs to remain installable as its own artifact.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  noExternal: [
    '@ethosagent/storage-fs',
    '@ethosagent/safety-injection',
    '@ethosagent/safety-network',
    '@ethosagent/safety-watcher',
  ],
});
