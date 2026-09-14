// Model registry — Settings → Models (plan/phases/model-registry.md T1.24,
// T2.1, T2.2, T2.7, T2.8, T2.12).
//
// Reads go through `readConfig` (`parseConfigYaml`, the reader the runtime
// uses). Every write goes through `ConfigRepository.transform`, so each registry
// action is ONE config.yaml write whose refusal was decided against the state
// it would overwrite. Refusals are DATA (`{ ok: false, code, … }`), the shape
// `modelRegistry.test` already answers with, because the Settings pane renders
// them — a referenced alias is a dialog, not an error toast.
//
// The rules are not restated here. Entry validity is `validateModelRegistry`,
// a declaration is `parseModelDeclaration` (both `@ethosagent/config`), a test
// is `testModel` and credential presence is `providerCredentialStatus` (both
// `@ethosagent/wiring`, shared with `ethos models test`).

import {
  type AdoptedModel,
  type CatalogModelLookup,
  type ChainModelCandidate,
  deriveProviderKey,
  type EthosConfig,
  fillFromTopLevel,
  introducedModelRegistryProblems,
  type ModelRegistryProblem,
  type ProviderChainEntry,
  parseModelDeclaration,
  planChainModelImport,
  uniqueModelAlias,
  validateModelRegistry,
} from '@ethosagent/config';
import {
  MODEL_ROLE_NAMES,
  type ModelRegistry,
  type ModelRegistryEntry,
  type ModelRoleName,
  type ModelTierConfig,
  type SecretsResolver,
} from '@ethosagent/types';
import {
  type ModelTestOutcome,
  type ModelTestProbe,
  type ModelTestRateLimiter,
  type ModelTestTarget,
  type ProviderCredentialStatus,
  providerCredentialStatus,
  providerEntries,
  providerEntryProbes,
  testModel,
  testProviderEntry,
} from '@ethosagent/wiring';
import { lookupCatalogModel } from '@ethosagent/wiring/model-catalog';
import type {
  ConfigRepository,
  RawConfig,
  RawProviderEntry,
} from '../repositories/config.repository';
import {
  chainImportSource,
  providerChainSecretRefs,
  topLevelChainEntry,
  topLevelChainSecretRefs,
} from './config.service';

// ---------------------------------------------------------------------------
// Shapes (mirrored by the `modelRegistry` contract in @ethosagent/web-contracts)
// ---------------------------------------------------------------------------

/** Which slot of a personality names the alias. */
export type PersonalityModelField = 'model' | `model.${ModelRoleName}` | 'voice.model';

/** One place that names an alias — what "used by" lists and what `remove` refuses on. */
export type ModelReferent =
  | {
      kind: 'personality';
      personalityId: string;
      field: PersonalityModelField;
      /** A built-in: its files are read-only, so a repoint cannot rewrite it. */
      readOnly: boolean;
    }
  | { kind: 'role'; role: ModelRoleName }
  | { kind: 'default' }
  | { kind: 'routing'; personalityId: string }
  | { kind: 'fallback'; alias: string };

export type ModelRegistryRefusalCode =
  | 'config_missing'
  | 'unknown_alias'
  | 'duplicate_alias'
  | 'invalid_entry'
  | 'referenced'
  | 'invalid_repoint'
  | 'unknown_personality'
  | 'invalid_declaration';

export interface ModelRegistryRefusal {
  ok: false;
  code: ModelRegistryRefusalCode;
  /** One or more sentences naming the offender and the configured set. */
  message: string;
  /** `validateModelRegistry` problems behind an `invalid_entry` / `invalid_repoint`. */
  problems: ModelRegistryProblem[];
  /** Who names the alias, for `referenced`. */
  referents: ModelReferent[];
}

export interface ModelRegistryEntryView {
  alias: string;
  providerKey: string;
  modelId: string;
  label: string | null;
  contextWindow: number | null;
  costPer1kInput: number | null;
  costPer1kOutput: number | null;
  fallbacks: string[];
  /** The credential status of the provider entry this alias names. */
  credential: ProviderCredentialStatus;
  referents: ModelReferent[];
}

export interface ModelProviderEntryView {
  /** `deriveProviderKey`: the explicit id, else the positional display name. */
  key: string;
  /** Chain position; `0` for a top-level-only config. */
  index: number;
  /** Provider TYPE, e.g. `anthropic`. */
  provider: string;
  id: string | null;
  explicitId: boolean;
  model: string | null;
  failover: boolean;
  /** The `apiVersion` / `region` / `awsProfile` lines, so Edit provider can show
   *  them. None is a secret: the key is only ever `credential`. */
  apiVersion: string | null;
  region: string | null;
  awsProfile: string | null;
  credential: ProviderCredentialStatus;
  /** Whether a registry entry may name it (D24: only an explicit id). */
  referenceable: boolean;
  /** Why not, when not referenceable. */
  reason: string | null;
}

export interface ModelRegistryListResult {
  /** Chain models not yet in the registry (`planChainModelImport` candidates). */
  chainModels: ChainModelCandidate[];
  entries: ModelRegistryEntryView[];
  default: string | null;
  roles: Record<ModelRoleName, string | null>;
  providerEntries: ModelProviderEntryView[];
  /** `modelRouting.<personalityId>` → declaration. */
  routing: Record<string, string>;
  problems: ModelRegistryProblem[];
}

export interface ModelRegistryUpsertInput {
  mode: 'create' | 'update';
  alias: string;
  provider: string;
  modelId: string;
  label?: string | undefined;
  contextWindow?: number | undefined;
  costPer1kInput?: number | undefined;
  costPer1kOutput?: number | undefined;
}

export type ModelRegistryWriteResult = { ok: true } | ModelRegistryRefusal;

export type ModelRegistryRemoveResult =
  | {
      ok: true;
      alias: string;
      repointedTo: string | null;
      /** Referents rewritten to `repointedTo`. */
      rewritten: ModelReferent[];
      /** Referents that still name the removed alias and will refuse at turn time. */
      needsAttention: ModelReferent[];
    }
  | ModelRegistryRefusal;

export interface ModelRegistryTestAllResult {
  results: Array<{ providerKey: string; aliases: string[]; outcome: ModelTestOutcome }>;
}

export type ModelRegistryImportChainResult =
  | { ok: true; adopted: AdoptedModel[]; defaultSet: string | null; idsWritten: string[] }
  | ModelRegistryRefusal;

export type ModelRegistryProviderRefusalCode =
  | 'config_missing'
  | 'unknown_provider'
  | 'invalid_provider'
  | 'invalid_id'
  | 'duplicate_id'
  | 'invalid_model'
  | 'duplicate_alias'
  | 'referenced'
  | 'last_provider'
  | 'cannot_move'
  | 'not_in_chain'
  | 'unknown_alias'
  | 'cross_provider_alias';

