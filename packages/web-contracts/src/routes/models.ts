import { oc } from '@orpc/contract';
import { z } from 'zod';
import { DecisionProviderIdSchema, DecisionSiteViewSchema } from '../schemas';
import { ModelRegistryAdoptedModelSchema } from './_shared';

// ---------------------------------------------------------------------------
// Meta — server capabilities (stable from v1)
//
// Open-shape `Record<string, boolean>` describing what this server
// supports. Today: `{ byok: true }`. Absence means unsupported. Keys
// are added additively — the shape never changes, only its contents grow.
// ---------------------------------------------------------------------------

const MetaCapabilitiesOutput = z.object({
  capabilities: z.record(z.string(), z.boolean()),
});

/** @stable v1 */
export const meta = {
  capabilities: oc.output(MetaCapabilitiesOutput),
};

// ---------------------------------------------------------------------------
// Models — curated catalog for the model picker (suggestions only; users may
// type any model id). Sourced from packages/wiring's MODEL_CATALOG, grouped
// by provider id so the web UI can suggest per-selected-provider.
// ---------------------------------------------------------------------------

export const ModelCatalogOutput = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }),
  providers: z.record(
    z.string(),
    z.object({
      models: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          contextWindow: z.number().int().positive(),
          default: z.boolean().optional(),
        }),
      ),
    }),
  ),
});

/** @experimental */
export const models = {
  catalog: oc.output(ModelCatalogOutput),
};

// ---------------------------------------------------------------------------
// Model registry — the operator's model roster (plan/phases/model-registry.md).
//
// Handlers: apps/web-api `rpc/model-registry.ts` → `ModelRegistryService`.
// `list` reads; `upsert` / `setDefault` / `setRole` / `setRouting` / `remove`
// each save immediately as ONE config.yaml write; `test` / `testAll` probe.
//
// Refusals are DATA, not thrown ORPCErrors — the same choice `test` makes for
// `rate_limited`: every write answers `{ ok: true, … } | ModelRegistryRefusal`,
// because the pane renders a refusal (a referenced alias is a dialog with
// "Repoint them to…", not an error toast). Transport failures still throw.
// ---------------------------------------------------------------------------

const ModelRegistryAliasInput = z.string().min(1).max(200);

/** The three role bindings `setRole` writes. `default` is not one of them: the
 *  roster default is `setDefault` (`modelRegistry.default`). */
export const ModelRegistryBindableRoleSchema = z.enum(['trivial', 'deep', 'dreaming']);

/** One `validateModelRegistry` problem (`@ethosagent/config`). */
export const ModelRegistryProblemSchema = z.object({
  code: z.enum([
    'invalid_alias',
    'reserved_alias',
    'missing_provider',
    'missing_model_id',
    'unknown_provider_key',
    'derived_provider_key',
    'unknown_default',
    'unknown_role_binding',
    'unknown_fallback',
    'cross_provider_fallback',
    'alias_cycle',
  ]),
  /** The alias the problem is about (for `default`/roles: the alias they NAME). */
  alias: z.string(),
  /** The config key, e.g. `modelRegistry.roles.deep`. */
  key: z.string(),
  /** One sentence naming the offender and the configured set. */
  message: z.string(),
  /** The exact line to add or change, where there is one. */
  fix: z.string().optional(),
});
export type ModelRegistryProblemView = z.infer<typeof ModelRegistryProblemSchema>;

/** One place that names an alias — "used by", and what `remove` refuses on. */
export const ModelReferentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('personality'),
    personalityId: z.string(),
    /** The personality's own slot: `model`, one tier-map leaf, or `voice.model`. */
    field: z.enum([
      'model',
      'model.trivial',
      'model.default',
      'model.deep',
      'model.dreaming',
      'voice.model',
    ]),
    /** A built-in personality — read-only, so a repoint cannot rewrite it. */
    readOnly: z.boolean(),
  }),
  z.object({ kind: z.literal('role'), role: z.enum(['trivial', 'default', 'deep', 'dreaming']) }),
  z.object({ kind: z.literal('default') }),
  /** `modelRouting.<personalityId>`. */
  z.object({ kind: z.literal('routing'), personalityId: z.string() }),
  /** Another registry entry's `fallbacks` list. */
  z.object({ kind: z.literal('fallback'), alias: z.string() }),
]);
export type ModelReferent = z.infer<typeof ModelReferentSchema>;

