// Locates the bundled built-in personalities `data/` directory.
//
// Dev: the monorepo source tree, reached from the bundled main output dir.
// Packaged: electron-builder ships `@ethosagent/personalities` inside
// `app.asar/node_modules/`, so the data lives at
// `<app.asar>/node_modules/@ethosagent/personalities/data`, not in a source
// tree. Electron's patched `fs` makes `existsSync` work on asar paths.
//
// Pinned by `__tests__/builtin-personalities-dir.test.ts` (packaged layout,
// dev precedence, and the not-found case).
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function resolveBuiltinPersonalitiesDir(
  mainDir: string,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  const candidates = [
    join(mainDir, '..', '..', 'extensions', 'personalities', 'data'),
    join(mainDir, '..', '..', '..', '..', 'extensions', 'personalities', 'data'),
    join(mainDir, '..', '..', 'node_modules', '@ethosagent', 'personalities', 'data'),
  ];
  return candidates.find((c) => exists(c));
}