/** A refused provider-entry write — the parallel of {@link ModelRegistryRefusal}. */
export interface ModelRegistryProviderRefusal {
  ok: false;
  code: ModelRegistryProviderRefusalCode;
  message: string;
  problems: ModelRegistryProblem[];
  /** The aliases the refusal is about (`referenced`, `cross_provider_alias`). */
  aliases: string[];
}

export interface ModelRegistryAddProviderInput {
  provider: string;
  id: string;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  apiVersion?: string | undefined;
  region?: string | undefined;
  awsProfile?: string | undefined;
  failover?: boolean | undefined;
  models: Array<{
    modelId: string;
    alias?: string | undefined;
    label?: string | undefined;
    contextWindow?: number | undefined;
    costPer1kInput?: number | undefined;
    costPer1kOutput?: number | undefined;
  }>;
}

export type ModelRegistryAddProviderResult =
  | { ok: true; providerKey: string; index: number; models: AdoptedModel[] }
  | ModelRegistryProviderRefusal;

/** Omitted keeps a field; `''` removes it — except `apiKey`, where empty keeps. */
export interface ModelRegistryUpdateProviderInput {
  key: string;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  apiVersion?: string | undefined;
  region?: string | undefined;
  awsProfile?: string | undefined;
}

/** `providerKey` / `index` are the entry's AFTER the write (`removeProvider`: where it was). */
export type ModelRegistryProviderWriteResult =
  | { ok: true; providerKey: string; index: number }
  | ModelRegistryProviderRefusal;

/** The binding roles `setRole` writes; `default` is `setDefault`'s radio. */
export type ModelRegistryBindableRole = Exclude<ModelRoleName, 'default'>;

/**
 * The personality registry, narrowed to what this service reads and writes.
 * Production passes `FilePersonalityRegistry` (Storage-backed; a custom
 * personality's `config.yaml` is rewritten by its `update`).
 */
export interface ModelRegistryPersonalities {
  refresh(): Promise<void>;
  list(): Array<{
    id: string;
    model: string | ModelTierConfig | undefined;
    voiceModel: string | undefined;
    builtin: boolean;
  }>;
  /** Rewrite a custom personality's own `model:` and/or `voice.model`. */
  setModel(
    id: string,
    patch: { model?: string | ModelTierConfig; voiceModel?: string },
  ): Promise<void>;
}

export interface ModelRegistryServiceOptions {
  /** Reads `<dataDir>/config.yaml` — the same file the rest of this app reads. */
  readConfig: () => Promise<EthosConfig | null>;
  /** The writer every registry action goes through. */
  config: ConfigRepository;
  personalities: ModelRegistryPersonalities;
  /** Resolves the `${secrets:…}` reference a provider entry's `apiKey` holds. */
  secrets: SecretsResolver;
  /** Test seam. Absent in production, where the real probe is used. */
  probe?: ModelTestProbe;
  /** Test seam. Absent in production, where the process-wide limiter is used. */
  limiter?: ModelTestRateLimiter;
  /**
   * `ConfigService.deleteOrphanedSecrets`: drops the vault entries a provider
   * write left unreferenced (a replaced key, a removed entry). Production wires
   * it (apps/web-api `index.ts`); absent, nothing is deleted, which leaves at
   * worst vault litter — never a live credential gone.
   */
  deleteOrphanedSecrets?: (refs: string[]) => Promise<void>;
  /** Catalog facts for an imported model. Absent = the in-process catalog. */
  lookupCatalog?: CatalogModelLookup;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function refuse(
  code: ModelRegistryRefusalCode,
  message: string,
  extra: { problems?: ModelRegistryProblem[]; referents?: ModelReferent[] } = {},
): ModelRegistryRefusal {
  return {
    ok: false,
    code,
    message,
    problems: extra.problems ?? [],
    referents: extra.referents ?? [],
  };
}

function hasEntry(registry: ModelRegistry | undefined, alias: string): boolean {
  return registry !== undefined && Object.hasOwn(registry.entries, alias);
}

function configuredSet(registry: ModelRegistry | undefined): string {
  const aliases = Object.keys(registry?.entries ?? {});
  return aliases.length === 0
    ? 'No models are configured.'
    : `Configured models: ${aliases.join(', ')}.`;
}

/** The chain `validateModelRegistry` checks keys against; the top-level
 *  provider is chain index 0 when there is no chain (D2). */
function providersOf(raw: RawConfig): ProviderChainEntry[] {
  if (raw.providers.length > 0) return raw.providers;
  return raw.provider ? [{ provider: raw.provider }] : [];
}

/** The problems `after` has that `before` did not — what a write would introduce.
 *  Pre-existing problems (a hand edit) never block an unrelated action. The diff
 *  is `introducedModelRegistryProblems` (`@ethosagent/config`), shared with
 *  `ConfigService.update`'s adopt-on-save. */
function introducedProblems(
  before: ModelRegistry | undefined,
  after: ModelRegistry,
  providers: readonly ProviderChainEntry[],
): ModelRegistryProblem[] {
  return introducedModelRegistryProblems(before, providers, after, providers);
}

function providerRefuse(
  code: ModelRegistryProviderRefusalCode,
  message: string,
  extra: { problems?: ModelRegistryProblem[]; aliases?: string[] } = {},
): ModelRegistryProviderRefusal {
  return {
    ok: false,
    code,
    message,
    problems: extra.problems ?? [],
    aliases: extra.aliases ?? [],
  };
}

/** The charset a provider id must be in — the one `assertProviderIds`
 *  (config.service.ts) enforces on a Settings save. */
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]+$/;
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** One provider entry as a registry key addresses it. */
interface LocatedProvider {
  index: number;
  /** `deriveProviderKey`: the explicit id, else the positional display name. */
  key: string;
  entry: RawProviderEntry;
}

/** Every provider entry in chain order; the top-level provider is index 0 when
 *  there is no chain (D2) — the same rows `providerEntries` (wiring) lists. */
function providerRows(raw: RawConfig): LocatedProvider[] {
  if (raw.providers.length > 0) {
    return raw.providers.map((entry, index) => ({
      index,
      entry,
      key: deriveProviderKey(entry, index),
    }));
  }
  if (!raw.provider) return [];
  const entry = topLevelChainEntry(raw);
  return [{ index: 0, entry, key: deriveProviderKey(entry, 0) }];
}