/** Whether a provider entry has a credential — never the credential itself.
 *  `not_needed`: self-hosted / device-auth / IAM providers, or an uncatalogued
 *  provider with no `apiKey` (`providerCredentialStatus`, @ethosagent/wiring). */
export const ModelCredentialStatusSchema = z.enum(['set', 'missing', 'not_needed']);
export type ModelCredentialStatus = z.infer<typeof ModelCredentialStatusSchema>;

export const ModelRegistryRefusalSchema = z.object({
  ok: z.literal(false),
  code: z.enum([
    'config_missing',
    'unknown_alias',
    'duplicate_alias',
    'invalid_entry',
    'referenced',
    'invalid_repoint',
    'unknown_personality',
    'invalid_declaration',
  ]),
  /** Names the offender and the configured set; render verbatim. */
  message: z.string(),
  /** The `validateModelRegistry` problems behind `invalid_entry` / `invalid_repoint`. */
  problems: z.array(ModelRegistryProblemSchema),
  /** Who names the alias — populated for `referenced` (and `invalid_repoint`). */
  referents: z.array(ModelReferentSchema),
});
export type ModelRegistryRefusal = z.infer<typeof ModelRegistryRefusalSchema>;

export const ModelRegistryEntryViewSchema = z.object({
  alias: z.string(),
  /** `modelRegistry.<alias>.provider` — a provider ENTRY id. */
  providerKey: z.string(),
  modelId: z.string(),
  label: z.string().nullable(),
  contextWindow: z.number().nullable(),
  costPer1kInput: z.number().nullable(),
  costPer1kOutput: z.number().nullable(),
  fallbacks: z.array(z.string()),
  /** The provider entry's credential status; `missing` when no entry has that key. */
  credential: ModelCredentialStatusSchema,
  referents: z.array(ModelReferentSchema),
});
export type ModelRegistryEntryView = z.infer<typeof ModelRegistryEntryViewSchema>;

export const ModelProviderEntryViewSchema = z.object({
  /** The explicit id, else the positional display name (`deriveProviderKey`). */
  key: z.string(),
  /** Chain position (`providers.<index>`); 0 for a top-level-only config. */
  index: z.number().int().nonnegative(),
  /** Provider TYPE, e.g. `anthropic`. */
  provider: z.string(),
  id: z.string().nullable(),
  explicitId: z.boolean(),
  /** The entry's own `model`, if any. */
  model: z.string().nullable(),
  failover: z.boolean(),
  /** The entry's `apiVersion` line (azure reads it); null when absent. Not a secret. */
  apiVersion: z.string().nullable(),
  /** The entry's `region` line (bedrock reads it); null when absent. Not a secret. */
  region: z.string().nullable(),
  /** The entry's `awsProfile` line (bedrock reads it) — a profile NAME, never a
   *  credential; null when absent. */
  awsProfile: z.string().nullable(),
  credential: ModelCredentialStatusSchema,
  /** Whether a registry entry may name it — only with an explicit id (D24). */
  referenceable: z.boolean(),
  /** Why not, when `referenceable` is false. */
  reason: z.string().nullable(),
});
export type ModelProviderEntryView = z.infer<typeof ModelProviderEntryViewSchema>;

/** A model a provider-chain entry declares that the registry does not have yet
 *  (`planChainModelImport` candidates). A configured model is never hidden:
 *  `importChain` adopts it. */
export const ModelRegistryChainModelSchema = z.object({
  /** The entry's explicit id, or the id adopting it would write (D24). */
  providerKey: z.string(),
  /** Chain position (`providers.<index>`); 0 for a top-level-only config. */
  index: z.number().int().nonnegative(),
  /** Provider TYPE, e.g. `codex`. */
  provider: z.string(),
  modelId: z.string(),
  /** The alias `importChain` writes for it. */
  suggestedAlias: z.string(),
  /** False when adopting it also writes `providers.<index>.id`. */
  idIsExplicit: z.boolean(),
});
export type ModelRegistryChainModel = z.infer<typeof ModelRegistryChainModelSchema>;

