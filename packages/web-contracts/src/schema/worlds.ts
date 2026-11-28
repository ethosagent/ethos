import { z } from 'zod';

// ---------------------------------------------------------------------------
// World model — wire shapes for the `worlds` namespace (plan/phases/world-model.md
// Task 7.1). Every object is strict: an unknown key is a parse error on input and on
// output, so a new server field never reaches the wire by accident
// (packages/web-contracts/src/__tests__/worlds-schema.test.ts 'strictness').
//
// These duplicate the shapes in `@ethosagent/types` world-graph.ts and
// extensions/world-service on purpose: web-contracts must not import an extension.
//
// Errors use the existing envelope, not data: NOT_FOUND (unknown world, entity or
// proposal), CONFLICT (decided proposal, stale schema version), INPUT_INVALID (schema,
// config or mounts rejected; the message carries the file line). Refusals that are
// outcomes rather than faults (`shareCreate` too_large) are DATA, like `shares.create`
// (schema/shares.ts). The namespace is cookie-only; `worlds` is deliberately absent
// from SCOPE_MAP (apps/web-api middleware, wired in the P7 web-api task).
// ---------------------------------------------------------------------------

/** `world:<slug>` or `personality:<pid>`. */
export const WorldIdSchema = z.string().regex(/^(world|personality):[a-z0-9-]+$/);
export type WorldIdWire = z.infer<typeof WorldIdSchema>;

export const WORLD_MAX_HOPS = 3;
export const WORLD_MAX_GRAPH_LIMIT = 2000;

export const WorldFactAuthorSchema = z.enum(['user', 'import', 'connector', 'agent']);
export const WorldMountModeSchema = z.enum(['read', 'propose']);
export const WorldAudienceSchema = z.enum(['owner_only', 'shareable']);

/** ISO date (`2026-11-21`) or timestamp; the service parses it. */
const WorldInstantSchema = z.string().min(1).max(40);
const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);
const EntityIdSchema = z.string().min(1).max(64);

const WorldRefInput = z.strictObject({ world: WorldIdSchema });

// ----- list ---------------------------------------------------------------

export const WorldMountedBySchema = z.strictObject({
  personalityId: z.string(),
  mode: WorldMountModeSchema,
  effective: WorldMountModeSchema,
  note: z.string().optional(),
});

export const WorldSummarySchema = z.strictObject({
  id: WorldIdSchema,
  title: z.string(),
  audience: WorldAudienceSchema,
  backend: z.string(),
  counts: z.strictObject({
    entities: z.number().int().nonnegative(),
    liveEdges: z.number().int().nonnegative(),
    pendingProposals: z.number().int().nonnegative(),
  }),
  mountedBy: z.array(WorldMountedBySchema),
});
export type WorldSummaryWire = z.infer<typeof WorldSummarySchema>;

export const WorldsListInputSchema = z.strictObject({});
export const WorldsListOutputSchema = z.strictObject({ worlds: z.array(WorldSummarySchema) });

// ----- graph --------------------------------------------------------------

export const WorldsGraphInputSchema = z.strictObject({
  world: WorldIdSchema,
  asOf: WorldInstantSchema.optional(),
  focus: EntityIdSchema.optional(),
  hops: z.number().int().min(0).max(WORLD_MAX_HOPS).optional(),
  types: z.array(z.string().min(1)).max(64).optional(),
  limit: z.number().int().min(1).max(WORLD_MAX_GRAPH_LIMIT).optional(),
});

export const WorldGraphNodeSchema = z.strictObject({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  isNew: z.boolean(),
});
export const WorldGraphEdgeSchema = z.strictObject({
  id: z.string(),
  type: z.string(),
  from: z.string(),
  to: z.string(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  author: WorldFactAuthorSchema,
});
export const WorldsGraphOutputSchema = z.strictObject({
  nodes: z.array(WorldGraphNodeSchema),
  edges: z.array(WorldGraphEdgeSchema),
  truncated: z.boolean(),
});

// ----- tree ---------------------------------------------------------------

export const WorldsTreeInputSchema = z.strictObject({
  world: WorldIdSchema,
  asOf: WorldInstantSchema.optional(),
});
export const WorldTreeGroupSchema = z.strictObject({
  type: z.string(),
  entities: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      /** Live outgoing + incoming edge count at `asOf`. */
      edgeCount: z.number().int().nonnegative(),
      isNew: z.boolean(),
    }),
  ),
});
export const WorldsTreeOutputSchema = z.strictObject({ groups: z.array(WorldTreeGroupSchema) });