/** An explicit id wins over a derived key, as in `findProviderEntry` (wiring). */
function locateProvider(raw: RawConfig, key: string): LocatedProvider | undefined {
  const rows = providerRows(raw);
  return rows.find((r) => r.entry.id === key) ?? rows.find((r) => r.key === key);
}

function unknownProvider(raw: RawConfig, key: string): ModelRegistryProviderRefusal {
  const keys = providerRows(raw).map((r) => r.key);
  return providerRefuse(
    'unknown_provider',
    `There is no provider entry "${key}". ${
      keys.length > 0
        ? `Provider entries: ${keys.join(', ')}.`
        : 'No provider entries are configured.'
    }`,
  );
}

/**
 * Whether the top-level provider fields are the runtime's spelling of chain
 * entry `found`. Below two chain entries `createLLM` (packages/wiring) reads the
 * top-level fields, not the chain, and `ethos fallback add` /
 * `ConfigService.update` keep them equal to entry 0 — so a write to that entry
 * that did not also reach the top level would be a setting with no effect.
 */
function topLevelMirrors(raw: RawConfig, found: LocatedProvider): boolean {
  return found.index === 0 && raw.providers.length < 2 && raw.provider === found.entry.provider;
}

const TOP_LEVEL_PASSTHROUGH_FIELDS = ['apiVersion', 'region', 'awsProfile'] as const;

/** The top-level provider fields replaced by `head`'s — for a removal that
 *  leaves the chain below two entries with a different head. */
function withTopLevelFrom(raw: RawConfig, head: RawProviderEntry): RawConfig {
  const passthrough = { ...raw.passthrough };
  for (const field of TOP_LEVEL_PASSTHROUGH_FIELDS) {
    const value = head[field];
    if (value) passthrough[field] = value;
    else delete passthrough[field];
  }
  const next: RawConfig = { ...raw, provider: head.provider, passthrough };
  for (const field of ['apiKey', 'model', 'baseUrl'] as const) {
    const value = head[field];
    if (value) next[field] = value;
    else delete next[field];
  }
  return next;
}

/** `undefined` = keep, `null` = remove the line, a string = set it. */
interface ProviderFieldEdits {
  apiKey?: string;
  baseUrl?: string | null;
  apiVersion?: string | null;
  region?: string | null;
  awsProfile?: string | null;
}

function providerEdits(input: ModelRegistryUpdateProviderInput): ProviderFieldEdits {
  const edits: ProviderFieldEdits = {};
  const apiKey = input.apiKey?.trim();
  if (apiKey) edits.apiKey = apiKey;
  for (const field of ['baseUrl', ...TOP_LEVEL_PASSTHROUGH_FIELDS] as const) {
    const value = input[field];
    if (value !== undefined) edits[field] = value.trim() || null;
  }
  return edits;
}

function editEntry(entry: RawProviderEntry, edits: ProviderFieldEdits): RawProviderEntry {
  const next: RawProviderEntry = { ...entry };
  if (edits.apiKey) next.apiKey = edits.apiKey;
  for (const field of ['baseUrl', ...TOP_LEVEL_PASSTHROUGH_FIELDS] as const) {
    const value = edits[field];
    if (value === null) delete next[field];
    else if (value !== undefined) next[field] = value;
  }
  return next;
}

/** The same edits on the top-level spelling, whose `apiVersion` / `region` /
 *  `awsProfile` live in `passthrough` (`topLevelChainEntry`, config.service.ts). */
function editTopLevel(raw: RawConfig, edits: ProviderFieldEdits): RawConfig {
  const next: RawConfig = { ...raw, passthrough: { ...raw.passthrough } };
  if (edits.apiKey) next.apiKey = edits.apiKey;
  if (edits.baseUrl === null) delete next.baseUrl;
  else if (edits.baseUrl !== undefined) next.baseUrl = edits.baseUrl;
  for (const field of TOP_LEVEL_PASSTHROUGH_FIELDS) {
    const value = edits[field];
    if (value === null) delete next.passthrough[field];
    else if (value !== undefined) next.passthrough[field] = value;
  }
  return next;
}

function emptyRegistry(): ModelRegistry {
  return { entries: {}, roles: {} };
}

/** Every place `alias` is named. */
function referentsOf(
  alias: string,
  registry: ModelRegistry | undefined,
  routing: Record<string, string>,
  personalities: ReturnType<ModelRegistryPersonalities['list']>,
): ModelReferent[] {
  const out: ModelReferent[] = [];
  for (const p of personalities) {
    const readOnly = p.builtin;
    if (typeof p.model === 'string') {
      if (p.model.trim() === alias) {
        out.push({ kind: 'personality', personalityId: p.id, field: 'model', readOnly });
      }
    } else if (p.model) {
      for (const role of MODEL_ROLE_NAMES) {
        if (p.model[role]?.trim() === alias) {
          out.push({ kind: 'personality', personalityId: p.id, field: `model.${role}`, readOnly });
        }
      }
    }
    if (p.voiceModel?.trim() === alias) {
      out.push({ kind: 'personality', personalityId: p.id, field: 'voice.model', readOnly });
    }
  }
  for (const role of MODEL_ROLE_NAMES) {
    if (registry?.roles[role] === alias) out.push({ kind: 'role', role });
  }
  if (registry?.default === alias) out.push({ kind: 'default' });
  for (const [personalityId, value] of Object.entries(routing)) {
    if (value.trim() === alias) out.push({ kind: 'routing', personalityId });
  }
  for (const [other, entry] of Object.entries(registry?.entries ?? {})) {
    if (other !== alias && entry.fallbacks?.includes(alias))
      out.push({ kind: 'fallback', alias: other });
  }
  return out;
}

/**
 * The config half of `remove`: the entry gone and, when `repointTo` is given,
 * every config-side referent (default, role bindings, routing, other entries'
 * fallbacks) pointing at it instead. Pure, so it runs once against the pre-read
 * config to validate and again inside the write lock against the current one.
 */
function applyRemoval(raw: RawConfig, alias: string, repointTo: string | undefined): RawConfig {
  const registry = raw.modelRegistry ?? emptyRegistry();
  const entries: Record<string, ModelRegistryEntry> = {};
  for (const [key, entry] of Object.entries(registry.entries)) {
    if (key === alias) continue;
    if (repointTo === undefined || !entry.fallbacks?.includes(alias)) {
      entries[key] = entry;
      continue;
    }
    // Repointed, deduplicated, and never an entry falling back to itself.
    const fallbacks = [
      ...new Set(
        entry.fallbacks.map((f) => (f === alias ? repointTo : f)).filter((f) => f !== key),
      ),
    ];
    const { fallbacks: _dropped, ...rest } = entry;
    entries[key] = fallbacks.length > 0 ? { ...rest, fallbacks } : rest;
  }
  const next: ModelRegistry = { ...registry, entries, roles: { ...registry.roles } };
  const modelRouting = { ...raw.modelRouting };
  if (repointTo !== undefined) {
    if (next.default === alias) next.default = repointTo;
    for (const role of MODEL_ROLE_NAMES) {
      if (next.roles[role] === alias) next.roles[role] = repointTo;
    }
    for (const [pid, value] of Object.entries(modelRouting)) {
      if (value.trim() === alias) modelRouting[pid] = repointTo;
    }
  }
  return { ...raw, modelRegistry: next, modelRouting };
}

