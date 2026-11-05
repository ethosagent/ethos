// Data-free builder for the `--arg` / `--env` flags of a local MCP entry's
// install command. Shared by the web-api (`catalog.list` cli action) and the
// CLI (`ethos catalog show`) so the two cannot drift; re-exported by the
// package root and `@ethosagent/catalog/filter`. Pinned by
// packages/catalog/src/__tests__/install-args.test.ts.

import type { CatalogEntry } from '@ethosagent/types';

/** `['--arg ALLOWED_PATH=<allowed_path>', '--env K=<k>']` from the entry's `mcp.argVars` / `mcp.envVars`. */
export function installFlags(entry: Pick<CatalogEntry, 'mcp'>): string[] {
  return [
    ...(entry.mcp?.argVars ?? []).map((v) => `--arg ${v}=<${v.toLowerCase()}>`),
    ...(entry.mcp?.envVars ?? []).map((v) => `--env ${v}=<${v.toLowerCase()}>`),
  ];
}