// ----- entity -------------------------------------------------------------

export const WorldsEntityInputSchema = z.strictObject({
  world: WorldIdSchema,
  entityId: EntityIdSchema,
  asOf: WorldInstantSchema.optional(),
});
export const WorldFactWireSchema = z.strictObject({
  id: z.string(),
  key: z.string(),
  value: z.unknown(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  recordedAt: z.string(),
  author: WorldFactAuthorSchema,
  sourceRef: z.string(),
  confidence: z.number().min(0).max(1),
  /** True when a user could promote this fact from a non-authoritative author. */
  promotable: z.boolean(),
});
export const WorldEntityEdgeSchema = z.strictObject({
  id: z.string(),
  type: z.string(),
  direction: z.enum(['out', 'in']),
  otherId: z.string(),
  otherName: z.string(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  author: WorldFactAuthorSchema,
});
export const WorldMemoryMentionSchema = z.strictObject({
  scope: z.string(),
  excerpt: z.string(),
});
export const WorldsEntityOutputSchema = z.strictObject({
  id: z.string(),
  world: WorldIdSchema,
  type: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  retiredAt: z.string().nullable(),
  facts: z.array(WorldFactWireSchema),
  edges: z.array(WorldEntityEdgeSchema),
  memoryMentions: z.array(WorldMemoryMentionSchema),
  mountedBy: z.array(WorldMountedBySchema),
});

// ----- changes ------------------------------------------------------------

export const WorldsChangesInputSchema = z.strictObject({
  world: WorldIdSchema,
  since: WorldInstantSchema,
  limit: z.number().int().min(1).max(WORLD_MAX_GRAPH_LIMIT).optional(),
});
export const WorldChangeRowSchema = z.strictObject({
  at: z.string(),
  kind: z.enum(['opened', 'closed', 'retired', 'entity']),
  factId: z.string(),
  summary: z.string(),
  author: WorldFactAuthorSchema,
});
export const WorldChangeGroupSchema = z.strictObject({
  sourceRef: z.string(),
  author: WorldFactAuthorSchema,
  changes: z.array(WorldChangeRowSchema),
});
export const WorldsChangesOutputSchema = z.strictObject({
  groups: z.array(WorldChangeGroupSchema),
});

// ----- proposals ----------------------------------------------------------

export const WorldProposalStatusSchema = z.enum([
  'pending',
  'accepted',
  'rejected',
  'superseded',
  'expired',
]);
export const WorldProposalKindSchema = z.enum([
  'assert',
  'close',
  'retire',
  'schema',
  'merge_entity',
]);
export const WorldsProposalsInputSchema = z.strictObject({
  world: WorldIdSchema.optional(),
  status: WorldProposalStatusSchema.optional(),
});
export const WorldProposalWireSchema = z.strictObject({
  id: z.string(),
  world: WorldIdSchema,
  kind: WorldProposalKindSchema,
  status: WorldProposalStatusSchema,
  summary: z.string(),
  /** Id of the proposal or fact this one contradicts. */
  conflictWith: z.string().nullable(),
  sourceRef: z.string(),
  proposedBy: z.string(),
  confidence: z.number().min(0).max(1),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  reason: z.string().nullable(),
});
/** Conflicting proposals come first; the rest are newest first (server order, not re-sorted). */
export const WorldsProposalsOutputSchema = z.strictObject({
  proposals: z.array(WorldProposalWireSchema),
});

export const WorldsDecideInputSchema = z.strictObject({
  proposalId: z.string().min(1),
  verdict: z.enum(['accept', 'reject']),
  reason: z.string().max(2000).optional(),
});
export const WorldsDecideOutputSchema = z.strictObject({
  ok: z.literal(true),
  applied: z.array(z.string()),
  closed: z.array(z.string()),
});

// ----- fact writes --------------------------------------------------------

export const WorldsFactWriteInputSchema = z.strictObject({
  world: WorldIdSchema,
  fact: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('entity'),
      type: z.string().min(1),
      name: z.string().min(1),
      aliases: z.array(z.string()).optional(),
    }),
    z.strictObject({
      kind: z.literal('attribute'),
      entityId: EntityIdSchema,
      key: z.string().min(1),
      value: z.unknown(),
      validFrom: WorldInstantSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal('edge'),
      type: z.string().min(1),
      fromId: EntityIdSchema,
      toId: EntityIdSchema,
      attrs: z.record(z.string(), z.unknown()).optional(),
      validFrom: WorldInstantSchema.optional(),
    }),
  ]),
});
export const WorldsFactWriteOutputSchema = z.strictObject({
  ok: z.literal(true),
  ids: z.array(z.string()),
});

