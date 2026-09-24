// reach-and-containment Part 1 — on-demand tool loading within the personality
// allowlist.
//
// The personality's allowlist (toolset.yaml + mcp_servers + plugins, computed
// by `DefaultToolRegistry.toDefinitions(allowedTools, filterOpts)`) stops
// meaning "every schema, every request" and starts meaning "the universe this
// agent may search". A PINNED subset goes out on every LLM call; the rest is
// found through the loop-native `tool_search` and becomes callable on the next
// step. Access is still decided in ONE place — the allowlist check inside
// `DefaultToolRegistry.executeParallel` — which this module never touches:
// everything here only chooses which schemas of the universe are SENT.
//
// Pure: no I/O. Persistence of the loaded set lives in
// `stages/tool-search.ts` (`persistLoaded`).

import type { PersonalityConfig, ToolDefinitionLite, ToolRegistry } from '@ethosagent/types';
import { parseSmallWindowToolset } from './small-window-toolset';

/** The loop-native search tool's name. Never registered in a `ToolRegistry`. */
export const TOOL_SEARCH_NAME = 'tool_search';

/** D1-2 — loaded schemas are never evicted, so the tail is capped. */
export const MAX_LOADED_TOOLS = 32;

const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;

export interface ToolLoadingPlan {
  active: boolean;
  /** Always sent, in registry order. Always a subset of the universe. */
  pinned: ReadonlySet<string>;
  /** Found (or called) this session, in load order. Mutated in place by the
   *  loop during a turn; persisted to `Session.metadata.loadedTools`. */
  loaded: string[];
}

/** Everything the loop threads for one turn when loading is active. */
export interface ToolLoadingState {
  plan: ToolLoadingPlan;
  /** `toDefinitions(allowedTools, filterOpts)` at turn setup — the only names
   *  `tool_search` can ever return (D1-8). */
  universe: readonly ToolDefinitionLite[];
  /** The `tool_search` definition for this universe (static per universe). */
  searchDefinition: ToolDefinitionLite;
}

/** Wiring-built predicate: should loading engage for this personality + universe? */
export type ToolLoadingResolver = (
  personality: PersonalityConfig,
  universe: readonly ToolDefinitionLite[],
) => boolean;

type RegistryLookup = Pick<ToolRegistry, 'get' | 'getPluginId'>;

function isDeferrableByDefault(name: string, registry: RegistryLookup): boolean {
  return name.startsWith('mcp__') || registry.getPluginId?.(name) !== undefined;
}

/**
 * The pinned set. `context_engine_options.pinned_tools` (same shape as
 * `small_window_toolset`) intersected with the universe, so a pin can never
 * widen access. Unset → every built-in in the universe (not `mcp__*`, no
 * plugin id), which defers exactly the MCP and plugin tools (D1-7).
 * `alwaysInclude` tools are pinned in both cases: the flag already means
 * "sent regardless of the toolset", and loading must not quietly revoke it.
 */
export function resolvePinned(
  personality: PersonalityConfig,
  universe: readonly ToolDefinitionLite[],
  registry: RegistryLookup,
): Set<string> {
  const declared = parseSmallWindowToolset(personality.context_engine_options?.pinned_tools);
  const pinned = new Set<string>();
  for (const def of universe) {
    const always = registry.get(def.name)?.alwaysInclude === true;
    const pick = declared
      ? declared.includes(def.name)
      : !isDeferrableByDefault(def.name, registry);
    if (always || pick) pinned.add(def.name);
  }
  return pinned;
}

/**
 * The tools array the loop hands the provider: pinned in registry order, then
 * `tool_search`, then loaded in LOAD order (D1-2), so at the loop boundary each
 * array extends the previous one. A loaded name that has left the universe, or
 * is now pinned, is skipped without error; the relative order of the rest is
 * unchanged.
 *
 * Limitation: this is NOT the wire order. Every provider re-sorts tools by name
 * before serializing (`orderToolDefinitions`, packages/types/src/llm.ts, the
 * default `'stable'` order), so on the wire a loaded tool lands mid-array. The
 * cache consequence is the one D1-11 already accepts — one prefix miss at the
 * step that loads, then a byte-identical array for every later step, because
 * loaded tools are never evicted.
 */