export const ModelRegistryListOutput = z.object({
  /** Chain models not yet in the registry, in chain order. */
  chainModels: z.array(ModelRegistryChainModelSchema),
  /** In config-file order. */
  entries: z.array(ModelRegistryEntryViewSchema),
  /** `modelRegistry.default`. */
  default: z.string().nullable(),
  /** `modelRegistry.roles.<role>`; null = unbound (falls through to `default`). */
  roles: z.object({
    trivial: z.string().nullable(),
    default: z.string().nullable(),
    deep: z.string().nullable(),
    dreaming: z.string().nullable(),
  }),
  /** Every provider entry, in chain order — what the Add/Edit drawer lists. */
  providerEntries: z.array(ModelProviderEntryViewSchema),
  /** `modelRouting.<personalityId>` → role or alias. */
  routing: z.record(z.string(), z.string()),
  /** Every current `validateModelRegistry` problem. */
  problems: z.array(ModelRegistryProblemSchema),
});
export type ModelRegistryListResult = z.infer<typeof ModelRegistryListOutput>;

export const ModelRegistryUpsertInput = z.object({
  /** `create` refuses an existing alias; `update` refuses a missing one (no rename). */
  mode: z.enum(['create', 'update']),
  alias: ModelRegistryAliasInput,
  /** A provider entry with an explicit id. Emptiness and unknown/derived keys
   *  are refused by `validateModelRegistry`, naming the configured set. */
  provider: z.string().max(200),
  /** The vendor id. An empty one is refused by `validateModelRegistry`. */
  modelId: z.string().max(500),
  /** Optional display fields. On `update` they are REPLACED: omitted clears. */
  label: z.string().max(200).optional(),
  contextWindow: z.number().int().positive().optional(),
  costPer1kInput: z.number().nonnegative().optional(),
  costPer1kOutput: z.number().nonnegative().optional(),
});
export type ModelRegistryUpsertRequest = z.infer<typeof ModelRegistryUpsertInput>;

const ModelRegistryOk = z.object({ ok: z.literal(true) });

/** Output of `upsert` / `setDefault` / `setRole` / `setRouting`. */
export const ModelRegistryWriteOutput = z.union([ModelRegistryOk, ModelRegistryRefusalSchema]);
export type ModelRegistryWriteResult = z.infer<typeof ModelRegistryWriteOutput>;

export const ModelRegistryRemoveInput = z.object({
  alias: ModelRegistryAliasInput,
  /** "Repoint them to…": rewrite every writable referent to this alias, then remove. */
  repointTo: ModelRegistryAliasInput.optional(),
  /** "Remove anyway": remove and leave every referent to refuse at turn time. */
  force: z.boolean().optional(),
});

export const ModelRegistryRemoveOutput = z.union([
  z.object({
    ok: z.literal(true),
    alias: z.string(),
    repointedTo: z.string().nullable(),
    /** Referents now naming `repointedTo`. */
    rewritten: z.array(ModelReferentSchema),
    /** Referents still naming the removed alias (built-ins on repoint; all on force). */
    needsAttention: z.array(ModelReferentSchema),
  }),
  ModelRegistryRefusalSchema,
]);
export type ModelRegistryRemoveResult = z.infer<typeof ModelRegistryRemoveOutput>;

/** A saved alias, or an unsaved `(providerKey, modelId)` — the Add/Edit form's
 *  "Test before saving" (D19.1). Same probe, same 10s limit, keyed on the alias
 *  or on `providerKey/modelId`. */
export const ModelRegistryTestInput = z.union([
  z.object({ alias: ModelRegistryAliasInput }),
  z.object({ providerKey: z.string().min(1).max(200), modelId: z.string().min(1).max(500) }),
]);

/**
 * What one test learned — the SAME value `ethos models test` prints, produced
 * by the same `testModel` in `@ethosagent/wiring`. `alias` is present exactly
 * when the test named an alias; an unsaved test is identified by
 * `providerKey` / `modelId`.
 *
 * `rate_limited` is a state, not a thrown error: the 10s per-subject-per-caller
 * limit is enforced in the HANDLER (D19), because a test is a real billable
 * completion reachable by anything that can call this RPC, and a limit that
 * lives only in the button is a hint the button happens to respect. The
 * client-side disable (T2.8) sits on top so the ordinary path never sees this.
 */
