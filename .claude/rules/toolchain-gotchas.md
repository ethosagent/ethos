---
paths:
  - "**/package.json"
  - "biome.json"
  - "tsconfig*.json"
  - "**/tsup.config.ts"
  - "pnpm-workspace.yaml"
---

# Toolchain gotchas

Learnings from building this codebase
Concrete gotchas and non-obvious decisions that emerged during development. Read this before making changes in any of these areas.

Workspace package.json exports point to source
All workspace package exports use "import": "./src/index.ts" (not ./dist/index.js). This lets Node 24 + tsx resolve them directly without a build step. The "production" condition points to ./dist/index.js for when you actually build. If you add a new workspace package, follow this pattern.

Biome v2: files.includes uses trailing slash for folder negation
"!dist/" (with trailing slash) ignores the dist directory. "!**/dist/**" also works but "!dist" (no slash) does not — Biome v2 changed this. The pattern is already correct in biome.json; don't "fix" it.

import.meta.dirname for locating built-in data files
extensions/personalities/src/index.ts uses join(import.meta.dirname, '..', 'data') to find the built-in personality data directory. import.meta.dirname is available in Node 21.2+ (and therefore Node 24). Don't replace with fileURLToPath(new URL(..., import.meta.url)) — that's the Node 18/20 workaround and adds noise.

tsx + extensionless imports: why we don't use --experimental-strip-types
Node 24's --experimental-strip-types requires explicit file extensions in imports (.js or .ts). This conflicts with TypeScript's extensionless import convention. tsx handles extensionless imports and tsconfig path aliases correctly. The decision to keep tsx was made explicitly — don't try to migrate to --experimental-strip-types without also adding extensions to every internal import.

noNonNullAssertion is enforced by Biome
array[n]! and map.get(key)! are blocked. Preferred patterns:

array[n] ?? fallback — safe default
const val = map.get(key); if (val) { ... } — explicit guard
Extract into a const before using in a filter: const match = update.substringMatch; if (!match) break;
