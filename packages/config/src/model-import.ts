// D11(a) of plan/phases/model-registry.md — adopt the models a provider chain
// already declares into `modelRegistry.*`.
//
// The rule this module owns: **a configured model is never hidden.** A chain
// entry that declares a `model` IS a model, and it is adopted into the registry
// explicitly and visibly — as lines the operator sees in a diff — rather than as
// a virtual row a listing synthesizes at read time.
//
// ONE implementation, three callers, so they cannot drift:
//   - `ethos migrate models` (apps/ethos/src/commands/migrate-models.ts) prints
//     `diff`, confirms, writes `providers` + `registry`;
//   - `modelRegistry.list` reports `candidates` as `chainModels`, and
//     `modelRegistry.importChain` writes a filtered plan
//     (apps/web-api/src/services/model-registry.service.ts);
//   - `config.update` adopts on save (`ConfigService.update`, same app).
//
// Pure: no I/O, no clock, no catalog of its own. Catalog facts come in through
// `lookupCatalog`, so this package stays free of `@ethosagent/wiring` (which
// sits above it). It refuses nothing — whether the result is a coherent
// registry is `validateModelRegistry`'s question, asked by each writer.

import { MODEL_ROLE_NAMES, type ModelRegistry, type ModelRegistryEntry } from '@ethosagent/types';
import {
  deriveProviderKey,
  type ProviderChainEntry,
  renderModelRegistryPairs,
  renderProviderChain,
} from './index';

/**
 * The slice of a config the importer reads. Both `EthosConfig` (the CLI) and
 * apps/web-api's `RawConfig` (with `apiVersion`/`region`/`awsProfile` lifted out
 * of its passthrough) satisfy it. Values are as stored — an `apiKey` is normally
 * a `${secrets:…}` reference and nothing here resolves it.
 */
export interface ChainModelImportSource {
  provider?: string | undefined;
  model?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  apiVersion?: string | undefined;
  region?: string | undefined;
  awsProfile?: string | undefined;
  providers?: readonly ProviderChainEntry[] | undefined;
  modelRegistry?: ModelRegistry | undefined;
}

/** What the catalog knows about one `(provider type, modelId)` pair. */
export interface CatalogModelFacts {
  label?: string | undefined;
  contextWindow?: number | undefined;
  costPer1kInput?: number | undefined;
  costPer1kOutput?: number | undefined;
}

export type CatalogModelLookup = (
  providerType: string,
  modelId: string,
) => CatalogModelFacts | undefined;

/** One chain model the registry does not have yet. */
export interface ChainModelCandidate {
  /**
   * The key the adopted alias will reference: the entry's explicit `id`, or —
   * for an entry without one — the id the import WRITES (`deriveProviderKey`,
   * made unique), because an alias may reference only an explicit id (D24).
   */
  providerKey: string;
  /** Chain position; `0` for a top-level-only config. */
  index: number;
  /** Provider TYPE, e.g. `codex`. */
  provider: string;
  modelId: string;
  /** The alias adopting this candidate writes. */
  suggestedAlias: string;
  /** False when adopting it also writes `providers.<index>.id`. */
  idIsExplicit: boolean;
}

export interface AdoptedModel {
  alias: string;
  providerKey: string;
  modelId: string;
}

export interface ChainModelImportPlan {
  /** EVERY chain model not in the registry, whatever `providerKeys` selected. */
  candidates: ChainModelCandidate[];
  /** The candidates this plan adopts. */
  adopted: AdoptedModel[];
  /** The alias written to `modelRegistry.default`, when this plan writes one. */
  defaultSet: string | null;
  /** Provider ids this plan makes explicit (D24). */
  idsWritten: string[];
  /** The chain to write. Equal to the source chain when nothing is adopted. */
  providers: ProviderChainEntry[];
  /** The registry to write. The source registry when nothing is adopted. */
  registry: ModelRegistry | undefined;
  /**
   * The lines this plan adds (`+`), changes (`~`) or removes (`-`), in render
   * order. Empty exactly when there is nothing to write. A credential-shaped
   * value that is not a `${secrets:…}` reference is shown as `<redacted>`.
   */
  diff: string[];
}

export interface ChainModelImportOptions {
  /** Adopt only the candidates whose `providerKey` is listed. Absent = all. */
  providerKeys?: readonly string[] | undefined;
  /** Prefills `label` / `contextWindow` / cost when the pair is known. */
  lookupCatalog?: CatalogModelLookup | undefined;
}

/** Names an alias may not take: the role names (D1) and the object-model keys
 *  the registry codec refuses (`RESERVED_OBJECT_KEYS` in `./model-registry`). */
