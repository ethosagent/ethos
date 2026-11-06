import { oc } from '@orpc/contract';
import {
  CatalogInstallInputSchema,
  CatalogInstallOutputSchema,
  CatalogListInputSchema,
  CatalogListOutputSchema,
  CatalogSetSkillGrantInputSchema,
  CatalogSetSkillGrantOutputSchema,
} from '../schemas';

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
  /**
   * Install a plugin or skill entry (plan §6.4). Never grants (D9). MCP entries
   * are 400 CATALOG_INSTALL_UNSUPPORTED: they use mcp.addServer / mcp.start.
   */
  install: oc.input(CatalogInstallInputSchema).output(CatalogInstallOutputSchema),
  /** Add or remove `catalog/<id>` in one personality's `skills.global_ingest.allow`. */
  setSkillGrant: oc.input(CatalogSetSkillGrantInputSchema).output(CatalogSetSkillGrantOutputSchema),
};
