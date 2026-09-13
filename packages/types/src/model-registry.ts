// The model registry contract — the shapes every layer reads when it answers
// "which model is this turn running on, and why that one".
//
// This module is TYPES ONLY plus one frozen constant. It enforces nothing: the
// parser (`parseModelDeclaration`), the resolver (`resolveModel`) and the
// validator (`validateModelRegistry`) are named per-symbol below, and each one
// lands in a later task of plan/phases/model-registry.md. Where a comment here
// states a rule, it names the symbol that will hold it — and says when that
// symbol does not exist yet, rather than describing an enforcement that is not
// on any code path (CLAUDE.md §12).

import type { ModelTierName } from './personality';

/**
 * The four role names a personality may declare.
 *
 * Deliberately an alias of {@link ModelTierName} rather than a parallel union
 * (D1): the tier vocabulary already exists, already ships on every personality
 * that declares a tier map, and inventing a second four-value union for the
 * same four concepts is how two spellings of one fact drift apart. A role IS a
 * tier name, read as a request rather than as a map key.
 */
export type ModelRoleName = ModelTierName;

/**
 * The four role names, ordered, frozen.
 *
 * The single source every declaration parser and every picker reads (D25).
 * `packages/web-contracts` cannot import `@ethosagent/core`, so its recipe
 * schema narrows to the roles by consuming THIS constant — which is the reason
 * it lives in `@ethosagent/types` (zero runtime deps) and not beside the parser.
 *
 * Roles and aliases share one namespace, so these four names are reserved: a
 * registry entry may not be called `trivial`, `default`, `deep` or `dreaming`.
 * Nothing in this module refuses one — the refusal is `validateModelRegistry`
 * in `packages/config/src/model-registry.ts` (T1.3, not yet written at the time
 * this contract landed).
 *
 * The order is the one `ModelTierName` declares and carries no meaning of its
 * own — nothing resolves by position, and `dreaming` is a separate mode rather
 * than a rung above `deep`. It is fixed only so the drift gate in
 * `packages/types/src/__tests__/model-registry.test.ts` can assert against a
 * stable list.
 */
export const MODEL_ROLE_NAMES: readonly ModelRoleName[] = [
  'trivial',
  'default',
  'deep',
  'dreaming',
] as const;

/**
 * One model this deployment may use, under an operator-chosen alias.
 *
 * An entry holds NO credential of its own (D2). It references a provider entry
 * by key, and that provider entry already owns the API key, the base URL, the
 * region and the vault reference. One credential, one endpoint, one owner.
 */
export interface ModelRegistryEntry {
  /**
   * The operator-chosen key this entry is addressed by. Unique across the
   * registry, and never one of {@link MODEL_ROLE_NAMES} — roles and aliases
   * share a namespace (D1).
   */
  alias: string;
  /**
   * The provider ENTRY key (`providers.<n>.id`), not a provider TYPE (D2/D24).
   *
   * Two chain entries can both be `anthropic` — two keys, two accounts — and a
   * registry that named only the type could not say which credential to bill.
   * The key must be an explicit `id:` on the entry, never the positional
   * `deriveProviderKey` default, because that default renames on a chain
   * reorder and would dangle every alias pointing at it (D24). That rule is
   * enforced by `validateModelRegistry` in
   * `packages/config/src/model-registry.ts` (T1.3), not here.
   */
  provider: string;
  /** The vendor id sent on the wire, e.g. `claude-sonnet-5`, `qwen2.5-coder:32b`. */
  modelId: string;
  /** Human label for the pickers, e.g. `everyday driver`. Display only. */
  label?: string;
  /**
   * Context window in tokens. One place to read it (D12): the picker, the
   * character sheet and `resolveContextWindow` all take it from here rather
   * than each re-deriving it from a catalog.
   */
  contextWindow?: number;
  /** USD per 1k input tokens. Display and future budgeting; nothing bills on it. */
  costPer1kInput?: number;
  /** USD per 1k output tokens. Same. */
  costPer1kOutput?: number;
  /**
   * Alias fallbacks for this entry, tried in order when its provider entry
   * cannot answer (D6).
   *
   * Same-provider only: a fallback whose provider entry differs from this
   * entry's is refused, so an expired local token can never become an egress
   * event to a cloud vendor. Cross-provider failover stays the job of the
   * `providers.*` chain, which the operator configured knowing what it holds.
   * Enforcer: `validateModelRegistry` (T1.3), pinned by
   * `fallback across providers is refused`.
   */
  fallbacks?: string[];
}

