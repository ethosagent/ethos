import {
  type AdoptedModel,
  type CatalogModelLookup,
  type ChainModelImportSource,
  introducedModelRegistryProblems,
  isProviderChainSecretRef,
  planChainModelImport,
  secretRefFromValue,
} from '@ethosagent/config';
import { EthosError, type ModelRegistry } from '@ethosagent/types';
import type { RawConfig, RawProviderEntry } from '../../repositories/config.repository';
import type { ConfigUpdateInput, ProviderRowInput } from './update-input';
import { checkRecordKey, invalidValue } from './validate';

/**
 * The repository entry for one incoming row. The page owns `model` and
 * `baseUrl` — it always sends its full visible state, so an absent one was
 * cleared — and `apiKey` only when retyped. Everything else belongs to the
 * stored entry the row came from and is kept: the key reference, `apiVersion`,
 * `region`, `awsProfile` and `passthrough`.
 *
 * A row keeps nothing when its `sourceIndex` is past the stored chain, or when
 * its provider differs from the stored entry's — a key or a region never
 * crosses to a different provider. Stored entries no row points at are
 * dropped, because the caller's list IS the new chain. A row with no
 * `sourceIndex` was resolved by `claimStoredSources` first, so a caller that
 * omits it (the RPC is public; only the Settings page stamps it) still keeps
 * a matched entry's chain-only fields.
 */
export function overlayProviderRow(
  row: ProviderRowInput,
  stored: readonly RawProviderEntry[],
): RawProviderEntry {
  const source = row.sourceIndex !== undefined ? stored[row.sourceIndex] : undefined;
  const entry: RawProviderEntry =
    source && source.provider === row.provider ? { ...source } : { provider: row.provider };
  if (row.model) entry.model = row.model;
  else delete entry.model;
  if (row.baseUrl) entry.baseUrl = row.baseUrl;
  else delete entry.baseUrl;
  if (row.apiKey) entry.apiKey = row.apiKey;
  // `id` / `failover` are OPTIONAL on a row, unlike `model` / `baseUrl`: a page
  // that does not send them (an older client, or a save touching neither) keeps
  // the stored values. Pinned by `__tests__/repositories/config-model-registry.test.ts`,
  // "a provider entry's id and failover flag survive a settings save that
  // touches neither".
  if (row.id !== undefined) {
    if (row.id) entry.id = row.id;
    else delete entry.id;
  }
  // Absent means `true` (D23b): `true` only has to undo a stored `false`, so a
  // stored explicit `failover: true` line is kept rather than churned.
  if (row.failover === false) entry.failover = false;
  else if (row.failover === true && entry.failover === false) delete entry.failover;
  return entry;
}

/**
 * Give each row without a `sourceIndex` the stored entry it evidently came
 * from: the first entry of the same provider that no other row — loaded or
 * resolved here — already claims. The shipped Settings page always stamps
 * `sourceIndex`, but the RPC is public, and a caller sending just
 * `{provider, model, baseUrl}` used to get a rebuilt entry that silently
 * dropped the stored key reference and every chain-only field (`apiVersion`,
 * `region`, `awsProfile`, `outputCapParam`, `passthrough`) — fatal to the
 * one-entry chain that exists only to carry `outputCapParam`
 * (AZURE_OUTPUT_CAP_PARAM, `ethos setup --from-env`). A row whose provider has
 * no unclaimed stored entry is left as it was: a fresh entry, exactly as
 * before (pinned by "a new row, or one whose sourceIndex is stale, is a fresh
 * entry" and the sourceIndex-less cases in `config-provider-chain.test.ts`).
 */
export function claimStoredSources(
  rows: readonly ProviderRowInput[],
  stored: readonly RawProviderEntry[],
): ProviderRowInput[] {
  const claimed = new Set(rows.map((r) => r.sourceIndex).filter((i) => i !== undefined));
  return rows.map((row) => {
    if (row.sourceIndex !== undefined) return row;
    const index = stored.findIndex((e, i) => e.provider === row.provider && !claimed.has(i));
    if (index === -1) return row;
    claimed.add(index);
    return { ...row, sourceIndex: index };
  });
}

/**
 * Refuse a chain whose ids the model registry cannot live with: an id outside
 * `[A-Za-z0-9_-]+`, two entries claiming one id (`findProviderEntry` would
 * silently pick the first), or a stored id that a `modelRegistry.<alias>.provider`
 * references disappearing — a clear or a rename would dangle every such alias
 * and refuse every personality naming one (D24's outage, by a different edit).
 * Throws `CONFIG_INVALID` naming the aliases; nothing is written.
 */
