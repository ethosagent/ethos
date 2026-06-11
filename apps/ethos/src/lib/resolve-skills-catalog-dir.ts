import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the system skills catalog directory relative to the running code.
 * `ETHOS_SKILLS_CATALOG_DIR` overrides everything. Otherwise tries, in order:
 *   - `<baseDir>/../skills` — packaged build (tsup bundles to `<pkg>/dist/index.js`,
 *     prebuild ships the catalog at `<pkg>/skills`)
 *   - `<baseDir>/../../skills` — packaged layout with unbundled commands dir
 *   - `<baseDir>/../../../../skills` — dev (`<repo>/apps/ethos/src/commands` → `<repo>/skills`)
 * Returns the first candidate that exists, or undefined (with a one-line
 * warning naming the tried candidates and the env override).
 */
export function resolveSkillsCatalogDir(
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.ETHOS_SKILLS_CATALOG_DIR) return env.ETHOS_SKILLS_CATALOG_DIR;
  const candidates = [
    join(baseDir, '..', 'skills'),
    join(baseDir, '..', '..', 'skills'),
    join(baseDir, '..', '..', '..', '..', 'skills'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  console.warn(
    `[serve] skills catalog not found (tried: ${candidates.join(', ')}) — set ETHOS_SKILLS_CATALOG_DIR to override.`,
  );
  return undefined;
}