/**
 * The deployment's model roster, parsed from `modelRegistry.*` in
 * `~/.ethos/config.yaml`.
 */
export interface ModelRegistry {
  /** Every configured entry, keyed by its own `alias`. */
  entries: Record<string, ModelRegistryEntry>;
  /**
   * The alias the `default` rung resolves to (D7 rung 5). Required once the
   * registry is non-empty; absent means nothing is configured and the legacy
   * `config.model` still serves for one release (D11).
   */
  default?: string;
  /**
   * Role bindings: role name → alias (D7 rung 4). Partial by design — an
   * unbound role is a documented rung, not a misconfiguration: the resolver
   * falls through to {@link ModelRegistry.default} and says so (D6, D17 row 1).
   */
  roles: Partial<Record<ModelRoleName, string>>;
}

/** What a legal model declaration turned out to be. */
export type ModelDeclarationKind = 'role' | 'alias';

/**
 * A parsed model declaration — the two legal values of `PersonalityConfig.model`
 * (and of every other slot that names a model): a role, or a registry alias
 * (D1). Nothing else parses.
 *
 * Produced by `parseModelDeclaration` in `packages/core/src/model-resolution.ts`
 * (T1.22) — one grammar with one implementation, so a value the UI accepts and
 * the resolver refuses fails the build instead of reaching an operator.
 */
export type ModelDeclaration =
  | { kind: 'role'; role: ModelRoleName }
  | { kind: 'alias'; alias: string };

/**
 * A declaration that is neither a role nor a configured alias.
 *
 * `suggestions` carries the near-misses to name in the message — the configured
 * aliases and the role names — because a refusal that does not say what WOULD
 * have worked is a refusal the operator has to go read a file to act on.
 */
export interface ModelDeclarationError {
  kind: 'invalid';
  reason: string;
  suggestions: string[];
}

/**
 * Which rung of the resolution order chose the model (D7).
 *
 * Seven labels for six rungs — rung 1 is the team manifest and distinguishes
 * the coordinator slot from a per-personality one:
 *
 * | # | Rung                                            | Label                             |
 * |---|-------------------------------------------------|-----------------------------------|
 * | 0 | a `/model` pin for this run                      | `run-override`                    |
 * | 1 | team manifest coordinator / personality entry    | `team-coordinator` / `team-personality` |
 * | 2 | `modelRouting[personality.id]`                   | `routing-override`                |
 * | 3 | `personality.model`                              | `personality`                     |
 * | 4 | `modelRegistry.roles[role]`                      | `role-binding`                    |
 * | 5 | `modelRegistry.default`                          | `default`                         |
 *
 * This is the SAME union `run_start.source` carries
 * (`packages/types/src/agent-event.ts`), widened — the event already shipped
 * `'team-coordinator' | 'team-personality' | 'personality' | 'global'`, and
 * `'global'` was renamed `'default'` in the same audit rather than letting one
 * fact acquire two vocabularies. The event's own union is widened to match in
 * T1.15a; until then the two differ and only the resolver speaks the wider one.
 */
export type ModelResolutionSource =
  | 'run-override'
  | 'team-coordinator'
  | 'team-personality'
  | 'routing-override'
  | 'personality'
  | 'role-binding'
  | 'default';

/**
 * A turn ran on something other than what was declared, and this is what the
 * person is told about it (D17).
 *
 * A deviation is announced on the surface the turn is happening on, in the same
 * turn it happens — not only in a log, not only at startup, not only in
 * Settings. Every surface renders it through `describeDeviation` in
 * `packages/core/src/model-resolution.ts` (T1.15a) rather than restating the
 * copy, so one fact cannot acquire eight wordings and go stale in seven of them.
 */
export interface ModelDeviation {
  kind:
    | 'role-unbound'
    | 'entry-fallback'
    | 'chain-failover'
    | 'credential-rejected'
    | 'legacy-id-mapped'
    | 'outranked';
  /** What the personality or the config asked for. */
  declared: string;
  /** The alias that actually ran. */
  effective: string;
  /** One sentence; the vendor's own words verbatim where there are any. */
  reason: string;
  /** The exact command, or the pane to open. */
  fix?: string;
  /**
   * `true` → surface once per process per `(personalityId, kind, declared)`;
   * `false` → every time.
   *
   * A property of the row, not a user preference. A CONFIG fact (a role nobody
   * bound, a legacy id being mapped, a manifest outranking a declaration) is
   * true until someone edits a file, so repeating it every turn trains people
   * to stop reading it. A LIVE condition (a fallback in use, a chain failover,
   * a rejected credential) can change between one turn and the next, and its
   * absence on the next turn is itself information.
   *
   * The suppression set is owned by the `AgentLoop` instance — a
   * process-lifetime map consulted in `turn-setup` before a `once: true`
   * deviation is attached (T1.15a). Per process, never persisted: a restart
   * re-announces, which is correct, because a restart is also when a config
   * change takes effect.
   */
  once: boolean;
}