/** A personality's `model` with every leaf naming `alias` replaced. */
function repointModel(
  model: string | ModelTierConfig | undefined,
  alias: string,
  to: string,
): string | ModelTierConfig | undefined {
  if (typeof model === 'string') return model.trim() === alias ? to : undefined;
  if (!model) return undefined;
  let changed = false;
  const next: ModelTierConfig = { ...model };
  for (const role of MODEL_ROLE_NAMES) {
    if (next[role]?.trim() === alias) {
      next[role] = to;
      changed = true;
    }
  }
  return changed ? next : undefined;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class ModelRegistryService {
  constructor(private readonly opts: ModelRegistryServiceOptions) {}

  /** The roster, its bindings, the provider entries it may name, and who uses what. */
  async list(): Promise<ModelRegistryListResult> {
    await this.opts.personalities.refresh();
    const config = await this.opts.readConfig();
    const registry = config?.modelRegistry;
    const routing = config?.modelRouting ?? {};
    const personalities = this.opts.personalities.list();
    const refs = config ? providerEntries(config) : [];
    const secrets = this.opts.secrets;

    const credentialByKey = new Map<string, ProviderCredentialStatus>();
    const providerViews: ModelProviderEntryView[] = [];
    for (const [index, ref] of refs.entries()) {
      const credential = await providerCredentialStatus(ref.entry, secrets);
      if (ref.entry.id && !credentialByKey.has(ref.entry.id))
        credentialByKey.set(ref.entry.id, credential);
      if (!credentialByKey.has(ref.key)) credentialByKey.set(ref.key, credential);
      providerViews.push({
        key: ref.key,
        index,
        provider: ref.entry.provider,
        id: ref.entry.id ?? null,
        explicitId: Boolean(ref.entry.id),
        model: ref.entry.model ?? null,
        failover: ref.entry.failover ?? true,
        apiVersion: ref.entry.apiVersion ?? null,
        region: ref.entry.region ?? null,
        awsProfile: ref.entry.awsProfile ?? null,
        credential,
        referenceable: Boolean(ref.entry.id),
        reason: ref.entry.id
          ? null
          : `Provider entry "${ref.key}" has no explicit id, so a model cannot reference it: its derived name changes when the chain is reordered (D24). Give it one — providers.${index}.id: <id>.`,
      });
    }

    const entries = Object.values(registry?.entries ?? {}).map(
      (entry): ModelRegistryEntryView => ({
        alias: entry.alias,
        providerKey: entry.provider,
        modelId: entry.modelId,
        label: entry.label ?? null,
        contextWindow: entry.contextWindow ?? null,
        costPer1kInput: entry.costPer1kInput ?? null,
        costPer1kOutput: entry.costPer1kOutput ?? null,
        fallbacks: entry.fallbacks ?? [],
        // An alias naming a provider entry this config lacks has no credential.
        credential: credentialByKey.get(entry.provider) ?? 'missing',
        referents: referentsOf(entry.alias, registry, routing, personalities),
      }),
    );

    return {
      // A configured model is never hidden: what the chain declares and the
      // registry lacks is listed, and `importChain` adopts it.
      chainModels: config ? planChainModelImport(config).candidates : [],
      entries,
      default: registry?.default ?? null,
      roles: {
        trivial: registry?.roles.trivial ?? null,
        default: registry?.roles.default ?? null,
        deep: registry?.roles.deep ?? null,
        dreaming: registry?.roles.dreaming ?? null,
      },
      providerEntries: providerViews,
      routing,
      problems: validateModelRegistry(
        registry,
        refs.map((r) => r.entry),
      ),
    };
  }

  /**
   * Create or update one entry. The alias is immutable: `update` of an alias
   * that does not exist is refused rather than created, and there is no rename.
   * On update, `label` / `contextWindow` / cost are replaced by what is sent
   * (absent clears) and `fallbacks` is kept. The first entry of an empty
   * registry becomes `modelRegistry.default`, so the roster is never non-empty
   * without one. Refusals are `validateModelRegistry`'s, limited to problems
   * this write would INTRODUCE.
   */
  async upsert(input: ModelRegistryUpsertInput): Promise<ModelRegistryWriteResult> {
    const { alias } = input;
    return this.opts.config.transform<ModelRegistryWriteResult>((raw) => {
      const registry = raw.modelRegistry ?? emptyRegistry();
      const exists = hasEntry(registry, alias);
      if (input.mode === 'create' && exists) {
        return {
          next: null,
          result: refuse(
            'duplicate_alias',
            `A model named "${alias}" already exists, and an alias cannot be reused. ${configuredSet(registry)}`,
          ),
        };
      }
      if (input.mode === 'update' && !exists) {
        return {
          next: null,
          result: refuse(
            'unknown_alias',
            `There is no model "${alias}" to update (an alias cannot be renamed). ${configuredSet(registry)}`,
          ),
        };
      }
      const previous = exists ? registry.entries[alias] : undefined;
      const label = input.label?.trim();
      const entry: ModelRegistryEntry = {
        alias,
        provider: input.provider.trim(),
        modelId: input.modelId.trim(),
        ...(label ? { label } : {}),
        ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
        ...(input.costPer1kInput !== undefined ? { costPer1kInput: input.costPer1kInput } : {}),
        ...(input.costPer1kOutput !== undefined ? { costPer1kOutput: input.costPer1kOutput } : {}),
        ...(previous?.fallbacks ? { fallbacks: previous.fallbacks } : {}),
      };
      // A computed key on a fresh literal is an own property, `__proto__`
      // included — and `validateModelRegistry` refuses that name below.
      const next: ModelRegistry = {
        ...registry,
        entries: { ...registry.entries, [alias]: entry },
        ...(Object.keys(registry.entries).length === 0 && registry.default === undefined
          ? { default: alias }
          : {}),
      };
      const problems = introducedProblems(raw.modelRegistry, next, providersOf(raw));
      if (problems.length > 0) {
        return {
          next: null,
          result: refuse('invalid_entry', problems.map((p) => p.message).join(' '), { problems }),
        };
      }
      return { next: { ...raw, modelRegistry: next }, result: { ok: true } };
    });
  }

  /** `modelRegistry.default: <alias>` — the Default radio. */
  async setDefault(input: { alias: string }): Promise<ModelRegistryWriteResult> {
    return this.opts.config.transform<ModelRegistryWriteResult>((raw) => {
      const registry = raw.modelRegistry;
      if (!registry || !hasEntry(registry, input.alias)) {
        return {
          next: null,
          result: refuse(
            'unknown_alias',
            `There is no model "${input.alias}" to make the default. ${configuredSet(registry)}`,
          ),
        };
      }
      return {
        next: { ...raw, modelRegistry: { ...registry, default: input.alias } },
        result: { ok: true },
      };
    });
  }

  /** `modelRegistry.roles.<role>: <alias>`; `alias: null` deletes the binding line. */
  async setRole(input: {
    role: ModelRegistryBindableRole;
    alias: string | null;
  }): Promise<ModelRegistryWriteResult> {
    const { role, alias } = input;
    return this.opts.config.transform<ModelRegistryWriteResult>((raw) => {
      const registry = raw.modelRegistry ?? emptyRegistry();
      if (alias !== null && !hasEntry(registry, alias)) {
        return {
          next: null,
          result: refuse(
            'unknown_alias',
            `Role "${role}" cannot be bound to "${alias}", which is not a configured model. ${configuredSet(registry)}`,
          ),
        };
      }
      const roles = { ...registry.roles };
      if (alias === null) delete roles[role];
      else roles[role] = alias;
      return {
        next: { ...raw, modelRegistry: { ...registry, roles } },
        result: { ok: true },
      };
    });
  }

  /**
   * `modelRouting.<personalityId>: <declaration>` (T2.7), validated as a role or
   * a configured alias by `parseModelDeclaration`. `null` deletes the line.
   */
  async setRouting(input: {
    personalityId: string;
    declaration: string | null;
  }): Promise<ModelRegistryWriteResult> {
    const { personalityId } = input;
    await this.opts.personalities.refresh();
    const known = this.opts.personalities.list().map((p) => p.id);
    if (input.declaration !== null && !known.includes(personalityId)) {
      return refuse(
        'unknown_personality',
        `There is no personality "${personalityId}" to route. Personalities: ${known.join(', ') || '(none)'}.`,
      );
    }
    return this.opts.config.transform<ModelRegistryWriteResult>((raw) => {
      const modelRouting = { ...raw.modelRouting };
      if (input.declaration === null) {
        delete modelRouting[personalityId];
        return { next: { ...raw, modelRouting }, result: { ok: true } };
      }
      const parsed = parseModelDeclaration(input.declaration, raw);
      if (parsed.kind === 'invalid') {
        return {
          next: null,
          result: refuse(
            'invalid_declaration',
            `${parsed.reason} Valid choices: ${parsed.suggestions.join(', ')}.`,
          ),
        };
      }
      const value = parsed.kind === 'role' ? parsed.role : parsed.alias;
      modelRouting[personalityId] = value;
      return { next: { ...raw, modelRouting }, result: { ok: true } };
    });
  }

  /**
   * Remove one entry (D17.6a). An alias something names is refused, carrying
   * the referent list, unless the caller chose:
   *
   * - `repointTo` — every WRITABLE referent is rewritten to that alias (each
   *   custom personality's `config.yaml` through the personality registry, then
   *   every config-side referent and the removal in ONE config.yaml write).
   *   Built-in personalities are read-only; they are returned in
   *   `needsAttention` and refuse at turn time (D14).
   * - `force` — the entry is removed and nothing is rewritten; every referent
   *   is returned in `needsAttention` (D6/D14: refuse at turn time, never a
   *   silent reroute).
   */
  async remove(input: {
    alias: string;
    repointTo?: string | undefined;
    force?: boolean | undefined;
  }): Promise<ModelRegistryRemoveResult> {
    const { alias, repointTo } = input;
    await this.opts.personalities.refresh();
    const raw = await this.opts.config.read();
    if (!raw) {
      return refuse(
        'config_missing',
        'No config found at ~/.ethos/config.yaml, so there is no model to remove.',
      );
    }
    const registry = raw.modelRegistry;
    if (!hasEntry(registry, alias)) {
      return refuse(
        'unknown_alias',
        `There is no model "${alias}" to remove. ${configuredSet(registry)}`,
      );
    }
    if (repointTo !== undefined && input.force) {
      return refuse('invalid_repoint', 'Pass either repointTo or force, not both.');
    }
    if (repointTo !== undefined && (repointTo === alias || !hasEntry(registry, repointTo))) {
      return refuse(
        'invalid_repoint',
        `Cannot repoint "${alias}"'s referents to "${repointTo}": pick another configured model. ${configuredSet(registry)}`,
      );
    }

    const personalities = this.opts.personalities.list();
    const referents = referentsOf(alias, registry, raw.modelRouting, personalities);
    if (referents.length > 0 && repointTo === undefined && !input.force) {
      return refuse(
        'referenced',
        `"${alias}" is used by ${referents.length} ${referents.length === 1 ? 'referent' : 'referents'}. Removing it stops them from running until they are repointed.`,
        { referents },
      );
    }

    if (repointTo !== undefined) {
      // Validate the config half BEFORE any personality file is touched, so a
      // repoint that would break the registry (a fallback crossing providers)
      // writes nothing at all.
      const problems = introducedProblems(
        registry,
        applyRemoval(raw, alias, repointTo).modelRegistry ?? emptyRegistry(),
        providersOf(raw),
      );
      if (problems.length > 0) {
        return refuse('invalid_repoint', problems.map((p) => p.message).join(' '), {
          problems,
          referents,
        });
      }
      for (const p of personalities) {
        if (p.builtin) continue;
        const model = repointModel(p.model, alias, repointTo);
        const voiceModel = p.voiceModel?.trim() === alias ? repointTo : undefined;
        if (model === undefined && voiceModel === undefined) continue;
        await this.opts.personalities.setModel(p.id, {
          ...(model !== undefined ? { model } : {}),
          ...(voiceModel !== undefined ? { voiceModel } : {}),
        });
      }
    }

    await this.opts.config.transform<undefined>((current) => ({
      next: applyRemoval(current, alias, repointTo),
      result: undefined,
    }));

    const needsAttention =
      repointTo === undefined
        ? referents
        : referents.filter((r) => r.kind === 'personality' && r.readOnly);
    return {
      ok: true,
      alias,
      repointedTo: repointTo ?? null,
      rewritten:
        repointTo === undefined ? [] : referents.filter((r) => !needsAttention.includes(r)),
      needsAttention,
    };
  }

  /**
   * Probe a model once — a saved alias, or an unsaved `(providerKey, modelId)`
   * from the Add/Edit form (D19.1). `caller` is the rate-limit bucket alongside
   * the subject. This app has no per-user identity to key on — the cookie
   * session and a bearer API key are all a handler can tell apart — so every
   * cookie caller shares one bucket. That is the STRICTER direction.
   */
  async test(target: ModelTestTarget, caller: string): Promise<ModelTestOutcome> {
    const config = await this.opts.readConfig();
    if (!config) {
      return {
        state: 'unconfigured',
        ...target,
        reason: 'No config found at ~/.ethos/config.yaml, so there is no registry to test against.',
        fix: 'Run onboarding, or `ethos setup` from the CLI.',
      };
    }
    return testModel({ target, config, caller, ...this.seams() });
  }

  /**
   * One test per provider ENTRY the registry references — the grouping
   * `ethos models test --all` uses (`providerEntryProbes`), each through the
   * same `testModel` and limiter. Run in parallel: they are distinct entries,
   * so no credential is probed twice.
   */
  async testAll(caller: string): Promise<ModelRegistryTestAllResult> {
    const config = await this.opts.readConfig();
    if (!config) return { results: [] };
    const results = await Promise.all(
      providerEntryProbes(config.modelRegistry).map(async (t) => ({
        providerKey: t.providerKey,
        aliases: t.aliases,
        outcome: await testModel({ target: { alias: t.alias }, config, caller, ...this.seams() }),
      })),
    );
    return { results };
  }

  // -------------------------------------------------------------------------
  // Chain import (D11a) and provider-entry writes
  // -------------------------------------------------------------------------

  /**
   * Adopt chain models into the registry in ONE config.yaml write: every
   * `list().chainModels` candidate, or those whose `providerKey` is listed. The
   * plan is `planChainModelImport` — the importer `ethos migrate models` prints
   * — so a re-run is a no-op and writes nothing. Refused only on a
   * `validateModelRegistry` problem the import itself would introduce.
   */
  async importChain(input: {
    providerKeys?: string[] | undefined;
  }): Promise<ModelRegistryImportChainResult> {
    if (!(await this.opts.config.exists())) {
      return refuse(
        'config_missing',
        'No config found at ~/.ethos/config.yaml, so there is no provider chain to import.',
      );
    }
    return this.opts.config.transform<ModelRegistryImportChainResult>((raw) => {
      const plan = planChainModelImport(chainImportSource(raw), {
        providerKeys: input.providerKeys,
        lookupCatalog: this.opts.lookupCatalog ?? lookupCatalogModel,
      });
      const ok = {
        ok: true as const,
        adopted: plan.adopted,
        defaultSet: plan.defaultSet,
        idsWritten: plan.idsWritten,
      };
      if (plan.diff.length === 0) return { next: null, result: ok };
      const problems = introducedModelRegistryProblems(
        raw.modelRegistry,
        providersOf(raw),
        plan.registry,
        plan.providers,
      );
      if (problems.length > 0) {
        return {
          next: null,
          result: refuse('invalid_entry', problems.map((p) => p.message).join(' '), { problems }),
        };
      }
      return {
        next: {
          ...raw,
          providers: plan.providers,
          ...(plan.registry ? { modelRegistry: plan.registry } : {}),
        },
        result: ok,
      };
    });
  }

  /**
   * Append a provider entry with an explicit id, and upsert its models into the
   * registry, in ONE write. A model with no alias takes the importer's slug rule
   * (`uniqueModelAlias`); the first model's id becomes `providers.<n>.model`;
   * the first model of an empty registry becomes the default (as `upsert`).
   * The key goes to the vault on write (`ConfigRepository.externalizeSecrets`).
   *
   * Growing a chain of fewer than two entries puts the top-level provider at
   * its head first — below two entries the runtime reads the top-level fields,
   * from two on the chain alone (`createLLM`, packages/wiring) — the same rule
   * `ethos fallback add` applies, so adding a provider never drops the primary.
   */
  async addProvider(input: ModelRegistryAddProviderInput): Promise<ModelRegistryAddProviderResult> {
    return this.opts.config.transform<ModelRegistryAddProviderResult>((raw) => {
      const decline = (result: ModelRegistryProviderRefusal) => ({ next: null, result });
      const provider = input.provider.trim();
      if (!provider) {
        return decline(
          providerRefuse(
            'invalid_provider',
            'A provider entry needs a provider type, e.g. anthropic or ollama.',
          ),
        );
      }
      const id = input.id.trim();
      if (!PROVIDER_ID_RE.test(id) || RESERVED_OBJECT_KEYS.has(id)) {
        return decline(
          providerRefuse(
            'invalid_id',
            `Provider id "${id}" is not usable: it must match ${PROVIDER_ID_RE.source} (letters, digits, hyphens, underscores), and every model on this provider names it.`,
          ),
        );
      }

      const chain = raw.providers.map((entry) => ({ ...entry }));
      if (chain.length < 2 && raw.provider) {
        const top = topLevelChainEntry(raw);
        const head = chain[0];
        if (head && head.provider === top.provider) chain[0] = fillFromTopLevel(head, top);
        else chain.unshift(top);
      }
      const keys = chain.map((entry, index) => deriveProviderKey(entry, index));
      if (keys.includes(id)) {
        return decline(
          providerRefuse(
            'duplicate_id',
            `Provider id "${id}" already names another provider entry. Provider entries: ${keys.join(', ')}.`,
          ),
        );
      }

      const registry = raw.modelRegistry ?? emptyRegistry();
      const taken = new Set(Object.keys(registry.entries));
      const seen = new Set<string>();
      const models: ModelRegistryEntry[] = [];
      for (const [n, model] of input.models.entries()) {
        const modelId = model.modelId.trim();
        if (!modelId) {
          return decline(
            providerRefuse(
              'invalid_model',
              `Model ${n + 1} has no model id — the vendor id sent on the wire.`,
            ),
          );
        }
        if (seen.has(modelId)) {
          return decline(
            providerRefuse('invalid_model', `Model "${modelId}" is listed twice for "${id}".`),
          );
        }
        seen.add(modelId);
        const requested = model.alias?.trim();
        if (requested && taken.has(requested)) {
          return decline(
            providerRefuse(
              'duplicate_alias',
              `A model named "${requested}" already exists, and an alias cannot be reused. ${configuredSet(registry)}`,
              { aliases: [requested] },
            ),
          );
        }
        const alias = requested || uniqueModelAlias(modelId, id, taken);
        taken.add(alias);
        const label = model.label?.trim();
        models.push({
          alias,
          provider: id,
          modelId,
          ...(label ? { label } : {}),
          ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
          ...(model.costPer1kInput !== undefined ? { costPer1kInput: model.costPer1kInput } : {}),
          ...(model.costPer1kOutput !== undefined
            ? { costPer1kOutput: model.costPer1kOutput }
            : {}),
        });
      }

      const index = chain.length;
      const apiKey = input.apiKey?.trim();
      const entry: RawProviderEntry = { provider, id };
      if (apiKey) entry.apiKey = apiKey;
      if (models[0]) entry.model = models[0].modelId;
      for (const field of ['baseUrl', ...TOP_LEVEL_PASSTHROUGH_FIELDS] as const) {
        const value = input[field]?.trim();
        if (value) entry[field] = value;
      }
      if (input.failover === false) entry.failover = false;
      chain.push(entry);

      const first = models[0];
      const nextRegistry: ModelRegistry | undefined =
        models.length === 0
          ? raw.modelRegistry
          : {
              ...registry,
              entries: {
                ...registry.entries,
                ...Object.fromEntries(models.map((m) => [m.alias, m])),
              },
              roles: { ...registry.roles },
              ...(first &&
              Object.keys(registry.entries).length === 0 &&
              registry.default === undefined
                ? { default: first.alias }
                : {}),
            };
      const problems = introducedModelRegistryProblems(
        raw.modelRegistry,
        providersOf(raw),
        nextRegistry,
        chain,
      );
      if (problems.length > 0) {
        return decline(
          providerRefuse('invalid_model', problems.map((p) => p.message).join(' '), { problems }),
        );
      }
      return {
        next: {
          ...raw,
          providers: chain,
          ...(nextRegistry ? { modelRegistry: nextRegistry } : {}),
        },
        result: {
          ok: true,
          providerKey: id,
          index,
          models: models.map((m) => ({ alias: m.alias, providerKey: id, modelId: m.modelId })),
        },
      };
    });
  }

  /**
   * Edit one provider entry's credential and endpoint fields. The id is
   * immutable here. A top-level-only config edits the top-level lines; entry 0
   * of a chain shorter than two also edits them (`topLevelMirrors`). A replaced
   * key's old vault entry is deleted once nothing references it.
   */
  async updateProvider(
    input: ModelRegistryUpdateProviderInput,
  ): Promise<ModelRegistryProviderWriteResult> {
    const before: { raw?: RawConfig } = {};
    const result = await this.opts.config.transform<ModelRegistryProviderWriteResult>((raw) => {
      before.raw = raw;
      const found = locateProvider(raw, input.key);
      if (!found) return { next: null, result: unknownProvider(raw, input.key) };
      const edits = providerEdits(input);
      let next: RawConfig;
      if (raw.providers.length === 0) {
        next = editTopLevel(raw, edits);
      } else {
        const chain = raw.providers.map((entry) => ({ ...entry }));
        chain[found.index] = editEntry(found.entry, edits);
        next = { ...raw, providers: chain };
        if (topLevelMirrors(raw, found)) next = editTopLevel(next, edits);
      }
      return { next, result: { ok: true, providerKey: found.key, index: found.index } };
    });
    if (result.ok && input.apiKey?.trim() && before.raw) await this.dropOrphanedSecrets(before.raw);
    return result;
  }

  /**
   * Remove one provider entry; later entries move up one index (the chain is
   * re-rendered by `renderProviderChain`). Refused while any registry model
   * references it — naming those models, and which of them is the default, a
   * role binding, or this entry's own fallback model (`providers.<n>.model`) —
   * and refused for the deployment's only provider. When the removal leaves
   * fewer than two entries and took the entry the top-level lines mirrored, the
   * top level takes the new head, because that is what the runtime then reads.
   */
  async removeProvider(input: { key: string }): Promise<ModelRegistryProviderWriteResult> {
    const before: { raw?: RawConfig } = {};
    const result = await this.opts.config.transform<ModelRegistryProviderWriteResult>((raw) => {
      before.raw = raw;
      const found = locateProvider(raw, input.key);
      if (!found) return { next: null, result: unknownProvider(raw, input.key) };
      const registry = raw.modelRegistry;
      const using = Object.values(registry?.entries ?? {}).filter((e) => e.provider === found.key);
      if (using.length > 0) {
        const aliases = using.map((e) => e.alias);
        const one = aliases.length === 1;
        const parts = [
          `Provider entry "${found.key}" is used by ${one ? 'the model' : 'the models'} ${aliases.join(', ')}; removing it would leave ${one ? 'it' : 'them'} pointing at nothing.`,
        ];
        for (const e of using) {
          if (registry?.default === e.alias) parts.push(`"${e.alias}" is the default model.`);
          for (const role of MODEL_ROLE_NAMES) {
            if (registry?.roles[role] === e.alias) {
              parts.push(`"${e.alias}" is bound to the ${role} role.`);
            }
          }
          if (found.entry.model?.trim() === e.modelId) {
            parts.push(
              `"${e.alias}" is this provider's fallback model (providers.${found.index}.model).`,
            );
          }
        }
        parts.push(
          `Remove or repoint ${one ? 'that model' : 'those models'} first. Nothing was removed.`,
        );
        return {
          next: null,
          result: providerRefuse('referenced', parts.join(' '), { aliases }),
        };
      }
      const chain = raw.providers.filter((_, index) => index !== found.index);
      const nothingLeft =
        raw.providers.length === 0 ||
        (chain.length === 0 && (!raw.provider || raw.provider === found.entry.provider));
      if (nothingLeft) {
        return {
          next: null,
          result: providerRefuse(
            'last_provider',
            `Provider entry "${found.key}" is this deployment's only provider, so nothing would be left to run on. Add another provider first, or change it with \`ethos setup\`.`,
          ),
        };
      }
      let next: RawConfig = { ...raw, providers: chain };
      const head = chain[0];
      if (head && found.index === 0 && chain.length < 2 && raw.provider === found.entry.provider) {
        next = withTopLevelFrom(next, head);
      }
      return { next, result: { ok: true, providerKey: found.key, index: found.index } };
    });
    if (result.ok && before.raw) await this.dropOrphanedSecrets(before.raw);
    return result;
  }

  /** Swap one chain entry with its neighbour. Every field and `passthrough`
   *  moves with the entry (`renderProviderChain` re-emits them at the new index). */
  async moveProvider(input: {
    key: string;
    direction: 'up' | 'down';
  }): Promise<ModelRegistryProviderWriteResult> {
    return this.opts.config.transform<ModelRegistryProviderWriteResult>((raw) => {
      const found = locateProvider(raw, input.key);
      if (!found) return { next: null, result: unknownProvider(raw, input.key) };
      const to = input.direction === 'up' ? found.index - 1 : found.index + 1;
      if (raw.providers.length < 2 || to < 0 || to >= raw.providers.length) {
        return {
          next: null,
          result: providerRefuse(
            'cannot_move',
            raw.providers.length < 2
              ? `There is no provider chain to reorder: "${found.key}" is the only entry.`
              : `Provider entry "${found.key}" is already ${input.direction === 'up' ? 'first' : 'last'} in the chain.`,
          ),
        };
      }
      const chain = raw.providers.map((entry) => ({ ...entry }));
      const [moved] = chain.splice(found.index, 1);
      if (!moved) return { next: null, result: unknownProvider(raw, input.key) };
      chain.splice(to, 0, moved);
      return {
        next: { ...raw, providers: chain },
        result: { ok: true, providerKey: deriveProviderKey(moved, to), index: to },
      };
    });
  }

  /** `providers.<n>.failover` (D23b): `false` writes the line, `true` removes a
   *  stored `false` (absent means true) and keeps a stored `true`. */
  async setProviderFailover(input: {
    key: string;
    failover: boolean;
  }): Promise<ModelRegistryProviderWriteResult> {
    return this.opts.config.transform<ModelRegistryProviderWriteResult>((raw) => {
      const found = locateProvider(raw, input.key);
      if (!found) return { next: null, result: unknownProvider(raw, input.key) };
      const ok = { ok: true as const, providerKey: found.key, index: found.index };
      if (raw.providers.length === 0) {
        if (input.failover) return { next: null, result: ok };
        return {
          next: null,
          result: providerRefuse(
            'not_in_chain',
            `Provider entry "${found.key}" is this deployment's only provider (the top-level provider: line), so there is no failover chain for it to leave.`,
          ),
        };
      }
      const chain = raw.providers.map((entry) => ({ ...entry }));
      if (!input.failover) {
        chain[found.index] = { ...found.entry, failover: false };
      } else if (found.entry.failover === false) {
        const { failover: _dropped, ...rest } = found.entry;
        chain[found.index] = rest;
      } else {
        return { next: null, result: ok };
      }
      return { next: { ...raw, providers: chain }, result: ok };
    });
  }

  /**
   * `providers.<n>.model` = the named alias's `modelId` — the model this entry
   * serves when the chain fails over to it. Closed to THIS entry's own models:
   * an alias on another provider entry is refused. `null` removes the line. A
   * top-level-only config writes the top-level `model:`, which cannot be
   * cleared; entry 0 of a chain shorter than two writes both (`topLevelMirrors`).
   */
  async setFallbackModel(input: {
    key: string;
    alias: string | null;
  }): Promise<ModelRegistryProviderWriteResult> {
    return this.opts.config.transform<ModelRegistryProviderWriteResult>((raw) => {
      const found = locateProvider(raw, input.key);
      if (!found) return { next: null, result: unknownProvider(raw, input.key) };
      const ok = { ok: true as const, providerKey: found.key, index: found.index };
      const registry = raw.modelRegistry;
      const own = Object.values(registry?.entries ?? {})
        .filter((e) => e.provider === found.key)
        .map((e) => e.alias);

      if (input.alias === null) {
        if (raw.providers.length === 0) {
          return {
            next: null,
            result: providerRefuse(
              'invalid_model',
              `Provider entry "${found.key}" is the deployment's primary provider, and its model (the top-level model: line) cannot be cleared. Pick another of its models instead.`,
              { aliases: own },
            ),
          };
        }
        const chain = raw.providers.map((entry) => ({ ...entry }));
        const { model: _dropped, ...rest } = found.entry;
        chain[found.index] = rest;
        return { next: { ...raw, providers: chain }, result: ok };
      }

      const target = hasEntry(registry, input.alias) ? registry?.entries[input.alias] : undefined;
      if (!target) {
        return {
          next: null,
          result: providerRefuse(
            'unknown_alias',
            `There is no model "${input.alias}". ${configuredSet(registry)}`,
            { aliases: own },
          ),
        };
      }
      if (target.provider !== found.key) {
        return {
          next: null,
          result: providerRefuse(
            'cross_provider_alias',
            `Model "${target.alias}" runs on provider entry "${target.provider}", not "${found.key}" — a provider's fallback model must be one of its own models. ${
              own.length > 0
                ? `Models on "${found.key}": ${own.join(', ')}.`
                : `No model uses "${found.key}" yet.`
            }`,
            { aliases: own },
          ),
        };
      }
      if (raw.providers.length === 0) {
        return { next: { ...raw, model: target.modelId }, result: ok };
      }
      const chain = raw.providers.map((entry) => ({ ...entry }));
      chain[found.index] = { ...found.entry, model: target.modelId };
      let next: RawConfig = { ...raw, providers: chain };
      if (topLevelMirrors(raw, found)) next = { ...next, model: target.modelId };
      return { next, result: ok };
    });
  }

  /**
   * Test connection for a SAVED provider entry with its stored credential —
   * `testProviderEntry` (wiring): the entry's own model, else its first registry
   * model; neither is `unconfigured`. Rate-limited per provider entry.
   */
  async testProvider(input: { providerKey: string }, caller: string): Promise<ModelTestOutcome> {
    const config = await this.opts.readConfig();
    if (!config) {
      return {
        state: 'unconfigured',
        providerKey: input.providerKey,
        reason: 'No config found at ~/.ethos/config.yaml, so there is no provider entry to test.',
        fix: 'Run onboarding, or `ethos setup` from the CLI.',
      };
    }
    return testProviderEntry({
      providerKey: input.providerKey,
      config,
      caller,
      ...this.seams(),
    });
  }

  /** Every chain-minted vault ref `before` held is a deletion candidate;
   *  `deleteOrphanedSecrets` keeps the ones the written config still names. */
  private async dropOrphanedSecrets(before: RawConfig): Promise<void> {
    await this.opts.deleteOrphanedSecrets?.([
      ...providerChainSecretRefs(before.providers),
      ...topLevelChainSecretRefs(before),
    ]);
  }

  private seams() {
    return {
      secrets: this.opts.secrets,
      ...(this.opts.probe ? { probe: this.opts.probe } : {}),
      ...(this.opts.limiter ? { limiter: this.opts.limiter } : {}),
    };
  }
}