export function assertProviderIds(
  next: readonly RawProviderEntry[],
  stored: readonly RawProviderEntry[],
  registry: ModelRegistry | undefined,
): void {
  const ids = new Set<string>();
  for (const [index, entry] of next.entries()) {
    if (entry.id === undefined) continue;
    checkRecordKey(`providers.${index}.id`, entry.id);
    if (ids.has(entry.id)) {
      invalidValue(`providers.${index}.id`, `"${entry.id}" is already another provider row's id`);
    }
    ids.add(entry.id);
  }
  for (const entry of stored) {
    if (!entry.id || ids.has(entry.id)) continue;
    const id = entry.id;
    const aliases = Object.values(registry?.entries ?? {})
      .filter((e) => e.provider === id)
      .map((e) => e.alias);
    if (aliases.length === 0) continue;
    throw new EthosError({
      code: 'CONFIG_INVALID',
      cause: `Provider entry id "${id}" is used by ${aliases.length === 1 ? 'the model' : 'the models'} ${aliases.join(', ')}; removing or renaming it would leave ${aliases.length === 1 ? 'it' : 'them'} pointing at nothing. Nothing was saved.`,
      action: `Keep the id, or repoint or remove ${aliases.join(', ')} in Settings → Models first.`,
    });
  }
}

/**
 * Refuse a `providers` list the overlay cannot apply unambiguously: no
 * `providersVersion` (nothing to check staleness against), or two rows naming
 * the same stored entry (both would inherit one key reference, and deleting
 * either later would delete the other's secret).
 */