/**
 * What a turn actually runs on, and the rung that chose it.
 *
 * Returned by `resolveModel` in `packages/core/src/model-resolution.ts` (T1.4).
 */
export interface ResolvedModel {
  /** The registry alias that won. */
  alias: string;
  /** The provider ENTRY key that alias names — the credential that will be billed. */
  providerKey: string;
  /** The vendor id sent on the wire. */
  modelId: string;
  contextWindow?: number;
  cost?: { input?: number; output?: number };
  source: ModelResolutionSource;
  /**
   * Whether this model was PINNED by someone, rather than fallen back to.
   *
   * `true` for rungs 0–3 — a run override, a team manifest entry, a routing
   * override, the personality's own declaration — and for a role binding the
   * personality itself named. `false` for the `default` rung and for an unbound
   * role's fall-through (D21).
   *
   * It is the flag that decides whether the `providers.*` chain may be
   * consulted: a pin is the author saying *this model*, for a reason the
   * framework cannot see (a local endpoint chosen so data stays on the box, a
   * prompt tuned against one model's tool calling), so a pinned turn is handed
   * the single provider its alias names and a chain failover for it is not
   * reachable. That behaviour is `build-agent-loop` via `LoopDeps.providerFor`
   * (T1.16/T1.20); this field only carries the answer.
   */
  pinned: boolean;
  /** Set when the model that ran is not the one that was asked for (D17). */
  deviation?: ModelDeviation;
}

/**
 * The resolver could not name a model, so nothing ran.
 *
 * A refusal, never a silent reroute (D6): substituting another model changes
 * the agent while keeping its name, and the substitution is discovered on the
 * invoice. `configuredAliases` is listed in the message because the operator's
 * next action is to pick one of them.
 */
export interface ModelResolutionFailure {
  ok: false;
  code: 'model_unresolved';
  /** The value that did not resolve, as written. */
  declared: string;
  reason: string;
  /** Every alias this deployment does have, so the message can name them. */
  configuredAliases: string[];
  fix?: string;
}

/**
 * Everything `resolveModel` reads besides the personality and the role.
 *
 * Injected into `AgentLoop` through `AgentLoopConfig`, replacing today's
 * `modelRouting: Record<string, string>` dependency (D7). `AgentLoopConfig` is
 * not a frozen schema, and `modelRouting` is the precedent for the slot.
 */
export interface ModelResolutionContext {
  /** The roster, its `default` alias and its role bindings (rungs 3–5). */
  registry: ModelRegistry;
  /** `modelRouting.<personalityId>` → alias or role (rung 2). */
  routing: Record<string, string>;
  /**
   * The team manifest's model slots (rung 1), when the turn is a team turn.
   * Values are aliases or roles like every other rung.
   */
  teamManifest?: {
    coordinatorModel?: string;
    personalityModels?: Record<string, string>;
  };
}

/**
 * The last thing a probe learned about one provider ENTRY's credential (D18).
 *
 * Per entry, not per alias: the credential belongs to the entry, so six aliases
 * on one key are one check.
 *
 * `'unknown'` is the honest state for "nothing has checked, or the check could
 * not reach the endpoint" — an `unreachable` probe outcome (timeout, DNS, 5xx,
 * 429, and every ambiguous error) maps to `'unknown'`, never to `'rejected'`.
 * **`'unknown'` NEVER disables anything**: no health state removes a
 * personality from a listing, edits a declaration, substitutes a model or greys
 * an option. A laptop on a train must not conclude that all its models are
 * broken, and an Ollama that is simply not started yet must not turn every
 * local alias red. The enforcement lives with `verifyModelRegistry` in
 * `packages/wiring/src/model-health.ts` (T2.13, not yet written), pinned there
 * by `an unreachable probe leaves health unknown and disables nothing` and
 * `no health state removes a personality from the registry listing`.
 */
export interface ModelHealth {
  providerKey: string;
  state: 'ok' | 'rejected' | 'unknown';
  /** ISO timestamp of the probe this record came from. */
  checkedAt: string;
  latencyMs?: number;
  /** The vendor's own words, verbatim and untruncated, when there are any. */
  error?: string;
}