const RESERVED_ALIASES: ReadonlySet<string> = new Set([
  ...MODEL_ROLE_NAMES,
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * A vendor model id as an alias in the registry charset `[A-Za-z0-9_-]+`:
 * lowercased, every run of other characters one `-`, no leading or trailing
 * `-`. `gpt-5.6-terra` → `gpt-5-6-terra`, `qwen2.5-coder:32b` →
 * `qwen2-5-coder-32b`. An id with nothing left becomes `model`.
 */
export function slugifyModelAlias(modelId: string): string {
  const slug = modelId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'model';
}

/**
 * The alias a model gets when nobody chose one: its slug, or — when that is
 * taken or reserved — `<slug>-<providerKey>`, then `<slug>-<providerKey>-2`, ….
 * Shared by the importer and `modelRegistry.addProvider`, so a model added
 * through Settings and one adopted from the chain are named by one rule.
 */
export function uniqueModelAlias(
  modelId: string,
  providerKey: string,
  taken: ReadonlySet<string>,
): string {
  const free = (alias: string): boolean => !taken.has(alias) && !RESERVED_ALIASES.has(alias);
  const base = slugifyModelAlias(modelId);
  if (free(base)) return base;
  const suffixed = `${base}-${slugifyModelAlias(providerKey)}`;
  if (free(suffixed)) return suffixed;
  let n = 2;
  while (!free(`${suffixed}-${n}`)) n++;
  return `${suffixed}-${n}`;
}

/**
 * What adopting the chain's models would write — see the module comment.
 *
 * - One candidate per chain entry declaring a `model` whose `(providerKey,
 *   modelId)` pair no registry entry already has. With no chain, the top-level
 *   `provider`/`model` pair is index 0, and adopting it writes that entry out as
 *   `providers.0.*` — the only place an explicit id can live (D24). The
 *   top-level lines stay, so the runtime (which reads them below two chain
 *   entries, `createLLM` in packages/wiring) is unchanged.
 * - An adopted entry without an `id` gets one: `deriveProviderKey(entry, n)`,
 *   suffixed `-2`, `-3`, … if another entry already claims it.
 * - `modelRegistry.default` is written only when the registry has none and this
 *   plan adopts something: the alias for chain entry 0 (adopted now or already
 *   present), else — when the registry was empty — the first adopted alias, so
 *   the roster is never non-empty without a default (the same invariant
 *   `ModelRegistryService.upsert` keeps).
 * - Role bindings are never touched.
 */
export function planChainModelImport(
  source: ChainModelImportSource,
  opts: ChainModelImportOptions = {},
): ChainModelImportPlan {
  const registry = source.modelRegistry;
  const existing = Object.values(registry?.entries ?? {});
  const sourceChain = source.providers ?? [];
  const materialized = sourceChain.length === 0 && Boolean(source.provider);
  // Copies: ids are written onto these, never onto the caller's entries.
  const entries: ProviderChainEntry[] = materialized
    ? [topLevelEntry(source)]
    : sourceChain.map((entry) => ({ ...entry }));

  // Which entry each key names today — explicit ids first, so a derived key can
  // never take a name an entry deliberately claimed.
  const claims = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (entry.id && !claims.has(entry.id)) claims.set(entry.id, index);
  });
  entries.forEach((entry, index) => {
    const key = deriveProviderKey(entry, index);
    if (!entry.id && !claims.has(key)) claims.set(key, index);
  });

  const keyFor = new Map<number, string>();
  const takenAliases = new Set(Object.keys(registry?.entries ?? {}));
  const candidates: ChainModelCandidate[] = [];
  for (const [index, entry] of entries.entries()) {
    const modelId = entry.model?.trim();
    if (!modelId) continue;
    const providerKey = entry.id ?? unclaimedKey(deriveProviderKey(entry, index), index, claims);
    keyFor.set(index, providerKey);
    if (existing.some((e) => e.provider === providerKey && e.modelId === modelId)) continue;
    const suggestedAlias = uniqueModelAlias(modelId, providerKey, takenAliases);
    takenAliases.add(suggestedAlias);
    candidates.push({
      providerKey,
      index,
      provider: entry.provider,
      modelId,
      suggestedAlias,
      idIsExplicit: Boolean(entry.id),
    });
  }

  const wanted = opts.providerKeys ? new Set(opts.providerKeys) : undefined;
  const nextEntries: Record<string, ModelRegistryEntry> = { ...(registry?.entries ?? {}) };
  const adopted: AdoptedModel[] = [];
  const idsWritten: string[] = [];
  for (const candidate of candidates) {
    if (wanted && !wanted.has(candidate.providerKey)) continue;
    const entry = entries[candidate.index];
    if (!entry) continue;
    if (!entry.id) {
      entry.id = candidate.providerKey;
      idsWritten.push(candidate.providerKey);
    }
    nextEntries[candidate.suggestedAlias] = registryEntry(candidate, opts.lookupCatalog);
    adopted.push({
      alias: candidate.suggestedAlias,
      providerKey: candidate.providerKey,
      modelId: candidate.modelId,
    });
  }

  if (adopted.length === 0) {
    return {
      candidates,
      adopted,
      defaultSet: null,
      idsWritten,
      providers: [...sourceChain],
      registry,
      diff: [],
    };
  }

  let defaultSet: string | null = null;
  if (!registry?.default) {
    const head = entries[0];
    const headKey = keyFor.get(0);
    const headAlias =
      head?.model && headKey
        ? Object.values(nextEntries).find(
            (e) => e.provider === headKey && e.modelId === head.model?.trim(),
          )?.alias
        : undefined;
    defaultSet = headAlias ?? (existing.length === 0 ? (adopted[0]?.alias ?? null) : null);
  }

  const nextRegistry: ModelRegistry = {
    entries: nextEntries,
    roles: { ...(registry?.roles ?? {}) },
    ...(defaultSet
      ? { default: defaultSet }
      : registry?.default
        ? { default: registry.default }
        : {}),
  };
  const diff = [
    ...diffPairs(renderProviderChain(sourceChain), renderProviderChain(entries)),
    ...diffPairs(
      registry ? renderModelRegistryPairs(registry) : [],
      renderModelRegistryPairs(nextRegistry),
    ),
  ];
  return {
    candidates,
    adopted,
    defaultSet,
    idsWritten,
    providers: entries,
    registry: nextRegistry,
    diff,
  };
}