export function assertProviderRows(
  rows: readonly ProviderRowInput[],
  version: string | undefined,
): void {
  if (!version) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: '`providers` was sent without the `providersVersion` it was built from.',
      action: 'Send `providersVersion` from the `config.get` the rows were loaded from.',
    });
  }
  const seen = new Set<number>();
  for (const row of rows) {
    if (row.sourceIndex === undefined) continue;
    if (seen.has(row.sourceIndex)) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Two provider rows claim stored entry ${row.sourceIndex}.`,
        action: 'Send each loaded row once; a new row carries no `sourceIndex`.',
      });
    }
    seen.add(row.sourceIndex);
  }
}

/** Provider-specific top-level lines this repository keeps in `passthrough`. */
const TOP_LEVEL_PROVIDER_FIELDS = ['apiVersion', 'region', 'awsProfile'] as const;

/**
 * What a patch that MOVES the top-level `provider` must do to the rest of the
 * top level. The runtime reads the top-level fields whenever the chain has
 * fewer than two entries (`createLLM`, packages/wiring), so they are one
 * entry and move together: when the new chain row 0 is the new provider, the
 * top level takes that entry's key reference, model, base URL and
 * `apiVersion` / `region` / `awsProfile`; otherwise it takes none of them, and
 * the old provider's are cleared either way — the model included, since a model
 * id belongs to the provider it was chosen for. A value the patch sets itself
 * (a typed key, the page's model and base URL) wins. `{}` / nothing when the
 * patch leaves `provider` where it was. The entry's unmodelled `passthrough`
 * has no top-level home and is not mirrored.
 */
export function mirrorTopLevel(
  patch: ConfigUpdateInput,
  before: RawConfig | null,
  chain: readonly RawProviderEntry[] | undefined,
): { fields: Partial<RawConfig>; set: Record<string, string>; clear: string[] } {
  const none = { fields: {}, set: {}, clear: [] };
  if (patch.provider === undefined || patch.provider === before?.provider) return none;
  const head = (chain ?? before?.providers ?? [])[0];
  const entry = head?.provider === patch.provider ? head : undefined;
  const fields: Partial<RawConfig> = {};
  if (!patch.apiKey) fields.apiKey = entry?.apiKey;
  if (!patch.model) fields.model = entry?.model;
  if (!patch.baseUrl) fields.baseUrl = entry?.baseUrl;
  const set: Record<string, string> = {};
  const clear: string[] = [];
  for (const field of TOP_LEVEL_PROVIDER_FIELDS) {
    const value = entry?.[field];
    if (value) set[field] = value;
    else clear.push(field);
  }
  return { fields, set, clear };
}

/** The top-level provider fields as a chain entry, for `fillFromTopLevel`.
 *  `apiVersion` / `region` / `awsProfile` are top-level lines this repository
 *  does not model, so they sit in `passthrough`. */
export function topLevelChainEntry(raw: RawConfig): RawProviderEntry {
  const p = raw.passthrough;
  return {
    provider: raw.provider ?? '',
    ...(raw.apiKey ? { apiKey: raw.apiKey } : {}),
    ...(raw.model ? { model: raw.model } : {}),
    ...(raw.baseUrl ? { baseUrl: raw.baseUrl } : {}),
    ...(p.apiVersion ? { apiVersion: p.apiVersion } : {}),
    ...(p.region ? { region: p.region } : {}),
    ...(p.awsProfile ? { awsProfile: p.awsProfile } : {}),
  };
}

/** What `planChainModelImport` (`@ethosagent/config`) reads from a repository
 *  config: the top-level provider (`topLevelChainEntry`), the chain, the registry. */
export function chainImportSource(raw: RawConfig): ChainModelImportSource {
  return {
    ...topLevelChainEntry(raw),
    providers: raw.providers,
    modelRegistry: raw.modelRegistry,
  };
}

/**
 * The adopt-on-save half of `ConfigService.update`, run inside the repository
 * lock on the merged config: every chain model the registry lacks is adopted
 * through `planChainModelImport` — the importer `ethos migrate models` and
 * `modelRegistry.importChain` use — except rows at `skipRows` (sent with
 * `id: null`/`''`, whose cleared id adoption would write back).
 *
 * Adoption never blocks a save: a config with no chain adopts nothing (a save
 * must not materialize one), and a plan that would introduce a registry problem
 * (`introducedModelRegistryProblems`) is dropped — the settings still save and
 * the model stays listed in `modelRegistry.list().chainModels`.
 */
export function adoptChainModelsOnSave(
  next: RawConfig,
  skipRows: ReadonlySet<number>,
  lookupCatalog: CatalogModelLookup,
): { next: RawConfig; adopted: AdoptedModel[] } {
  const none = { next, adopted: [] };
  if (next.providers.length === 0) return none;
  const source = chainImportSource(next);
  const providerKeys = planChainModelImport(source)
    .candidates.filter((c) => !skipRows.has(c.index))
    .map((c) => c.providerKey);
  if (providerKeys.length === 0) return none;
  const plan = planChainModelImport(source, { providerKeys, lookupCatalog });
  if (plan.adopted.length === 0) return none;
  const problems = introducedModelRegistryProblems(
    next.modelRegistry,
    next.providers,
    plan.registry,
    plan.providers,
  );
  if (problems.length > 0) return none;
  return {
    next: {
      ...next,
      providers: plan.providers,
      ...(plan.registry ? { modelRegistry: plan.registry } : {}),
    },
    adopted: plan.adopted,
  };
}

/**
 * The deletion candidate among the top-level key fields: the `apiKey` the
 * config held BEFORE the save, and only when it is an index-named chain secret
 * (`isProviderChainSecretRef`) — which it is after a provider move mirrored
 * chain row 0's reference up (`mirrorTopLevel`). The canonical names the
 * writers mint for top-level fields (`providers/<provider>/apiKey`,
 * `auxiliary/*`) are read by name by provider factories and tools and are
 * never candidates. `deleteOrphanedSecrets` keeps any still referenced.
 */
export function topLevelChainSecretRefs(before: RawConfig | null): string[] {
  const ref = before?.apiKey ? secretRefFromValue(before.apiKey) : null;
  return ref && isProviderChainSecretRef(ref) ? [ref] : [];
}

/** The vault refs a chain's entries point at that the chain itself minted
 *  (`providers/<index>/…`, see `externalizeProviderChain` in
 *  @ethosagent/config). Read strictly (`secretRefFromValue`) and limited to
 *  that namespace because these are DELETION candidates: a hand-written ref to
 *  some other secret is not the chain's to remove. */
export function providerChainSecretRefs(chain: readonly RawProviderEntry[]): string[] {
  const refs: string[] = [];
  for (const entry of chain) {
    for (const value of [entry.apiKey ?? '', ...Object.values(entry.passthrough ?? {})]) {
      const ref = secretRefFromValue(value);
      if (ref && isProviderChainSecretRef(ref)) refs.push(ref);
    }
  }
  return refs;
}