export const ModelRegistryTestOutput = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    alias: z.string().optional(),
    providerKey: z.string(),
    provider: z.string(),
    modelId: z.string(),
    latencyMs: z.number().int().nonnegative(),
    /** The model the provider said it served. Absent when it named none, and
     *  rendered ONLY when it differs from `modelId` (D19). */
    echoedModel: z.string().optional(),
  }),
  z.object({
    state: z.literal('rejected'),
    alias: z.string().optional(),
    providerKey: z.string(),
    provider: z.string(),
    modelId: z.string(),
    /** The vendor's own body, verbatim and untruncated. Never paraphrased. */
    error: z.string(),
    fix: z.string(),
  }),
  z.object({
    /** The probe never got an answer. NOT a verdict on the credential. */
    state: z.literal('unreachable'),
    alias: z.string().optional(),
    providerKey: z.string(),
    provider: z.string(),
    modelId: z.string(),
    error: z.string(),
  }),
  z.object({
    /** Nothing was probed — the alias, its provider entry or its credential is missing. */
    state: z.literal('unconfigured'),
    alias: z.string().optional(),
    providerKey: z.string().optional(),
    modelId: z.string().optional(),
    reason: z.string(),
    fix: z.string().optional(),
  }),
  z.object({
    state: z.literal('rate_limited'),
    alias: z.string().optional(),
    providerKey: z.string().optional(),
    modelId: z.string().optional(),
    /** Named so the refusal can say how long to wait, rather than just "no". */
    retryAfterSeconds: z.number().int().nonnegative(),
  }),
]);

export type ModelRegistryTestResult = z.infer<typeof ModelRegistryTestOutput>;

/** One outcome per provider ENTRY the registry references (`providerEntryProbes`,
 *  the grouping `ethos models test --all` uses). */
export const ModelRegistryTestAllOutput = z.object({
  results: z.array(
    z.object({
      providerKey: z.string(),
      /** Every alias on that entry; the first (alphabetically) was probed. */
      aliases: z.array(z.string()),
      outcome: ModelRegistryTestOutput,
    }),
  ),
});
export type ModelRegistryTestAllResult = z.infer<typeof ModelRegistryTestAllOutput>;

/** `importChain` — adopt chain models; `providerKeys` absent = every candidate. */
export const ModelRegistryImportChainInput = z.object({
  providerKeys: z.array(z.string().min(1).max(200)).max(100).optional(),
});

export const ModelRegistryImportChainOutput = z.union([
  z.object({
    ok: z.literal(true),
    adopted: z.array(ModelRegistryAdoptedModelSchema),
    /** The alias written to `modelRegistry.default`; null when none was written. */
    defaultSet: z.string().nullable(),
    /** Provider ids made explicit (`providers.<n>.id`) by this import. */
    idsWritten: z.array(z.string()),
  }),
  ModelRegistryRefusalSchema,
]);
export type ModelRegistryImportChainResult = z.infer<typeof ModelRegistryImportChainOutput>;

/** A refused provider write. Data, not a thrown error — the drawer renders it. */
export const ModelRegistryProviderRefusalSchema = z.object({
  ok: z.literal(false),
  code: z.enum([
    'config_missing',
    /** `key` names no provider entry. */
    'unknown_provider',
    /** Empty provider type. */
    'invalid_provider',
    /** Id outside `[A-Za-z0-9_-]+` (or empty). */
    'invalid_id',
    /** Id already names another provider entry. */
    'duplicate_id',
    /** Empty or repeated modelId, a `validateModelRegistry` problem, or clearing
     *  the primary provider's own model. */
    'invalid_model',
    /** A requested alias already exists. */
    'duplicate_alias',
    /** `removeProvider` while registry models reference the entry (`aliases`). */
    'referenced',
    /** `removeProvider` of the deployment's only provider. */
    'last_provider',
    /** `moveProvider` past either end, or with no chain. */
    'cannot_move',
    /** `setProviderFailover(false)` on a top-level-only config. */
    'not_in_chain',
    /** `setFallbackModel` names no configured model. */
    'unknown_alias',
    /** `setFallbackModel` names a model on another provider entry (`aliases` =
     *  the models this entry does have). */
    'cross_provider_alias',
  ]),
  /** Names the offender and what would have worked; render verbatim. */
  message: z.string(),
  /** `validateModelRegistry` problems behind an `invalid_model`. */
  problems: z.array(ModelRegistryProblemSchema),
  /** The aliases the refusal is about (`referenced`, `cross_provider_alias`). */
  aliases: z.array(z.string()),
});
export type ModelRegistryProviderRefusal = z.infer<typeof ModelRegistryProviderRefusalSchema>;

