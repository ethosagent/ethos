// The refusals the `modelRegistry.*` codec deliberately does not make.
//
// `buildModelRegistry` in `./index` refuses NOTHING — an entry missing
// `provider` or `modelId` is built with `''` in the missing slot, and an alias
// the `default` or a role binding names need not exist — precisely so this
// function can name the offending alias and say what would have worked
// (plan/phases/model-registry.md T1.3). Every message here lists the CONFIGURED
// SET alongside the offender, because a refusal that does not say what would
// have worked makes the operator go read a file to act on it.
//
// Pure: no I/O, no clock, deterministic given its inputs. It THROWS for
// nothing — ordinary invalidity comes back as data, because `ethos doctor` and
// the web RPC both render these rather than catching them.
//
// The declaration grammar is NOT re-encoded here (D25). `parseModelDeclaration`
// below is a config-shaped wrapper over the one implementation in
// `@ethosagent/core`, the same shape `deriveBotKey` in `./index` already uses
// over core's — so a `modelRouting` value and a registry value are read by the
// same parser, and a value one accepts and the other refuses cannot exist.

import { parseModelDeclaration as parseDeclarationAgainstAliases } from '@ethosagent/core';
import {
  MODEL_ROLE_NAMES,
  type ModelDeclaration,
  type ModelDeclarationError,
  type ModelRegistry,
  type ModelRegistryEntry,
} from '@ethosagent/types';
import { deriveProviderKey, type ProviderChainEntry } from './index';

// ---------------------------------------------------------------------------
// D25 — the config-shaped wrapper over the one declaration parser
// ---------------------------------------------------------------------------

/**
 * Read a model declaration against THIS config's registry.
 *
 * The config-shaped half of `parseModelDeclaration` from `@ethosagent/core`:
 * callers here hold an `EthosConfig`, not a list of aliases, and threading
 * `Object.keys(config.modelRegistry?.entries ?? {})` through every call site is
 * how the alias set quietly acquires two spellings. Exactly the `deriveBotKey`
 * precedent in `./index` — a config-shaped wrapper over a core function, same
 * name, no second grammar.
 *
 * Use it for every slot that names a model: `modelRouting.<personality>`, the
 * registry's own `default`, its role bindings and its `fallbacks` lists — all
 * of which are validated through this wrapper by
 * {@link validateModelRegistry}, so a value the router accepts and the registry
 * refuses fails a test rather than an operator.
 */
export function parseModelDeclaration(
  value: unknown,
  config: { modelRegistry?: ModelRegistry },
): ModelDeclaration | ModelDeclarationError {
  return parseDeclarationAgainstAliases(value, {
    aliases: Object.keys(config.modelRegistry?.entries ?? {}),
  });
}

// ---------------------------------------------------------------------------
// The problem shape
// ---------------------------------------------------------------------------

/**
 * What is wrong, as a code a surface can branch on.
 *
 * `derived_provider_key` is D24's refusal and is deliberately NOT folded into
 * `unknown_provider_key`: the entry exists and the operator can see it in their
 * file, so "unknown" would read as a lie. The two differ in the only way that
 * matters to the person reading the message — one needs a new provider entry,
 * the other needs one line added to an entry that is already there.
 */
export type ModelRegistryProblemCode =
  | 'invalid_alias'
  | 'reserved_alias'
  | 'missing_provider'
  | 'missing_model_id'
  | 'unknown_provider_key'
  | 'derived_provider_key'
  | 'unknown_default'
  | 'unknown_role_binding'
  | 'unknown_fallback'
  | 'cross_provider_fallback'
  | 'alias_cycle';

/** One refusal, rendered by `ethos doctor` and by the Settings → Models pane. */
export interface ModelRegistryProblem {
  code: ModelRegistryProblemCode;
  /**
   * The alias the problem is about. For the roster-level keys it is the alias
   * they NAME (`modelRegistry.default: sonnet` → `sonnet`), because that is the
   * value the operator has to change; `key` says where it was named.
   */
  alias: string;
  /** The config key the problem was found under, e.g. `modelRegistry.roles.deep`. */
  key: string;
  /** One sentence, naming the offender and the configured set. */
  message: string;
  /** The exact line to add or change, where there is one (D24). */
  fix?: string;
}

// ---------------------------------------------------------------------------
// Provider entry keys
// ---------------------------------------------------------------------------

interface ProviderKeyIndex {
  /** `providers.<n>.id` → index. The only keys an alias may reference (D24). */
  explicit: Map<string, number>;
  /** `deriveProviderKey(entry, n)` → index, for entries carrying no `id`. */
  derived: Map<string, number>;
  /** Every key with its index, for the "what would have worked" half. */
  labels: string[];
}