/** The top-level provider fields as chain entry 0 (D2). */
function topLevelEntry(source: ChainModelImportSource): ProviderChainEntry {
  return {
    provider: source.provider ?? '',
    ...(source.apiKey ? { apiKey: source.apiKey } : {}),
    ...(source.model ? { model: source.model } : {}),
    ...(source.baseUrl ? { baseUrl: source.baseUrl } : {}),
    ...(source.apiVersion ? { apiVersion: source.apiVersion } : {}),
    ...(source.region ? { region: source.region } : {}),
    ...(source.awsProfile ? { awsProfile: source.awsProfile } : {}),
  };
}

/** `base`, or `base-2`, `base-3`, … — the first key no OTHER entry claims. */
function unclaimedKey(base: string, index: number, claims: Map<string, number>): string {
  let key = base;
  let n = 2;
  while (claims.has(key) && claims.get(key) !== index) {
    key = `${base}-${n}`;
    n++;
  }
  claims.set(key, index);
  return key;
}

function registryEntry(
  candidate: ChainModelCandidate,
  lookupCatalog: CatalogModelLookup | undefined,
): ModelRegistryEntry {
  const facts = lookupCatalog?.(candidate.provider, candidate.modelId);
  const entry: ModelRegistryEntry = {
    alias: candidate.suggestedAlias,
    provider: candidate.providerKey,
    modelId: candidate.modelId,
  };
  if (facts?.label) entry.label = facts.label;
  if (isPositive(facts?.contextWindow)) entry.contextWindow = facts.contextWindow;
  if (isNonNegative(facts?.costPer1kInput)) entry.costPer1kInput = facts.costPer1kInput;
  if (isNonNegative(facts?.costPer1kOutput)) entry.costPer1kOutput = facts.costPer1kOutput;
  return entry;
}

function isPositive(n: number | undefined): n is number {
  return n !== undefined && Number.isFinite(n) && n > 0;
}

function isNonNegative(n: number | undefined): n is number {
  return n !== undefined && Number.isFinite(n) && n >= 0;
}

const SECRET_REFERENCE = /^\$\{secrets:[^}]+\}$/;
const CREDENTIAL_FIELD = /(key|secret|token|password)$/i;

function shown(key: string, value: string): string {
  const field = key.slice(key.lastIndexOf('.') + 1);
  return CREDENTIAL_FIELD.test(field) && !SECRET_REFERENCE.test(value) ? '<redacted>' : value;
}

function diffPairs(
  before: ReadonlyArray<[string, string]>,
  after: ReadonlyArray<[string, string]>,
): string[] {
  const old = new Map(before);
  const next = new Map(after);
  const out: string[] = [];
  for (const [key, value] of after) {
    const previous = old.get(key);
    if (previous === undefined) out.push(`+ ${key}: ${shown(key, value)}`);
    else if (previous !== value) {
      out.push(`~ ${key}: ${shown(key, previous)} → ${shown(key, value)}`);
    }
  }
  for (const [key, value] of before) {
    if (!next.has(key)) out.push(`- ${key}: ${shown(key, value)}`);
  }
  return out;
}