const ModelRegistryProviderKeyInput = z.string().min(1).max(200);

export const ModelRegistryAddProviderInput = z.object({
  /** Provider TYPE, e.g. `anthropic`. Empty is refused as `invalid_provider`. */
  provider: z.string().max(100),
  /** `providers.<n>.id` — required and immutable afterwards (D24). */
  id: z.string().max(200),
  /** Plaintext; stored in the vault, the file gets a `${secrets:…}` ref. */
  apiKey: z.string().max(4096).optional(),
  baseUrl: z.string().max(2000).optional(),
  apiVersion: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  awsProfile: z.string().max(200).optional(),
  /** `false` = a credential that is not a failover hop (D23b). */
  failover: z.boolean().optional(),
  /** Upserted into the registry in the same write. The first model's id
   *  becomes `providers.<n>.model`. */
  models: z
    .array(
      z.object({
        modelId: z.string().max(500),
        /** Absent = the importer's slug rule, `-<id>` suffixed on collision. */
        alias: z.string().max(200).optional(),
        label: z.string().max(200).optional(),
        contextWindow: z.number().int().positive().optional(),
        costPer1kInput: z.number().nonnegative().optional(),
        costPer1kOutput: z.number().nonnegative().optional(),
      }),
    )
    .max(50),
});
export type ModelRegistryAddProviderRequest = z.infer<typeof ModelRegistryAddProviderInput>;

export const ModelRegistryAddProviderOutput = z.union([
  z.object({
    ok: z.literal(true),
    providerKey: z.string(),
    /** Chain position the entry landed at. */
    index: z.number().int().nonnegative(),
    /** Every model written, with its final alias. */
    models: z.array(ModelRegistryAdoptedModelSchema),
  }),
  ModelRegistryProviderRefusalSchema,
]);
export type ModelRegistryAddProviderResult = z.infer<typeof ModelRegistryAddProviderOutput>;

/** Omitted = keep. `apiKey: ''` also keeps (an empty key never erases one);
 *  `''` for the other fields removes the line. The id is immutable. */
export const ModelRegistryUpdateProviderInput = z.object({
  key: ModelRegistryProviderKeyInput,
  apiKey: z.string().max(4096).optional(),
  baseUrl: z.string().max(2000).optional(),
  apiVersion: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  awsProfile: z.string().max(200).optional(),
});

/** Output of `updateProvider` / `removeProvider` / `moveProvider` /
 *  `setProviderFailover` / `setFallbackModel`. `providerKey` is the entry's key
 *  AFTER the write (an id-less entry's derived key moves with it); `index` is
 *  its position after the write (for `removeProvider`, where it was). */
export const ModelRegistryProviderWriteOutput = z.union([
  z.object({
    ok: z.literal(true),
    providerKey: z.string(),
    index: z.number().int().nonnegative(),
  }),
  ModelRegistryProviderRefusalSchema,
]);
export type ModelRegistryProviderWriteResult = z.infer<typeof ModelRegistryProviderWriteOutput>;