function indexProviderKeys(providers: readonly ProviderChainEntry[]): ProviderKeyIndex {
  const explicit = new Map<string, number>();
  const derived = new Map<string, number>();
  const labels: string[] = [];
  providers.forEach((entry, index) => {
    if (entry.id) {
      if (!explicit.has(entry.id)) explicit.set(entry.id, index);
      labels.push(`${entry.id} (providers.${index})`);
      return;
    }
    const key = deriveProviderKey(entry, index);
    if (!derived.has(key)) derived.set(key, index);
    labels.push(`${key} (providers.${index}, derived — needs an explicit id: to be referenceable)`);
  });
  return { explicit, derived, labels };
}

function providerSet(index: ProviderKeyIndex): string {
  const explicitKeys = [...index.explicit.keys()];
  if (explicitKeys.length === 0) {
    return index.labels.length === 0
      ? 'No provider entries are configured.'
      : `No provider entry carries an explicit id: yet. Configured provider entries: ${index.labels.join(', ')}.`;
  }
  return `Provider entries an alias may reference: ${explicitKeys.join(', ')}. All configured provider entries: ${index.labels.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

/** The alias charset the codec's own parse branch in `./index` can read back. */
const ALIAS_RE = /^[A-Za-z0-9_-]+$/;

/** Object-model keys the codec's parse branch refuses as an alias — the same
 *  set as `RESERVED_TOOL_SETTINGS_KEYS` in `./index`, and they change together. */
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * `MODEL_ROLE_NAMES` contains `default`, so `modelRegistry.default` and
 * `modelRegistry.roles.default` are BOTH legal keys meaning different rungs of
 * D7 — rung 5 (the roster-wide fallback) and rung 4 (the binding for the
 * `default` role). An operator who writes one meaning the other gets a working
 * config that resolves somewhere they did not intend, so every refusal about
 * either key carries this sentence.
 */
const DEFAULT_KEY_DISAMBIGUATION =
  'Note: `modelRegistry.default` (the roster-wide default, resolution rung 5) and ' +
  '`modelRegistry.roles.default` (the binding for the `default` role, rung 4) are ' +
  'different keys and both are legal — check you edited the one you meant.';

/** `Object.hasOwn` guard so a key like `__proto__` cannot answer for an entry. */
function lookupEntry(registry: ModelRegistry, alias: string): ModelRegistryEntry | undefined {
  return Object.hasOwn(registry.entries, alias) ? registry.entries[alias] : undefined;
}

function aliasSet(registry: ModelRegistry): string {
  const aliases = Object.keys(registry.entries);
  return aliases.length === 0
    ? 'No models are configured.'
    : `Configured models: ${aliases.join(', ')}.`;
}

/**
 * Every refusal the registry codec left for this function, in config order:
 * the entries first (alias name, then its two required fields, then its
 * provider key), then the roster-level `default`, then the role bindings, then
 * the fallback lists, then the cycles across them.
 *
 * An empty or absent registry is not a problem here — "this deployment has no
 * models" is a `resolveModel` refusal (D6) and, for one release, the legacy
 * `config.model` shim's business (D11b). This function answers only "is what is
 * written here internally coherent".
 */
export function validateModelRegistry(
  registry: ModelRegistry | undefined,
  providers: readonly ProviderChainEntry[],
): ModelRegistryProblem[] {
  if (!registry) return [];
  const problems: ModelRegistryProblem[] = [];
  const keys = indexProviderKeys(providers);
  const aliases = aliasSet(registry);

  for (const [alias, entry] of Object.entries(registry.entries)) {
    checkAliasName(alias, registry, problems);
    checkEntryFields(alias, entry, keys, aliases, problems);
  }

  checkDefault(registry, problems);
  checkRoles(registry, problems);
  for (const [alias, entry] of Object.entries(registry.entries)) {
    checkFallbacks(alias, entry, registry, problems);
  }
  checkCycles(registry, problems);

  return problems;
}

/**
 * The problems `after` has that `before` did not — what a write would
 * INTRODUCE, keyed on code + key + alias. A pre-existing problem (a hand edit)
 * never blocks an unrelated write. Each side is validated against its own chain,
 * because a write can change the chain too (an id the importer adds).
 *
 * The one diff every registry writer refuses on: apps/web-api's
 * `ModelRegistryService` (upsert, remove, importChain, addProvider) and
 * `ConfigService.update`'s adopt-on-save.
 */
export function introducedModelRegistryProblems(
  before: ModelRegistry | undefined,
  beforeProviders: readonly ProviderChainEntry[],
  after: ModelRegistry | undefined,
  afterProviders: readonly ProviderChainEntry[],
): ModelRegistryProblem[] {
  const key = (p: ModelRegistryProblem): string => `${p.code}\x00${p.key}\x00${p.alias}`;
  const existing = new Set(validateModelRegistry(before, beforeProviders).map(key));
  return validateModelRegistry(after, afterProviders).filter((p) => !existing.has(key(p)));
}

function checkAliasName(
  alias: string,
  registry: ModelRegistry,
  problems: ModelRegistryProblem[],
): void {
  if ((MODEL_ROLE_NAMES as readonly string[]).includes(alias)) {
    problems.push({
      code: 'reserved_alias',
      alias,
      key: `modelRegistry.${alias}`,
      message:
        `Model "${alias}" uses a reserved name: roles and aliases share one namespace (D1), ` +
        `so ${MODEL_ROLE_NAMES.join(', ')} may not be alias names. ${aliasSet(registry)}`,
      fix: `Rename it, e.g. modelRegistry.${alias}-model.*`,
    });
    return;
  }
  // `__proto__` / `constructor` / `prototype` match the charset but the codec's
  // parse branch drops them (RESERVED_TOOL_SETTINGS_KEYS in `./index`), so an
  // entry written under one would also be gone on the next read.
  if (!ALIAS_RE.test(alias) || RESERVED_OBJECT_KEYS.has(alias)) {
    problems.push({
      code: 'invalid_alias',
      alias,
      key: `modelRegistry.${alias}`,
      message:
        `Model "${alias}" is not a readable alias: only letters, digits, hyphens and ` +
        `underscores are allowed (${ALIAS_RE.source}). A line written under this name is ` +
        `not one the config reader claims, so the entry would be gone on the next read. ` +
        aliasSet(registry),
      fix: `Rename it to something matching ${ALIAS_RE.source}.`,
    });
  }
}

function checkEntryFields(
  alias: string,
  entry: ModelRegistryEntry,
  keys: ProviderKeyIndex,
  aliases: string,
  problems: ModelRegistryProblem[],
): void {
  if (entry.modelId.trim().length === 0) {
    problems.push({
      code: 'missing_model_id',
      alias,
      key: `modelRegistry.${alias}.modelId`,
      message:
        `Model "${alias}" has no modelId — the vendor id sent on the wire — so nothing can ` +
        `run on it. ${aliases}`,
      fix: `modelRegistry.${alias}.modelId: <vendor model id>`,
    });
  }

  const provider = entry.provider.trim();
  if (provider.length === 0) {
    problems.push({
      code: 'missing_provider',
      alias,
      key: `modelRegistry.${alias}.provider`,
      message:
        `Model "${alias}" names no provider entry, so nothing says which credential it ` +
        `bills. ${aliases} ${providerSet(keys)}`,
      fix: `modelRegistry.${alias}.provider: <provider entry id>`,
    });
    return;
  }
  if (keys.explicit.has(provider)) return;

  const derivedIndex = keys.derived.get(provider);
  if (derivedIndex !== undefined) {
    // D24: the derived key is positional. It renames on a chain reorder or a
    // `providers.0` deletion, which dangles every alias that referenced it and
    // refuses every personality that named that alias — a routine edit becoming
    // a fleet-wide outage. So the refusal is here, with the line to add.
    problems.push({
      code: 'derived_provider_key',
      alias,
      key: `modelRegistry.${alias}.provider`,
      message:
        `Model "${alias}" names provider entry "${provider}", which is only a DERIVED name ` +
        `for providers.${derivedIndex} — it changes when the chain is reordered, and every ` +
        `alias pointing at it would dangle (D24). Give that entry an explicit id. ` +
        `${aliases} ${providerSet(keys)}`,
      fix: `providers.${derivedIndex}.id: ${provider}`,
    });
    return;
  }

  problems.push({
    code: 'unknown_provider_key',
    alias,
    key: `modelRegistry.${alias}.provider`,
    message:
      `Model "${alias}" names provider entry "${provider}", which is not configured. ` +
      `${aliases} ${providerSet(keys)}`,
  });
}

function checkDefault(registry: ModelRegistry, problems: ModelRegistryProblem[]): void {
  const declared = registry.default;
  if (declared === undefined) return;
  const parsed = parseModelDeclaration(declared, { modelRegistry: registry });
  if (parsed.kind === 'alias' && lookupEntry(registry, parsed.alias)) return;

  const because =
    parsed.kind === 'role'
      ? `"${declared}", which is a role name and not a model — the roster default must name a configured model.`
      : `"${declared}", which is not a configured model.`;
  problems.push({
    code: 'unknown_default',
    alias: declared,
    key: 'modelRegistry.default',
    message: `modelRegistry.default names ${because} ${aliasSet(registry)} ${DEFAULT_KEY_DISAMBIGUATION}`,
    fix: 'modelRegistry.default: <one of the configured models>',
  });
}

function checkRoles(registry: ModelRegistry, problems: ModelRegistryProblem[]): void {
  for (const role of MODEL_ROLE_NAMES) {
    const declared = registry.roles[role];
    if (declared === undefined) continue;
    const parsed = parseModelDeclaration(declared, { modelRegistry: registry });
    if (parsed.kind === 'alias' && lookupEntry(registry, parsed.alias)) continue;

    const because =
      parsed.kind === 'role'
        ? `"${declared}", which is another role name and not a model — a role binds to a configured model.`
        : `"${declared}", which is not a configured model.`;
    // The two `default` keys mean different rungs, so a refusal about either one
    // says which is which.
    const note = role === 'default' ? ` ${DEFAULT_KEY_DISAMBIGUATION}` : '';
    problems.push({
      code: 'unknown_role_binding',
      alias: declared,
      key: `modelRegistry.roles.${role}`,
      message: `modelRegistry.roles.${role} names ${because} ${aliasSet(registry)}${note}`,
      fix: `modelRegistry.roles.${role}: <one of the configured models>`,
    });
  }
}

/** The aliases that share a provider entry with `entry` — the legal fallbacks. */
function sameProviderAliases(registry: ModelRegistry, entry: ModelRegistryEntry): string[] {
  return Object.values(registry.entries)
    .filter((e) => e.alias !== entry.alias && e.provider === entry.provider)
    .map((e) => e.alias);
}

function checkFallbacks(
  alias: string,
  entry: ModelRegistryEntry,
  registry: ModelRegistry,
  problems: ModelRegistryProblem[],
): void {
  for (const declared of entry.fallbacks ?? []) {
    const parsed = parseModelDeclaration(declared, { modelRegistry: registry });
    const target = parsed.kind === 'alias' ? lookupEntry(registry, parsed.alias) : undefined;
    if (!target) {
      // A fallback naming nothing is skipped silently at run time
      // (`attemptWithFallbacks` in `@ethosagent/core`), so the only place it can
      // be said out loud is here.
      problems.push({
        code: 'unknown_fallback',
        alias,
        key: `modelRegistry.${alias}.fallbacks`,
        message:
          `Model "${alias}" declares the fallback "${declared}", which is not a configured ` +
          `model, so it would never be tried. ${aliasSet(registry)}`,
      });
      continue;
    }
    // Both empty-provider cases are already reported as `missing_provider`;
    // calling that a cross-provider fallback on top would be noise.
    if (entry.provider.length === 0 || target.provider.length === 0) continue;
    if (target.provider === entry.provider) continue;

    const legal = sameProviderAliases(registry, entry);
    problems.push({
      code: 'cross_provider_fallback',
      alias,
      key: `modelRegistry.${alias}.fallbacks`,
      message:
        `Model "${alias}" declares the fallback "${target.alias}", which uses provider entry ` +
        `"${target.provider}" rather than "${entry.provider}". A fallback never crosses a ` +
        `provider (D6): an expired local token must not become an egress event to a cloud ` +
        `provider — cross-provider failover is the providers.* chain's job. ` +
        (legal.length > 0
          ? `Models on "${entry.provider}": ${legal.join(', ')}.`
          : `No other model uses "${entry.provider}".`) +
        ` ${aliasSet(registry)}`,
    });
  }
}