export const WorldsFactCloseInputSchema = z.strictObject({
  world: WorldIdSchema,
  factId: z.string().min(1),
  validTo: WorldInstantSchema.optional(),
});
export const WorldsFactCloseOutputSchema = z.strictObject({ ok: z.literal(true) });

export const WorldsPromoteInputSchema = z.strictObject({
  world: WorldIdSchema,
  factId: z.string().min(1),
});
export const WorldsPromoteOutputSchema = z.strictObject({
  ok: z.literal(true),
  /** The new user-authored fact that supersedes the promoted one. */
  factId: z.string(),
});

// ----- schema -------------------------------------------------------------

export const WorldAttrSpecSchema = z.strictObject({
  type: z.enum(['string', 'int', 'number', 'bool', 'date', 'url']),
  min: z.number().optional(),
  max: z.number().optional(),
  enum: z.array(z.string()).optional(),
});
export const WorldSchemaWireSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  entities: z.record(
    z.string(),
    z.strictObject({ attrs: z.record(z.string(), WorldAttrSpecSchema) }),
  ),
  edges: z.record(
    z.string(),
    z.strictObject({
      from: z.array(z.string()),
      to: z.array(z.string()),
      attrs: z.record(z.string(), WorldAttrSpecSchema),
      unique: z.enum(['from', 'to']).optional(),
    }),
  ),
});
export const WorldLineIssueSchema = z.strictObject({
  line: z.number().int().positive(),
  column: z.number().int().positive().optional(),
  message: z.string(),
});

export const WorldsSchemaInputSchema = WorldRefInput;
export const WorldsSchemaOutputSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  yaml: z.string(),
  /** Null when the stored yaml no longer parses; `loadErrors` says why. */
  parsed: WorldSchemaWireSchema.nullable(),
  sensitive: z.array(z.string()),
  changelog: z.array(
    z.strictObject({
      v: z.number().int(),
      by: z.string(),
      at: z.string(),
      change: z.string(),
      reason: z.string().optional(),
    }),
  ),
  versions: z.array(
    z.strictObject({
      version: z.number().int(),
      by: z.string(),
      at: z.string(),
      reason: z.string().nullable(),
    }),
  ),
  loadErrors: z.array(WorldLineIssueSchema),
});

export const WorldsSchemaSaveInputSchema = z.strictObject({
  world: WorldIdSchema,
  yaml: z.string().min(1).max(256_000),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().max(2000).optional(),
});
export const WorldsSchemaSaveOutputSchema = z.strictObject({
  ok: z.literal(true),
  version: z.number().int().nonnegative(),
});

// ----- config (world.yaml) ------------------------------------------------

export const WorldsConfigInputSchema = WorldRefInput;
/** `id` and `backend` are read-only: the save input has no field for them. */
export const WorldsConfigOutputSchema = z.strictObject({
  id: SlugSchema,
  backend: z.string(),
  title: z.string(),
  audience: WorldAudienceSchema,
  readers: z.array(SlugSchema),
  proposers: z.array(SlugSchema),
});
export const WorldsConfigSaveInputSchema = z.strictObject({
  world: WorldIdSchema,
  title: z.string().min(1).max(200),
  audience: WorldAudienceSchema,
  readers: z.array(SlugSchema).max(256),
  proposers: z.array(SlugSchema).max(256),
});
export const WorldsConfigSaveOutputSchema = z.strictObject({ ok: z.literal(true) });

// ----- mounts (worlds.yaml per personality) --------------------------------

const WorldMountEntrySchema = z.strictObject({
  world: SlugSchema,
  mode: WorldMountModeSchema,
  as: SlugSchema.optional(),
});
export const WorldsMountsInputSchema = z.strictObject({ personalityId: z.string().min(1) });
export const WorldsMountsOutputSchema = z.strictObject({
  mounts: z.array(WorldMountEntrySchema),
  effective: z.array(
    z.strictObject({
      world: SlugSchema,
      effective: WorldMountModeSchema,
      note: z.string().optional(),
    }),
  ),
});
export const WorldsMountsSaveInputSchema = z.strictObject({
  personalityId: z.string().min(1),
  mounts: z.array(WorldMountEntrySchema).max(64),
});
export const WorldsMountsSaveOutputSchema = z.strictObject({
  ok: z.literal(true),
  effective: WorldsMountsOutputSchema.shape.effective,
});

