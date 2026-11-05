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