/**
 * Fallback chains that never end. Reported once per cycle, on the alias the
 * walk entered it by, with the whole path in the message — naming one member
 * without the path leaves the operator to reconstruct it.
 */
function checkCycles(registry: ModelRegistry, problems: ModelRegistryProblem[]): void {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (alias: string): void => {
    const seen = state.get(alias);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      const start = stack.indexOf(alias);
      if (start < 0) return;
      const path = [...stack.slice(start), alias];
      const signature = [...new Set(path)].sort().join('\x00');
      if (reported.has(signature)) return;
      reported.add(signature);
      const head = path[0] ?? alias;
      problems.push({
        code: 'alias_cycle',
        alias: head,
        key: `modelRegistry.${head}.fallbacks`,
        message:
          `Model "${head}" has a fallback cycle: ${path.join(' → ')}. A fallback chain must ` +
          `end, or a failing model retries itself forever. ${aliasSet(registry)}`,
      });
      return;
    }
    state.set(alias, 'visiting');
    stack.push(alias);
    for (const next of lookupEntry(registry, alias)?.fallbacks ?? []) {
      if (lookupEntry(registry, next)) visit(next);
    }
    stack.pop();
    state.set(alias, 'done');
  };

  for (const alias of Object.keys(registry.entries)) visit(alias);
}
