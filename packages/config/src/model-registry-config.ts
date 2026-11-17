import {
  MODEL_ROLE_NAMES,
  type ModelProfile,
  type ModelRegistry,
  type ModelRegistryEntry,
  type ModelRoleName,
  REASONING_EFFORT_LEVELS,
  type ReasoningEffort,
} from '@ethosagent/types';
import { RESERVED_TOOL_SETTINGS_KEYS } from './keys';
import { parseConfigScalar } from './scalar';

/**
 * D2 — assemble the model registry from parsed flat keys: the per-alias fields,
 * the role bindings, and the roster-level `default`.
 *
 * **It refuses nothing.** An entry missing `provider` or `modelId` is built
 * anyway, with `''` in the missing slot, and an alias the `default` or a role
 * binding names need not exist. That is deliberate and it is where this codec
 * parts company with `parseProviderChain`, which DROPS an index carrying no
 * `provider` line: `validateModelRegistry` (T1.3, not yet written) owes the
 * operator a refusal that names the offending alias and lists the configured
 * set, and it cannot say any of that about an entry this function threw away.
 * The line that produced the half-entry survives a rewrite either way, because
 * `renderModelRegistry` omits empty values and re-emits what is left.
 *
 * Numeric fields are dropped when non-finite, the rule `buildModelProfiles`
 * uses; `fallbacks` is a comma list, trimmed, empties removed. Returns
 * `undefined` when nothing at all is configured, so a deployment with no
 * registry has no `modelRegistry` key rather than an empty one.
 */
function buildModelRegistry(
  kv: Record<string, Record<string, string>>,
  rolesKv: Record<string, string>,
  defaultAlias: string | undefined,
  notices: string[],
): ModelRegistry | undefined {
  const entries: Record<string, ModelRegistryEntry> = {};
  for (const [alias, fields] of Object.entries(kv)) {
    const entry: ModelRegistryEntry = {
      alias,
      provider: fields.provider ?? '',
      modelId: fields.modelId ?? '',
    };
    if (fields.label) entry.label = fields.label;
    // Presence §4 — an effort outside `REASONING_EFFORT_LEVELS` is dropped and
    // named, the rule the numeric fields below follow: a guessed mapping would
    // bill a depth of reasoning nobody chose.
    if (fields.effort !== undefined) {
      if ((REASONING_EFFORT_LEVELS as readonly string[]).includes(fields.effort)) {
        entry.effort = fields.effort as ReasoningEffort;
      } else {
        notices.push(
          `config.yaml: 'modelRegistry.${alias}.effort' must be one of ` +
            `${REASONING_EFFORT_LEVELS.join(', ')} ('${fields.effort}'), so it was ignored.`,
        );
      }
    }
    for (const key of ['contextWindow', 'costPer1kInput', 'costPer1kOutput'] as const) {
      const raw = fields[key];
      if (raw === undefined) continue;
      const n = Number(raw);
      if (Number.isFinite(n)) entry[key] = n;
      else {
        notices.push(
          `config.yaml: 'modelRegistry.${alias}.${key}' is not a number ('${raw}'), so it was ignored.`,
        );
      }
    }
    const fallbacks = (fields.fallbacks ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (fallbacks.length > 0) entry.fallbacks = fallbacks;
    entries[alias] = entry;
  }
  const roles: Partial<Record<ModelRoleName, string>> = {};
  for (const role of MODEL_ROLE_NAMES) {
    const alias = rolesKv[role];
    if (alias) roles[role] = alias;
  }
  const hasAny =
    Object.keys(entries).length > 0 || Object.keys(roles).length > 0 || defaultAlias !== undefined;
  if (!hasAny) return undefined;
  return {
    entries,
    ...(defaultAlias ? { default: defaultAlias } : {}),
    roles,
  };
}

/**
 * D2 — the registry as `key: value` lines, the inverse of the parse branch.
 *
 * Entries keep the order the config gave them (object insertion order, the
 * rule `modelRouting` and `modelCatalog.providers` already follow) so an
 * unrelated save does not reshuffle an operator's file into alphabetical
 * order; fields within an entry follow the D2 listing; then `default`, then the
 * role bindings in `MODEL_ROLE_NAMES` order. Empty values are omitted, which is
 * what lets a half-typed entry round-trip byte-identically.
 *
 * Symmetry with the parser is the point, not a nicety: a `modelRegistry.*` line
 * this function could not produce would be preserved verbatim by
 * `unexpressibleLines` forever, and no writer could ever delete it.
 *
 * **Alias charset.** Nothing here checks that `alias` is inside the parse
 * branch's `[A-Za-z0-9_-]+` charset. Every alias that came from a config file
 * is, by construction; one handed in by a programmatic writer need not be, and
 * an alias containing a space or a colon renders a line no reader claims — the
 * entry would be gone on the next read. The refusal is `validateModelRegistry`'s
 * `invalid_alias` (`./model-registry`), which the one programmatic writer —
 * `ModelRegistryService.upsert` in apps/web-api — runs before it writes; a
 * silent skip here would be a second, quieter place for the entry to vanish.
 */
export function renderModelRegistry(registry: ModelRegistry): string[] {
  return renderModelRegistryPairs(registry).map(([key, value]) => `${key}: ${value}`);
}

/**
 * {@link renderModelRegistry} as `[key, value]` pairs, value encoding left to
 * the caller — the shape `renderProviderChain` has, for the same reason: each
 * config writer applies its own scalar rule to the whole file (apps/web-api's
 * ConfigRepository quotes a label carrying a colon; `writeConfig` does not).
 */
export function renderModelRegistryPairs(registry: ModelRegistry): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [alias, entry] of Object.entries(registry.entries)) {
    if (entry.provider) out.push([`modelRegistry.${alias}.provider`, entry.provider]);
    if (entry.modelId) out.push([`modelRegistry.${alias}.modelId`, entry.modelId]);
    if (entry.label) out.push([`modelRegistry.${alias}.label`, entry.label]);
    if (entry.contextWindow !== undefined) {
      out.push([`modelRegistry.${alias}.contextWindow`, String(entry.contextWindow)]);
    }
    if (entry.effort !== undefined) out.push([`modelRegistry.${alias}.effort`, entry.effort]);
    if (entry.costPer1kInput !== undefined) {
      out.push([`modelRegistry.${alias}.costPer1kInput`, String(entry.costPer1kInput)]);
    }
    if (entry.costPer1kOutput !== undefined) {
      out.push([`modelRegistry.${alias}.costPer1kOutput`, String(entry.costPer1kOutput)]);
    }
    if (entry.fallbacks && entry.fallbacks.length > 0) {
      out.push([`modelRegistry.${alias}.fallbacks`, entry.fallbacks.join(',')]);
    }
  }
  if (registry.default) out.push(['modelRegistry.default', registry.default]);
  for (const role of MODEL_ROLE_NAMES) {
    const alias = registry.roles[role];
    if (alias) out.push([`modelRegistry.roles.${role}`, alias]);
  }
  return out;
}