/** @experimental */
export const modelRegistry = {
  list: oc.output(ModelRegistryListOutput),
  upsert: oc.input(ModelRegistryUpsertInput).output(ModelRegistryWriteOutput),
  setDefault: oc
    .input(z.object({ alias: ModelRegistryAliasInput }))
    .output(ModelRegistryWriteOutput),
  /** `alias: null` deletes the `modelRegistry.roles.<role>` line. */
  setRole: oc
    .input(
      z.object({
        role: ModelRegistryBindableRoleSchema,
        alias: ModelRegistryAliasInput.nullable(),
      }),
    )
    .output(ModelRegistryWriteOutput),
  /** `modelRouting.<personalityId>`: a role or a configured alias; `null` deletes the line. */
  setRouting: oc
    .input(
      z.object({
        personalityId: z.string().min(1).max(200),
        declaration: z.string().min(1).max(200).nullable(),
      }),
    )
    .output(ModelRegistryWriteOutput),
  remove: oc.input(ModelRegistryRemoveInput).output(ModelRegistryRemoveOutput),
  test: oc.input(ModelRegistryTestInput).output(ModelRegistryTestOutput),
  testAll: oc.output(ModelRegistryTestAllOutput),
  /** Adopt chain models (`list.chainModels`) in ONE config.yaml write. */
  importChain: oc.input(ModelRegistryImportChainInput).output(ModelRegistryImportChainOutput),
  /** Append a provider entry with an explicit id and its models, one write. */
  addProvider: oc.input(ModelRegistryAddProviderInput).output(ModelRegistryAddProviderOutput),
  updateProvider: oc
    .input(ModelRegistryUpdateProviderInput)
    .output(ModelRegistryProviderWriteOutput),
  /** Refused while any registry model references the entry. */
  removeProvider: oc
    .input(z.object({ key: ModelRegistryProviderKeyInput }))
    .output(ModelRegistryProviderWriteOutput),
  moveProvider: oc
    .input(z.object({ key: ModelRegistryProviderKeyInput, direction: z.enum(['up', 'down']) }))
    .output(ModelRegistryProviderWriteOutput),
  setProviderFailover: oc
    .input(z.object({ key: ModelRegistryProviderKeyInput, failover: z.boolean() }))
    .output(ModelRegistryProviderWriteOutput),
  /** `providers.<n>.model` = the alias's modelId; `null` removes the line. The
   *  alias must be one of THIS entry's models. */
  setFallbackModel: oc
    .input(
      z.object({ key: ModelRegistryProviderKeyInput, alias: ModelRegistryAliasInput.nullable() }),
    )
    .output(ModelRegistryProviderWriteOutput),
  /** Test connection for a SAVED provider with its stored credential. Probes
   *  `providers.<n>.model`, else its first registry model; neither →
   *  `unconfigured`. Rate-limited per provider entry (10s). */
  testProvider: oc
    .input(z.object({ providerKey: ModelRegistryProviderKeyInput }))
    .output(ModelRegistryTestOutput),
};

// ---------------------------------------------------------------------------
// Decisions — Settings › Models › decision models
// (plan/phases/decision-provider-jev.md §7, §12). Where Settings sets the
// decision provider's vault key (`providers/<id>/apiKey`). Per-site modes are
// set on each personality (`personalities.update` `decisions`, plan
// decision-provider-personality §9); the list reports which personalities use
// each provider (`usedBy`). Thresholds stay config.yaml lines. Served by
// `DecisionsService` (apps/web-api), cookie-only: `decisions` is absent from
// `SCOPE_MAP` (apps/web-api/src/middleware/dual-auth.ts), so a bearer key is
// refused the whole namespace.
// ---------------------------------------------------------------------------

/**
 * One KIND of decision model the operator can add — an entry of
 * `DECISION_PROVIDER_CATALOG`. The Add decision model drawer lists these; a
 * new provider is a new catalog entry, not a new pane.
 */
export const DecisionProviderTypeSchema = z.object({
  id: DecisionProviderIdSchema,
  /** The model family, e.g. `Jev`. */
  label: z.string(),
  /** Who runs it, e.g. `TypeSafe`. */
  vendor: z.string(),
  /** One or two sentences for the Add drawer. */
  description: z.string(),
  getKeyUrl: z.string(),
  /** The vault ref its key is stored at. */
  keyRef: z.string(),
  /** The model used when `decisions.model` is unset. */
  defaultModel: z.string(),
  /** The endpoint used when `decisions.baseUrl` is unset. */
  defaultBaseUrl: z.string(),
});
export type DecisionProviderType = z.infer<typeof DecisionProviderTypeSchema>;

/**
 * One personality that names a decision provider in `decisions.provider`.
 * `sites` holds only the sites it enables (`requested` ≠ `off`), each resolved
 * by `resolveCharacterSheetDecisions` (@ethosagent/wiring) — empty when it
 * names the provider but enables no site.
 */
export const DecisionProviderUserSchema = z.object({
  personalityId: z.string(),
  name: z.string(),
  sites: z.array(DecisionSiteViewSchema),
});
export type DecisionProviderUser = z.infer<typeof DecisionProviderUserSchema>;

