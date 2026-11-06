import type { CatalogKind } from '@ethosagent/types';
import { type QueryClient, useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { mcpKeys } from '../../mcp/api/keys';
import { pluginKeys } from '../../plugins/api/keys';

export const catalogKeys = {
  all: () => ['catalog'] as const,
  list: (kind?: CatalogKind) => [...catalogKeys.all(), 'list', kind] as const,
};

/** `installed` and `action` are computed server-side, so this is never cached forever. */
export function useCatalog(kind?: CatalogKind, enabled?: boolean) {
  return useQuery({
    queryKey: catalogKeys.list(kind),
    queryFn: () => rpc.catalog.list(kind ? { kind } : {}),
    enabled,
  });
}

/**
 * After a successful install / add / connect: the catalog (so the entry's
 * `installed` flips) plus the two lists the MCP and Plugins pages render —
 * the same set the retired `McpCatalogSection` invalidated, plus `['catalog']`.
 */
export function invalidateAfterInstall(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: catalogKeys.all() });
  qc.invalidateQueries({ queryKey: pluginKeys.all() });
  qc.invalidateQueries({ queryKey: mcpKeys.list() });
}
