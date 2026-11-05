import { oc } from '@orpc/contract';
import { CatalogListInputSchema, CatalogListOutputSchema } from '../schemas';

// ---------------------------------------------------------------------------
// Catalog — the unified index of reviewed MCP servers, plugins and skills
// (plan/phases/unified-catalog.md §5.2).
//
// `list` takes an optional `kind` only: query and tier filtering is client-side
// (`filterCatalog`), following the recipes precedent. The namespace is absent
// from SCOPE_MAP on purpose — see apps/web-api/src/middleware/dual-auth.ts.
// ---------------------------------------------------------------------------

/** @experimental */
export const catalog = {
  list: oc.input(CatalogListInputSchema).output(CatalogListOutputSchema),
};