// ----- export / import / build preview -------------------------------------

export const WorldExportFormatSchema = z.enum([
  'facts-yaml',
  'json',
  'graphml',
  'mermaid',
  'mcp-jsonl',
  'csv',
]);
export const WorldsExportInputSchema = z.strictObject({
  world: WorldIdSchema,
  format: WorldExportFormatSchema,
  asOf: WorldInstantSchema.optional(),
});
export const WorldsExportOutputSchema = z.strictObject({
  filename: z.string(),
  mime: z.string(),
  text: z.string(),
});

export const WorldImportFormatSchema = z.enum(['facts-yaml', 'json', 'mcp-jsonl', 'csv']);
export const WorldsImportInputSchema = z.strictObject({
  world: WorldIdSchema,
  format: WorldImportFormatSchema,
  text: z.string().min(1).max(8_000_000),
});
export const WorldsImportOutputSchema = z.strictObject({
  entities: z.number().int().nonnegative(),
  attributes: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  skipped: z.array(z.strictObject({ line: z.number().int(), reason: z.string() })),
});

export const WorldsBuildPreviewInputSchema = z.strictObject({
  world: WorldIdSchema,
  /** Free text or a memory scope the build would read; the service decides. */
  source: z.string().min(1).max(200_000),
});
export const WorldsBuildPreviewOutputSchema = z.strictObject({
  summary: z.strictObject({
    entities: z.number().int().nonnegative(),
    attributes: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    proposals: z.number().int().nonnegative(),
  }),
  items: z.array(
    z.strictObject({
      kind: z.enum(['entity', 'attribute', 'edge']),
      label: z.string(),
      sourceRef: z.string(),
      conflict: z.boolean(),
    }),
  ),
});

// ----- share --------------------------------------------------------------

export const WorldsShareCreateInputSchema = z.strictObject({
  world: WorldIdSchema,
  view: z.enum(['tree', 'graph']),
  asOf: WorldInstantSchema.optional(),
  expiresInDays: z.number().int().min(1).max(90),
  /** The owner unticks these to keep them; both default to stripped. */
  keepEmail: z.boolean().optional(),
  keepLocation: z.boolean().optional(),
});
const SnapshotAttrSchema = z.strictObject({ key: z.string(), value: z.string() });

/**
 * The stored body of a world share link, parsed by the public page (routes/share.ts) before
 * rendering. Mirrors `WorldSnapshot` in extensions/world-service/src/share-snapshot.ts.
 */
export const WorldSnapshotWireSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('world'),
  world: z.string(),
  title: z.string(),
  view: z.enum(['tree', 'graph']),
  asOf: z.string(),
  createdAt: z.string(),
  groups: z.array(
    z.strictObject({
      type: z.string(),
      entities: z.array(
        z.strictObject({
          id: z.string(),
          name: z.string(),
          aliases: z.array(z.string()),
          attrs: z.array(SnapshotAttrSchema),
          links: z.array(
            z.strictObject({
              type: z.string(),
              direction: z.enum(['out', 'in']),
              otherId: z.string(),
              otherName: z.string(),
            }),
          ),
        }),
      ),
    }),
  ),
  edges: z
    .array(
      z.strictObject({
        type: z.string(),
        fromId: z.string(),
        fromName: z.string(),
        toId: z.string(),
        toName: z.string(),
        attrs: z.array(SnapshotAttrSchema),
      }),
    )
    .optional(),
  redacted: z.array(z.string()),
});
export type WorldSnapshotWire = z.infer<typeof WorldSnapshotWireSchema>;

/** Same shape as the session share service: a refusal is data (apps/web-api/src/features/share/service.ts). */
export const WorldsShareCreateOutputSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    url: z.string(),
    id: z.string(),
    expiresAt: z.string(),
    redacted: z.array(z.string()),
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.literal('too_large'),
    limitBytes: z.number().int().positive(),
  }),
]);

// ----- linkify ------------------------------------------------------------

export const WorldsLinkifyInputSchema = z.strictObject({
  world: WorldIdSchema,
  text: z.string().max(100_000),
});
/** Spans cover `text` in order and without gaps; an `entity` span carries its ref. */
export const WorldsLinkifyOutputSchema = z.strictObject({
  spans: z.array(
    z.strictObject({
      text: z.string(),
      entity: z.strictObject({ id: z.string(), type: z.string() }).optional(),
    }),
  ),
});
