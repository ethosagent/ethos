// Filesystem lookups `ethos serve` makes before it binds anything: where the
// built SPA lives and which teams are registered. No module state.

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';

/**
 * Resolve the absolute path to the built SPA. Search order:
 *   1. `--web-dist <path>` flag (explicit, wins).
 *   2. Sibling to the bundled CLI: `<cliDist>/web/index.html` (the
 *      pre-publish hook that bundles the web app drops it here, per
 *      CEO finding 9.1).
 *   3. Monorepo dev path: `apps/web/dist/index.html` resolved up from
 *      `import.meta.dirname`.
 * Returns null when no candidate exists; the server skips the static
 * mount and prints a hint pointing devs at `pnpm dev:web`.
 */
export function locateWebDist(explicit: string | undefined): string | null {
  if (explicit) {
    const abs = pathResolve(explicit);
    return existsSync(join(abs, 'index.html')) ? abs : null;
  }
  const candidates = [
    pathResolve(import.meta.dirname, '..', 'web'),
    pathResolve(import.meta.dirname, '..', '..', '..', '..', 'apps', 'web', 'dist'),
    pathResolve(import.meta.dirname, '..', '..', '..', 'apps', 'web', 'dist'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

/**
 * Enumerate registered team names for `GET /v1/models`. Scoped to the
 * `dataDir` the server is actually using (not `~/.ethos/teams` blindly),
 * so isolated/test installations report only their own teams. Manifest
 * files live at `<dataDir>/teams/<name>.yaml`; `.runtime.yaml` is the
 * supervisor's runtime state, not a manifest.
 */
export function listRegisteredTeams(dataDir: string): string[] {
  const teamsPath = join(dataDir, 'teams');
  if (!existsSync(teamsPath)) return [];
  return readdirSync(teamsPath, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.yaml') && !e.name.endsWith('.runtime.yaml'))
    .map((e) => e.name.slice(0, -'.yaml'.length))
    .sort();
}