export const DecisionProviderViewSchema = z.object({
  id: DecisionProviderIdSchema,
  /** The model family, e.g. `Jev`. */
  label: z.string(),
  /** Who runs it, e.g. `TypeSafe`. */
  vendor: z.string(),
  /** `decisions.provider` names this provider — the ACTIVE one (config allows one). */
  configured: z.boolean(),
  /** The vault ref the key is read from. */
  keyRef: z.string(),
  keyPresent: z.boolean(),
  /** Masked (`redactSecretValue`) — never the raw value. */
  keyPreview: z.string(),
  /** `decisions.model`, else the default alias. */
  model: z.string(),
  baseUrl: z.string(),
  /** The host data is sent to — the host of `baseUrl`. */
  host: z.string(),
  getKeyUrl: z.string(),
  /** The personalities whose `decisions.provider` names this provider, by id.
   *  Empty when the server was not given the personality registry. */
  usedBy: z.array(DecisionProviderUserSchema),
});
export type DecisionProviderView = z.infer<typeof DecisionProviderViewSchema>;

export const DecisionsListOutput = z.object({
  /** Every kind of decision model this build knows, added or not. */
  catalog: z.array(DecisionProviderTypeSchema),
  /** Only the ADDED ones: a key is stored, or `decisions.provider` names it. */
  providers: z.array(DecisionProviderViewSchema),
});
export type DecisionsListResult = z.infer<typeof DecisionsListOutput>;

/**
 * `DecisionErrorCode` (@ethosagent/types) plus `no_key`, which the service
 * answers before any call when nothing is stored. The handler's return type is
 * checked against this enum, so a provider code missing here fails typecheck.
 */
export const DecisionTestErrorCodeSchema = z.enum([
  'auth',
  'invalid',
  'rate_limited',
  'overloaded',
  'timeout',
  'aborted',
  'malformed',
  'too_large',
  'unavailable',
  'breaker_open',
  'no_key',
]);
export type DecisionTestErrorCode = z.infer<typeof DecisionTestErrorCodeSchema>;

export const DecisionsTestInput = z.object({
  providerId: DecisionProviderIdSchema,
  // A transport bound only. The service refuses anything over its own
  // 8,000-character cap as `invalid`, as data the pane renders, rather than
  // letting a schema error stand in for the answer.
  message: z.string().max(65_536),
});

/**
 * One test call's outcome — `testDecisionProvider` (@ethosagent/wiring) plus
 * the service's own refusals. `rate_limited` with `retryAfterSeconds` is the
 * service's 10s per-caller window (the model Test's D19 policy); without it,
 * the vendor said 429.
 */
export const DecisionsTestOutput = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    providerName: z.string(),
    /** The model id the provider RETURNED, not the one requested (D8). */
    model: z.string(),
    answer: z.object({
      p: z.number().min(0).max(1),
      confidence: z.number().min(0).max(1),
      /** `p ≥ 0.5` — the reading shadow mode records. */
      containsInstructions: z.boolean(),
    }),
    latencyMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
    /** Present only when redaction changed the message: what was actually sent. */
    redactedMessage: z.string().optional(),
  }),
  z.object({
    ok: z.literal(false),
    code: DecisionTestErrorCodeSchema,
    message: z.string(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  }),
]);
export type DecisionsTestResult = z.infer<typeof DecisionsTestOutput>;

/** @experimental */
export const decisions = {
  list: oc.output(DecisionsListOutput),
  /** Writes the vault key; also writes `decisions.provider` when it is absent.
   *  Never enables a site. */
  setKey: oc
    .input(
      z.object({
        providerId: DecisionProviderIdSchema,
        // 8 KiB cap, the named-secrets bound — real keys are far under it.
        value: z.string().min(1).max(8192),
      }),
    )
    .output(
      z.object({
        ok: z.literal(true),
        preview: z.string(),
        /** `decisions.provider` was absent and this call wrote it. */
        providerWritten: z.boolean(),
      }),
    ),
  /** Deletes the vault key. Idempotent; config.yaml is left alone. */
  clearKey: oc
    .input(z.object({ providerId: DecisionProviderIdSchema }))
    .output(z.object({ ok: z.literal(true) })),
  /** Removes the provider from the list: deletes the vault key AND the
   *  `decisions.provider` line when it names this provider. The other
   *  `decisions.*` lines stay (inert without a provider), and so does every
   *  personality's `decisions` block — its sites resolve `off`
   *  (`not-configured`) until the provider is added again. Idempotent. */
  remove: oc.input(z.object({ providerId: DecisionProviderIdSchema })).output(
    z.object({
      ok: z.literal(true),
      /** `decisions.provider` named this provider and this call removed it. */
      providerRemoved: z.boolean(),
    }),
  ),
  test: oc.input(DecisionsTestInput).output(DecisionsTestOutput),
};
