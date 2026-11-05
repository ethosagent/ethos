import { CATALOG_KINDS, CATALOG_TIERS } from '@ethosagent/types';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Unified catalog — wire schema for one catalog entry
// (plan/phases/unified-catalog.md §4.2). The interface lives in
// `@ethosagent/types` (`CatalogEntry`) and the data in `@ethosagent/catalog`.
// Kind and tier enums are built from the `CATALOG_*` vocabularies; the pin
// discriminator and the whole shape are pinned to the interface by
// `__tests__/catalog-schema-drift.test.ts`.
// ---------------------------------------------------------------------------

export const CatalogKindSchema = z.enum(CATALOG_KINDS);
export const CatalogTierSchema = z.enum(CATALOG_TIERS);

export const CatalogPinSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('remote'), url: z.string(), transport: z.literal('streamable-http') }),
  z.object({
    type: z.literal('npm'),
    package: z.string(),
    version: z.string(),
    integrity: z.string(),
  }),
  z.object({
    type: z.literal('pypi'),
    package: z.string(),
    version: z.string(),
    integrity: z.string(),
  }),
  z.object({
    type: z.literal('git'),
    repo: z.string(),
    commit: z.string(),
    subdir: z.string().optional(),
    contentDigest: z.string(),
  }),
]);

export const CatalogCapabilitiesSchema = z.object({
  network: z.array(z.string()),
  auth: z.enum(['none', 'oauth', 'bearer', 'env']),
  env: z.array(z.string()),
  filesystem: z.enum(['none', 'user-path', 'own-state']),
  shell: z.boolean(),
  toolCount: z.number().int().nonnegative().optional(),
});

export const CatalogEntrySchema = z.object({
  id: z.string(),
  kind: CatalogKindSchema,
  name: z.string(),
  description: z.string(),
  category: z.string(),
  publisher: z.string(),
  tier: CatalogTierSchema,
  pin: CatalogPinSchema,
  capabilities: CatalogCapabilitiesSchema,
  license: z.string().nullable(),
  homepage: z.string().optional(),
  reviewedAt: z.string(),
  mcp: z
    .object({
      argsAfterSpec: z.array(z.string()),
      argVars: z.array(z.string()),
      envVars: z.array(z.string()),
    })
    .optional(),
  plugin: z.object({ pluginId: z.string() }).optional(),
  skill: z.object({ skillName: z.string() }).optional(),
});
export type CatalogEntryInfo = z.infer<typeof CatalogEntrySchema>;

// ---------------------------------------------------------------------------
// `catalog.list` (plan/phases/unified-catalog.md §5.2). `installed` and
// `action` are computed server-side (D10) by `CatalogService`
// (apps/web-api/src/services/catalog.service.ts), pinned by
// apps/web-api/src/__tests__/services/catalog.service.test.ts.
// ---------------------------------------------------------------------------

export const CatalogActionSchema = z.discriminatedUnion('type', [
  /** Remote, auth none: the client calls `mcp.addServer` with `name` + `url`. */
  z.object({ type: z.literal('add'), name: z.string(), url: z.string() }),
  /** Remote OAuth: the client starts the existing `mcp.start` with `name` (= id). */
  z.object({ type: z.literal('oauth'), url: z.string(), name: z.string() }),
  /** Plugin / skill: installed through `catalog.install` (Phase 3). */
  z.object({ type: z.literal('install') }),
  /** Local MCP (stdio is CLI-only from the web): the command to copy. */
  z.object({ type: z.literal('cli'), command: z.string() }),
]);
export type CatalogAction = z.infer<typeof CatalogActionSchema>;

export const CatalogListEntrySchema = CatalogEntrySchema.extend({
  installed: z.boolean(),
  action: CatalogActionSchema,
});
export type CatalogListEntry = z.infer<typeof CatalogListEntrySchema>;

export const CatalogListInputSchema = z.object({ kind: CatalogKindSchema.optional() });
export const CatalogListOutputSchema = z.object({
  version: z.literal(1),
  entries: z.array(CatalogListEntrySchema),
});
export type CatalogListOutput = z.infer<typeof CatalogListOutputSchema>;