/** What the `modelRegistry.*` line grammar collects before `buildModelRegistry`. */
interface ModelRegistryLineAcc {
  /** alias → field → raw value. */
  entries: Record<string, Record<string, string>>;
  /** role → alias. */
  roles: Record<string, string>;
  default?: string;
  /** What was dropped and why. */
  notices: string[];
}

export function newModelRegistryLineAcc(notices: string[]): ModelRegistryLineAcc {
  return { entries: {}, roles: {}, notices };
}

/**
 * D2 — the ONE reader of a `modelRegistry.*` line. `parseConfigYaml` and
 * {@link parseModelRegistry} (apps/web-api's ConfigRepository) both call it, so
 * a line one of them claims the other cannot drop. Returns whether the line was
 * claimed.
 */
export function claimModelRegistryLine(line: string, acc: ModelRegistryLineAcc): boolean {
  // modelRegistry.default: <alias> — the roster-level default, matched BEFORE
  // the per-alias branch so it can never be read as an alias named `default`.
  // The colon immediately after `default` already separates the two grammars;
  // this is belt and braces, and it documents the hazard.
  const mrd = line.match(/^modelRegistry\.default:\s*(.+)$/);
  if (mrd?.[1] !== undefined) {
    acc.default = parseConfigScalar(mrd[1]);
    return true;
  }
  // modelRegistry.roles.<role>: <alias>. Claimed only when `<role>` is one of
  // MODEL_ROLE_NAMES; anything else falls through to the per-alias branch, so a
  // registry entry may still be called `roles`. `roles.deep` is the one line
  // that entry could not then own — a role binding wins over an alias field of
  // the same spelling, which is the reading an operator means.
  const mrr = line.match(/^modelRegistry\.roles\.([A-Za-z0-9_-]+):\s*(.+)$/);
  const mrrRole = mrr?.[1];
  if (
    mrr?.[2] !== undefined &&
    mrrRole &&
    (MODEL_ROLE_NAMES as readonly string[]).includes(mrrRole)
  ) {
    acc.roles[mrrRole] = parseConfigScalar(mrr[2]);
    return true;
  }
  // modelRegistry.<alias>.<field>: <value>. The alias charset has no dot and no
  // slash — it is an operator-chosen key, unlike §7's `<providerId>/<modelId>` —
  // so the three segments split unambiguously. The leaf is an anchored fixed
  // set, the same shape §7 uses: a line with an unmodelled leaf is NOT claimed,
  // and is preserved verbatim by `unexpressibleLines` (and by apps/web-api's
  // passthrough block) on the next write rather than being dropped or shovelled
  // into an untyped passthrough on a `@ethosagent/types` contract.
  const mreg = line.match(
    /^modelRegistry\.([A-Za-z0-9_-]+)\.(provider|modelId|label|contextWindow|effort|costPer1kInput|costPer1kOutput|fallbacks):\s*(.+)$/,
  );
  const mrAlias = mreg?.[1];
  const mrField = mreg?.[2];
  if (mreg?.[3] === undefined || !mrAlias || !mrField) return false;
  // Never a computed own-key on the roster — see RESERVED_TOOL_SETTINGS_KEYS.
  // Said out loud rather than skipped in silence: `__proto__` is not a future
  // field name the way an unmodelled leaf might be, so an operator who typed
  // one is never getting the entry they meant.
  if (RESERVED_TOOL_SETTINGS_KEYS.has(mrAlias)) {
    acc.notices.push(
      `config.yaml: 'modelRegistry.${mrAlias}.${mrField}' uses a reserved alias name and was ignored.`,
    );
    return true;
  }
  acc.entries[mrAlias] ??= {};
  acc.entries[mrAlias][mrField] = parseConfigScalar(mreg[3]);
  return true;
}