export function composeDefinitions(
  universe: readonly ToolDefinitionLite[],
  plan: ToolLoadingPlan,
  searchDefinition: ToolDefinitionLite = TOOL_SEARCH_DEFINITION,
): ToolDefinitionLite[] {
  const byName = new Map(universe.map((d) => [d.name, d]));
  const out = universe.filter((d) => plan.pinned.has(d.name));
  out.push(searchDefinition);
  const seen = new Set<string>();
  for (const name of plan.loaded) {
    if (plan.pinned.has(name) || seen.has(name)) continue;
    const def = byName.get(name);
    if (!def) continue;
    seen.add(name);
    out.push(def);
  }
  return out;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Clamp a model-supplied limit to 1..10; anything non-numeric → 5. */
export function clampSearchLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Keyword search over `name` + `description` (D1-6). Per query token: a hit
 * in the name scores 3, a hit in the description scores 1. An exact-name
 * match sorts first; ties break by registry order. Deterministic, no deps.
 */
export function searchTools(
  query: string,
  defs: readonly ToolDefinitionLite[],
  limit?: unknown,
): ToolDefinitionLite[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const exact = query.trim().toLowerCase();
  const scored: Array<{ def: ToolDefinitionLite; score: number; exact: boolean; index: number }> =
    [];
  defs.forEach((def, index) => {
    const name = def.name.toLowerCase();
    const description = def.description.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (name.includes(t)) score += 3;
      if (description.includes(t)) score += 1;
    }
    const isExact = name === exact;
    if (score > 0 || isExact) scored.push({ def, score, exact: isExact, index });
  });
  scored.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return a.index - b.index;
  });
  return scored.slice(0, clampSearchLimit(limit)).map((s) => s.def);
}

/**
 * Append names to `plan.loaded` — deduplicated, pinned names skipped, only
 * names in the universe, and never past `MAX_LOADED_TOOLS`. Returns the names
 * actually appended (empty → nothing to persist).
 */
export function noteLoaded(
  plan: ToolLoadingPlan,
  universeNames: ReadonlySet<string>,
  names: readonly string[],
): string[] {
  const added: string[] = [];
  for (const name of names) {
    if (plan.loaded.length >= MAX_LOADED_TOOLS) break;
    if (!universeNames.has(name) || plan.pinned.has(name) || plan.loaded.includes(name)) continue;
    plan.loaded.push(name);
    added.push(name);
  }
  return added;
}

/** `Session.metadata.loadedTools`, defensively read (it is a JSON column). */
export function readLoadedTools(metadata: Record<string, unknown> | undefined): string[] {
  const raw = metadata?.loadedTools;
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is string => typeof n === 'string');
}

const SEARCH_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Keywords describing the capability you need (e.g. "github issue").',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_SEARCH_LIMIT,
      description: `Maximum tools to return (default ${DEFAULT_SEARCH_LIMIT}).`,
    },
  },
  required: ['query'],
};

/** The universe-independent definition (used by the bench and as a default). */
export const TOOL_SEARCH_DEFINITION: ToolDefinitionLite = {
  name: TOOL_SEARCH_NAME,
  description:
    'Find more tools. Only some of your tools are listed; search by keyword and the matching ' +
    'tools become callable on your next step.',
  parameters: SEARCH_PARAMETERS,
};

/**
 * The per-universe definition: names the deferred-tool COUNT and the MCP
 * servers / plugins they come from, so a model that would otherwise say "I
 * can't do that" knows a search is worth trying (plan §1.7). Depends only on
 * the universe and the pins, so it is byte-stable across the turns of one
 * universe and keeps the prefix cacheable.
 */
export function buildToolSearchDefinition(
  universe: readonly ToolDefinitionLite[],
  pinned: ReadonlySet<string>,
  registry: RegistryLookup,
): ToolDefinitionLite {
  const sources: string[] = [];
  let deferred = 0;
  for (const def of universe) {
    if (pinned.has(def.name)) continue;
    deferred++;
    const source = def.name.startsWith('mcp__')
      ? def.name.split('__')[1]
      : registry.getPluginId?.(def.name);
    if (source && !sources.includes(source)) sources.push(source);
  }
  const from = sources.length > 0 ? ` (including tools from: ${sources.join(', ')})` : '';
  return {
    name: TOOL_SEARCH_NAME,
    description:
      `Find more tools. ${deferred} more tool${deferred === 1 ? ' is' : 's are'} available ` +
      `beyond the ones listed${from}. Search by keyword; the matching tools become callable on ` +
      'your next step. You may also call a tool you already know the name of directly.',
    parameters: SEARCH_PARAMETERS,
  };
}

/**
 * Turn-setup entry point (C2). Returns `undefined` — today's code path,
 * byte-for-byte — when no resolver is wired or it says no.
 */
export function resolveToolLoading(opts: {
  resolver: ToolLoadingResolver | undefined;
  registry: Pick<ToolRegistry, 'get' | 'getPluginId' | 'toDefinitions'>;
  personality: PersonalityConfig;
  allowedTools: string[] | undefined;
  filterOpts: import('@ethosagent/types').ToolFilterOpts;
  sessionMetadata: Record<string, unknown> | undefined;
}): ToolLoadingState | undefined {
  if (!opts.resolver) return undefined;
  const universe = opts.registry.toDefinitions(opts.allowedTools, opts.filterOpts);
  if (!opts.resolver(opts.personality, universe)) return undefined;
  const pinned = resolvePinned(opts.personality, universe, opts.registry);
  return {
    plan: { active: true, pinned, loaded: readLoadedTools(opts.sessionMetadata) },
    universe,
    searchDefinition: buildToolSearchDefinition(universe, pinned, opts.registry),
  };
}