export function buildModelRegistryFromLines(acc: ModelRegistryLineAcc): ModelRegistry | undefined {
  return buildModelRegistry(acc.entries, acc.roles, acc.default, acc.notices);
}

/**
 * True for a line the `modelRegistry.*` codec claims. A line parser that models
 * the registry (apps/web-api's ConfigRepository) skips these and hands the
 * whole file to {@link parseModelRegistry}; an unclaimed `modelRegistry.*` line
 * (an unmodelled leaf) is NOT one, and stays wherever that parser keeps
 * unknown keys.
 */
export function isModelRegistryLine(line: string): boolean {
  return claimModelRegistryLine(line, newModelRegistryLineAcc([]));
}

/**
 * Parse every `modelRegistry.*` line of a file into a {@link ModelRegistry} —
 * the same grammar and the same refuse-nothing build `parseConfigYaml` uses,
 * for a writer that holds lines rather than an `EthosConfig`. `undefined` when
 * the file configures no registry at all. `notices` is the optional sink for
 * what was dropped and why, as for `parseProviderChain`.
 */
export function parseModelRegistry(
  lines: Iterable<string>,
  notices?: string[],
): ModelRegistry | undefined {
  const acc = newModelRegistryLineAcc(notices ?? []);
  for (const line of lines) claimModelRegistryLine(line, acc);
  return buildModelRegistryFromLines(acc);
}

/**
 * §7 — assemble per-model profile overrides from parsed flat keys. Numeric
 * fields are dropped when non-finite; `toolCallFormat` is dropped unless it is
 * a known enum value. A model key with no valid fields is omitted.
 */
export function buildModelProfiles(
  kv: Record<string, Record<string, string>>,
): Record<string, ModelProfile> | undefined {
  const result: Record<string, ModelProfile> = {};
  for (const [modelKey, fields] of Object.entries(kv)) {
    const profile: ModelProfile = {};
    const sampling: Record<string, number> = {};
    for (const key of ['temperature', 'topP', 'topK', 'minP'] as const) {
      const raw = fields[`sampling.${key}`];
      if (raw === undefined) continue;
      const n = Number(raw);
      if (Number.isFinite(n)) sampling[key] = n;
    }
    if (Object.keys(sampling).length > 0) profile.sampling = sampling;
    if (fields.toolCallFormat === 'openai' || fields.toolCallFormat === 'text-xml') {
      profile.toolCallFormat = fields.toolCallFormat;
    }
    if (fields.maxOutputTokens !== undefined) {
      const n = Number(fields.maxOutputTokens);
      if (Number.isFinite(n)) profile.maxOutputTokens = n;
    }
    if (Object.keys(profile).length > 0) result[modelKey] = profile;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
