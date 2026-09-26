// The one answer to "what model does this turn run on, and why that one".
//
// Three concerns live here, all of them PURE — no I/O, no clock, no randomness,
// deterministic given their inputs:
//
//   `parseModelDeclaration`  the ONE grammar for a legal model declaration (D25),
//                            defined in `packages/types/src/model-registry.ts`
//   `resolveModel`           the six-rung resolution order (D7), identical solo
//                            and in a team
//   `describeDeviation`      the ONE message builder for `ModelDeviation` (D17)
//
// plus `attemptWithFallbacks` (D17 row 2), which is pure by injection: the
// caller supplies the attempt, so no provider and no transport reaches core.
//
// The types these functions speak are `packages/types/src/model-registry.ts`.
// Nothing is redefined here.

import {
  MODEL_ROLE_NAMES,
  type ModelDeclaration,
  type ModelDeclarationError,
  type ModelDeviation,
  type ModelRegistry,
  type ModelRegistryEntry,
  type ModelResolutionContext,
  type ModelResolutionFailure,
  type ModelResolutionSource,
  type ModelRoleName,
  type PersonalityConfig,
  parseModelDeclaration,
  type ResolvedModel,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Registry lookups
// ---------------------------------------------------------------------------
//
// `parseModelDeclaration` — the ONE declaration grammar (D25) — lives in
// `packages/types/src/model-registry.ts` so `@ethosagent/config` can read a
// declaration without importing core. Imported above; re-exported unchanged
// by `packages/core/src/index.ts`.

/** `Object.hasOwn` guard so a key like `__proto__` cannot answer for an entry. */
function lookupEntry(registry: ModelRegistry, alias: string): ModelRegistryEntry | undefined {
  return Object.hasOwn(registry.entries, alias) ? registry.entries[alias] : undefined;
}

function lookupString(map: Record<string, string> | undefined, key: string): string | undefined {
  if (!map || !Object.hasOwn(map, key)) return undefined;
  const value = map[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// D11c — the legacy-declaration shim (removed at 0.10.0,
// follow-up `model-registry-shim-removal`)
// ---------------------------------------------------------------------------

/**
 * Family → role, the whole table, deliberately small and literal (D11c).
 * Matched against the CATALOG `modelId` in this order; first hit wins.
 */
const LEGACY_FAMILY_ROLES: readonly {
  family: string;
  matches: (catalogId: string) => boolean;
  role: ModelRoleName;
}[] = [
  { family: 'haiku', matches: (id) => id.includes('haiku'), role: 'trivial' },
  { family: 'sonnet', matches: (id) => id.includes('sonnet'), role: 'default' },
  { family: 'opus', matches: (id) => id.includes('opus'), role: 'deep' },
  { family: 'gpt-*-mini', matches: (id) => /gpt-.*-mini/.test(id), role: 'trivial' },
  { family: 'o*-mini', matches: (id) => /(^|\/)o[^/]*-mini/.test(id), role: 'trivial' },
  { family: 'gpt-*', matches: (id) => id.includes('gpt-'), role: 'default' },
];

/** What the D11c shim made of a declaration that is neither a role nor an alias. */
export type LegacyDeclarationMapping =
  /** Not something the shim speaks for — the caller's ordinary refusal stands. */
  | { kind: 'not-legacy' }
  /** Mapped in memory, never written back; `deviation` is D17 row 7. */
  | { kind: 'mapped'; declaration: ModelDeclaration; deviation: ModelDeviation }
  /** A legacy id the shim recognised but will not guess about (D6/D14). */
  | { kind: 'refused'; failure: ModelResolutionFailure };

const SHIM_SUNSET = 'This automatic mapping is removed in 0.10.0.';

/**
 * The D11c table, applied at resolution time to a personality's OWN
 * declaration — a plain string, the tier-map leaf a role indexes, or
 * `voice.model` — in memory and never written back to disk.
 *
 * | Declared | Result |
 * |---|---|
 * | a role or a registry alias | `not-legacy` — `parseModelDeclaration` already reads it; checked FIRST, so an alias named like a vendor id wins |
 * | the `modelId` of exactly one registry entry | `mapped` to that alias |
 * | the `modelId` of more than one entry | `refused`, listing the candidates |
 * | in no entry, in the catalog under a known family, that role UNBOUND | `mapped` to the role — which falls to the default, i.e. today's model |
 * | the same, but that role BOUND | `refused`, naming the binding it would silently have adopted |
 * | anything else | `not-legacy` — the caller's ordinary refusal |
 *
 * The bound-role refusal is what keeps the shim inside its safety argument:
 * a legacy id resolved to the global model before the registry was wired, and
 * an UNBOUND role still does; a bound one would be a silent upgrade (D11,
 * amended).
 *
 * Only a personality's own declaration goes through here. A `/model` pin,
 * `modelRouting` and a team manifest are refused as before: none of them was
 * ignored pre-registry, so mapping them would change what they ran on.
 *
 * `key` is the config line the declaration came from (`model`, `model.deep`,
 * `voice.model`), so the fix names the one line to write.
 */
export function mapLegacyModelDeclaration(input: {
  personalityId: string;
  declared: string;
  key: string;
  ctx: ModelResolutionContext;
}): LegacyDeclarationMapping {
  const registry = input.ctx.registry;
  const aliases = Object.keys(registry.entries);
  const declared = input.declared.trim();
  if (parseModelDeclaration(declared, { aliases }).kind !== 'invalid')
    return { kind: 'not-legacy' };
  const where = `${input.personalityId}'s config.yaml`;

  const matches = Object.values(registry.entries).filter((e) => e.modelId === declared);
  const [only] = matches;
  if (matches.length === 1 && only) {
    return {
      kind: 'mapped',
      declaration: { kind: 'alias', alias: only.alias },
      deviation: {
        kind: 'legacy-id-mapped',
        declared,
        effective: only.alias,
        reason: `It matched your model "${only.alias}" (${only.provider} · ${only.modelId}).`,
        fix: `Make it explicit: set \`${input.key}: ${only.alias}\` in ${where}. ${SHIM_SUNSET}`,
        once: true,
      },
    };
  }
  if (matches.length > 1) {
    const candidates = matches.map((e) => e.alias);
    return {
      kind: 'refused',
      failure: unresolved({
        declared,
        reason: `"${declared}" is the model id of more than one configured model (${candidates.join(', ')}), so which one was meant is not guessed.`,
        aliases,
        fix: `Set \`${input.key}\` in ${where} to one of: ${candidates.join(', ')}.`,
      }),
    };
  }

  const catalogId = input.ctx.catalogModelId?.(declared);
  if (catalogId === undefined) return { kind: 'not-legacy' };
  const lowered = catalogId.toLowerCase();
  const family = LEGACY_FAMILY_ROLES.find((row) => row.matches(lowered));
  if (!family) return { kind: 'not-legacy' };
  const { role } = family;

  const bound = registry.roles[role];
  if (bound) {
    const boundEntry = lookupEntry(registry, bound);
    const boundText = boundEntry
      ? `"${bound}" (${boundEntry.provider} · ${boundEntry.modelId})`
      : `"${bound}"`;
    return {
      kind: 'refused',
      failure: unresolved({
        declared,
        reason:
          `It is a ${family.family}-family model id, which would map to the "${role}" role — but ` +
          `"${role}" is bound to ${boundText} on this machine, so it is not mapped silently: ` +
          `that would move ${input.personalityId} off the default model it ran on before.`,
        aliases,
        fix:
          `Make it explicit in ${where}: \`${input.key}: ${role}\` to run on "${bound}", or ` +
          `\`${input.key}: <a configured model>\`. ${SHIM_SUNSET}`,
      }),
    };
  }

  const defaultEntry = registry.default ? lookupEntry(registry, registry.default) : undefined;
  return {
    kind: 'mapped',
    declaration: { kind: 'role', role },
    deviation: {
      kind: 'legacy-id-mapped',
      declared,
      effective: defaultEntry?.alias ?? role,
      reason:
        `It is a ${family.family}-family model id, so it was read as the "${role}" role. ` +
        `Nothing is bound to "${role}" on this machine, so it runs on the deployment default` +
        (defaultEntry ? ` — ${defaultEntry.provider} · ${defaultEntry.modelId}.` : '.'),
      fix: `Make it explicit: set \`${input.key}: ${role}\` in ${where}. ${SHIM_SUNSET}`,
      once: true,
    },
  };
}

// ---------------------------------------------------------------------------
// D7 — one resolver, one rung order
// ---------------------------------------------------------------------------

/** A value found at one of the four declaring rungs (0–3), with its label. */
interface DeclaringRung {
  value: string;
  /** The `source` this rung stamps when it terminates on an alias. */
  source: ModelResolutionSource;
  /** 0 = run override, 1 = team manifest, 2 = routing, 3 = the personality. */
  rung: 0 | 1 | 2 | 3;
}

/**
 * What the personality itself declares for this role — the rung-3 value.
 *
 * A string is the declaration; a tier map is indexed by the requested role and
 * falls back to its own `default` leaf (D7 rung 3).
 */
function personalityDeclaration(
  model: PersonalityConfig['model'],
  role: ModelRoleName,
): string | undefined {
  if (typeof model === 'string') {
    const trimmed = model.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!model) return undefined;
  const picked = model[role] ?? model.default;
  if (typeof picked !== 'string') return undefined;
  const trimmed = picked.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The config line `personalityDeclaration` read for this role — the line a fix names. */
function personalityDeclarationKey(model: PersonalityConfig['model'], role: ModelRoleName): string {
  if (typeof model === 'string' || !model) return 'model';
  return model[role] != null ? `model.${role}` : 'model.default';
}

function declaringRungs(input: {
  personality: Pick<PersonalityConfig, 'id' | 'model'>;
  role: ModelRoleName;
  ctx: ModelResolutionContext;
  runOverride?: string;
  isCoordinator?: boolean;
}): DeclaringRung[] {
  const rungs: DeclaringRung[] = [];

  const runOverride = input.runOverride?.trim();
  if (runOverride) rungs.push({ value: runOverride, source: 'run-override', rung: 0 });

  const manifest = input.ctx.teamManifest;
  if (manifest) {
    const coordinator = input.isCoordinator ? manifest.coordinatorModel?.trim() : undefined;
    if (coordinator) {
      rungs.push({ value: coordinator, source: 'team-coordinator', rung: 1 });
    } else {
      // A coordinator with no coordinator slot still reads its per-personality
      // entry: the manifest named it, and dropping to rung 2 would ignore a
      // line the operator wrote about this exact agent.
      const member = lookupString(manifest.personalityModels, input.personality.id);
      if (member) rungs.push({ value: member, source: 'team-personality', rung: 1 });
    }
  }

  const routed = lookupString(input.ctx.routing, input.personality.id);
  if (routed) rungs.push({ value: routed, source: 'routing-override', rung: 2 });

  const declared = personalityDeclaration(input.personality.model, input.role);
  if (declared) rungs.push({ value: declared, source: 'personality', rung: 3 });

  return rungs;
}

function unresolved(opts: {
  declared: string;
  reason: string;
  aliases: string[];
  fix?: string;
}): ModelResolutionFailure {
  return {
    ok: false,
    code: 'model_unresolved',
    declared: opts.declared,
    reason: opts.reason,
    configuredAliases: opts.aliases,
    ...(opts.fix ? { fix: opts.fix } : {}),
  };
}

function toResolved(
  entry: ModelRegistryEntry,
  source: ModelResolutionSource,
  pinned: boolean,
  deviation?: ModelDeviation,
): ResolvedModel {
  const cost =
    entry.costPer1kInput !== undefined || entry.costPer1kOutput !== undefined
      ? {
          ...(entry.costPer1kInput !== undefined ? { input: entry.costPer1kInput } : {}),
          ...(entry.costPer1kOutput !== undefined ? { output: entry.costPer1kOutput } : {}),
        }
      : undefined;
  return {
    alias: entry.alias,
    // D8: the pairing invariant. A resolved model carries the provider ENTRY its
    // own registry row names, so the deleted `personality.provider === llmName`
    // guard has nothing left to check — there is no path that pairs a model with
    // a provider it did not name. Pinned by `resolved model carries its own
    // provider` in `packages/core/src/__tests__/model-resolution.test.ts`.
    providerKey: entry.provider,
    modelId: entry.modelId,
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    ...(cost ? { cost } : {}),
    source,
    pinned,
    ...(deviation ? { deviation } : {}),
  };
}

/**
 * Why a rung above the personality's own declaration won (D17 row 8).
 *
 * The rung-specific half of the sentence; `describeDeviation` owns the frame.
 */
function outrankedReason(rung: DeclaringRung, personalityId: string): string {
  switch (rung.source) {
    case 'run-override':
      return `You pinned "${rung.value}" for this run.`;
    case 'team-coordinator':
      return `The team manifest's coordinator model "${rung.value}" wins.`;
    case 'team-personality':
      return `The team manifest sets ${personalityId} to "${rung.value}", which wins.`;
    default:
      return `The operator override modelRouting.${personalityId} = "${rung.value}" wins.`;
  }
}

function outrankedDeviation(
  winner: DeclaringRung,
  personality: Pick<PersonalityConfig, 'id' | 'model'>,
  role: ModelRoleName,
  effectiveAlias: string,
): ModelDeviation | undefined {
  // D17 row 8 fires for rungs 0–2 only: the trigger is "a HIGHER rung outranks
  // the personality's own declaration".
  //
  // CONTRADICTION, recorded rather than blended (CLAUDE.md §5). D17's enforcer
  // column and this task's brief both shorthand the condition as
  // `source !== 'personality'`. That shorthand is wrong against this same
  // decision's own rung table: a personality declaring a ROLE terminates at rung
  // 4 or 5, so its `source` is `role-binding` or `default` and never
  // `personality` — the shorthand would report the personality's own winning
  // declaration as outranked on every role declaration, which is the majority
  // case the plan advocates. The trigger sentence and both worked examples in
  // D17 row 8 name rungs 0/1/2, so the rung is implemented and the shorthand is
  // not. Pinned by `a personality role declaration is not reported as
  // outranked`.
  if (winner.rung === 3) return undefined;
  const own = personalityDeclaration(personality.model, role);
  if (!own) return undefined;
  return {
    kind: 'outranked',
    declared: own,
    effective: effectiveAlias,
    reason: outrankedReason(winner, personality.id),
    // `once` is a property of the row (D17): a config fact is true until someone
    // edits a file, but a `/model` pin is something the person typed this turn
    // and the confirmation is the point.
    once: winner.source !== 'run-override',
  };
}

/**
 * The six rungs, highest first (D7). Identical solo and in a team.
 *
 * | # | Rung                                          | `source`                                |
 * |---|-----------------------------------------------|-----------------------------------------|
 * | 0 | `runOverride`                                 | `run-override`                          |
 * | 1 | team manifest coordinator / personality entry | `team-coordinator` / `team-personality` |
 * | 2 | `ctx.routing[personality.id]`                  | `routing-override`                      |
 * | 3 | `personality.model`                           | `personality`                           |
 * | 4 | `ctx.registry.roles[role]`                    | `role-binding`                          |
 * | 5 | `ctx.registry.default`                        | `default`                               |
 *
 * An ALIAS at any of rungs 0–3 terminates immediately. A ROLE falls through to
 * its binding (rung 4) and then to the default (rung 5); the unbound
 * fall-through carries a `role-unbound` deviation (D17 row 1).
 *
 * **The D11b legacy fallback is deliberately not here.** An absent or empty
 * registry meaning "use `config.model` for one release" (D11b) is a WIRING
 * concern — this function has no `config` and cannot acquire one without core
 * importing `@ethosagent/config` against the layer direction (ARCHITECTURE.md
 * §II). Here an empty registry is a refusal; the one-release shim belongs in
 * `packages/wiring` ahead of the call, and is removed at `0.10.0`.
 */
export function resolveModel(input: {
  personality: Pick<PersonalityConfig, 'id' | 'model'>;
  role: ModelRoleName;
  ctx: ModelResolutionContext;
  runOverride?: string;
  isCoordinator?: boolean;
}): ResolvedModel | ModelResolutionFailure {
  const registry = input.ctx.registry;
  const aliases = Object.keys(registry.entries);
  const winner = declaringRungs(input)[0];

  let role = input.role;
  // A role was ASKED FOR when a rung declared one, or when the caller requested
  // a non-default role (a tier escalation). Declaring nothing IS declaring the
  // default (D17, "what is deliberately NOT announced"), so that case asks for
  // nothing and announces nothing.
  let roleWasAsked = input.role !== 'default';
  // D17 row 7 — set when the D11c shim mapped the personality's own legacy id.
  let legacyDeviation: ModelDeviation | undefined;

  if (winner) {
    let parsed: ModelDeclaration | ModelDeclarationError = parseModelDeclaration(winner.value, {
      aliases,
    });
    // D11c — only the personality's OWN declaration (rung 3) is shimmed; see
    // `mapLegacyModelDeclaration` for why rungs 0–2 are not.
    if (parsed.kind === 'invalid' && winner.rung === 3) {
      const legacy = mapLegacyModelDeclaration({
        personalityId: input.personality.id,
        declared: winner.value,
        key: personalityDeclarationKey(input.personality.model, input.role),
        ctx: input.ctx,
      });
      if (legacy.kind === 'refused') return legacy.failure;
      if (legacy.kind === 'mapped') {
        parsed = legacy.declaration;
        legacyDeviation = legacy.deviation;
      }
    }
    if (parsed.kind === 'invalid') {
      return unresolved({
        declared: winner.value,
        reason: parsed.reason,
        aliases,
        fix:
          aliases.length > 0
            ? `Configured models: ${aliases.join(', ')}. Add one in Settings → Models, or declare a role (${MODEL_ROLE_NAMES.join(', ')}).`
            : 'No models are configured. Run `ethos migrate models` to build a registry from your provider chain.',
      });
    }
    if (parsed.kind === 'alias') {
      const entry = lookupEntry(registry, parsed.alias);
      if (entry) {
        return toResolved(
          entry,
          winner.source,
          true,
          legacyDeviation ?? outrankedDeviation(winner, input.personality, input.role, entry.alias),
        );
      }
      return unresolved({
        declared: parsed.alias,
        reason: `"${parsed.alias}" is not a model configured on this machine.`,
        aliases,
      });
    }
    role = parsed.role;
    roleWasAsked = true;
  }

  // Rung 4 — the role binding.
  const boundAlias = registry.roles[role];
  if (boundAlias) {
    const entry = lookupEntry(registry, boundAlias);
    if (!entry) {
      return unresolved({
        declared: boundAlias,
        reason: `The role "${role}" is bound to "${boundAlias}", which is not a model configured on this machine.`,
        aliases,
        fix: `Rebind "${role}" in Settings → Models.`,
      });
    }
    return toResolved(
      entry,
      'role-binding',
      // D21: pinned when someone NAMED this role — a run pin, a manifest, a
      // routing override or the personality itself. A role binding reached with
      // nothing declared is the deployment's own choice, not a pin, and stays
      // eligible for the provider chain.
      winner !== undefined,
      legacyDeviation ??
        (winner
          ? outrankedDeviation(winner, input.personality, input.role, entry.alias)
          : undefined),
    );
  }

  // Rung 5 — the default.
  const defaultAlias = registry.default;
  if (!defaultAlias) {
    return unresolved({
      declared: roleWasAsked ? role : '(none)',
      reason:
        aliases.length === 0
          ? 'No models are configured on this machine.'
          : 'This deployment has no default model.',
      aliases,
      fix: 'Set a default in Settings → Models, or run `ethos migrate models`.',
    });
  }
  const entry = lookupEntry(registry, defaultAlias);
  if (!entry) {
    return unresolved({
      declared: defaultAlias,
      reason: `The default model "${defaultAlias}" is not a model configured on this machine.`,
      aliases,
      fix: 'Set a default in Settings → Models.',
    });
  }

  const roleUnbound: ModelDeviation | undefined = roleWasAsked
    ? {
        kind: 'role-unbound',
        declared: role,
        effective: entry.alias,
        reason: `${entry.provider} · ${entry.modelId} is this machine's default model.`,
        fix: 'Bind one in Settings → Models.',
        once: true,
      }
    : undefined;
  // One slot, up to three candidate facts. A shim mapping wins: its reason
  // already says the mapped role is unbound, and "your declaration is a legacy
  // id that was rewritten" is recoverable from nothing else. Then `role-unbound`:
  // `source` already names the rung that outranked the declaration, so that half
  // survives without the deviation, while "the role you asked for is bound to
  // nothing" is recoverable from nothing else on the event.
  const deviation =
    legacyDeviation ??
    roleUnbound ??
    (winner ? outrankedDeviation(winner, input.personality, input.role, entry.alias) : undefined);

  // D21: the default rung is never pinned, so it — and only it — may ride the
  // provider chain.
  return toResolved(entry, 'default', false, deviation);
}

// ---------------------------------------------------------------------------
// D17 — one message builder, not eight call sites restating the copy
// ---------------------------------------------------------------------------

function deviationFrame(d: ModelDeviation): string {
  switch (d.kind) {
    case 'role-unbound':
      return `Asked for a "${d.declared}" model. Nothing is bound to "${d.declared}" on this machine, so it is running on the default — ${d.effective}.`;
    case 'entry-fallback':
      return `Pinned to "${d.declared}", which is not answering. Running on its declared fallback "${d.effective}".`;
    case 'chain-failover':
      return `${d.declared} did not answer. This turn ran on ${d.effective}, the next provider in your chain.`;
    case 'credential-rejected':
      return `The key for provider entry "${d.declared}" was rejected. Every model that uses it is unavailable until it is replaced; this turn ran on "${d.effective}".`;
    case 'legacy-id-mapped':
      // The HOW (an exact-id match, or a family read as a role) is in `reason`,
      // which the shim fills — "it matched" would be false for a role mapping.
      return `Declares the model "${d.declared}", which is not a configured model on this machine, so it is running on "${d.effective}".`;
    default:
      return `Declares the model "${d.declared}", which is outranked for this turn — running on "${d.effective}".`;
  }
}

function defaultFix(d: ModelDeviation): string | undefined {
  switch (d.kind) {
    case 'role-unbound':
      return 'Bind one in Settings → Models.';
    case 'entry-fallback':
      return 'You configured this fallback in Settings → Models.';
    case 'credential-rejected':
      return 'Settings → Models → replace the key for that provider entry.';
    case 'legacy-id-mapped':
      return `Make it explicit: set the model to "${d.effective}". This automatic mapping is removed in 0.10.0.`;
    default:
      return undefined;
  }
}

/**
 * The single renderer for every deviation, on every surface (D17).
 *
 * The CLI chat arm, the TUI, the channel adapters, the web notice, the
 * personality card, the `ethos doctor` row and the run record all call this
 * rather than restating the copy — a doctor row that drifts from the
 * turn-surface sentence is how one fact acquires two wordings and one of them
 * goes stale. The enforcer for "every surface actually calls it" is the
 * grep-shaped test `every surface renders a deviation through describeDeviation`
 * (T1.15a), which does not exist yet at the time this landed.
 *
 * `reason` is appended verbatim: it holds the vendor's own words where there are
 * any, and paraphrasing a vendor error is how a support thread loses the one
 * string that identified the problem.
 */
export function describeDeviation(d: ModelDeviation): { line: string; fix?: string } {
  const reason = d.reason.trim();
  const frame = deviationFrame(d);
  const line = reason.length > 0 ? `${frame} ${reason}` : frame;
  const fix = d.fix?.trim() || defaultFix(d);
  return fix ? { line, fix } : { line };
}

// ---------------------------------------------------------------------------
// D17 row 2 — an entry's declared fallbacks
// ---------------------------------------------------------------------------

/**
 * Every declared fallback for an alias was tried and none answered (D6).
 *
 * Thrown only when at least one fallback was ATTEMPTED. When an entry declares
 * no usable fallback the original error propagates untouched instead, because
 * the caller is the one that classifies it — an `auth` error is deliberately not
 * failover-eligible (D17 row 4) and a model rejection has to keep the vendor's
 * verbatim body (D17 row 5). Wrapping those would hide the string that names the
 * problem.
 */
export class ModelFallbacksExhaustedError extends Error {
  readonly failure: ModelResolutionFailure;

  constructor(failure: ModelResolutionFailure, options?: { cause?: unknown }) {
    super(failure.reason, options);
    this.name = 'ModelFallbacksExhaustedError';
    this.failure = failure;
  }
}

/**
 * Try a resolved model, then each of its declared fallbacks in order (D17 row 2).
 *
 * Pure by injection: `attempt` is the caller's, so no provider, no transport and
 * no clock enters core. The deviation is emitted BEFORE each fallback attempt
 * because its carrier is a second `run_start` (T1.15b) — the event says which
 * model this attempt is running on, which is knowable before the answer is.
 *
 * `once: false` on every emission: a fallback in use is a LIVE condition, and
 * its absence on the next turn is itself information (D17).
 *
 * Fallbacks are same-provider-only. That is enforced by `validateModelRegistry`
 * in `packages/config/src/model-registry.ts` (T1.3, not yet written at the time
 * this landed), pinned there by `fallback across providers is refused`. Until it
 * exists — and afterwards, for a config that reached disk another way — a
 * cross-provider fallback is skipped here rather than trusted: an expired local
 * token must never become an egress event to a cloud vendor (D6).
 */
export async function attemptWithFallbacks<T>(opts: {
  resolved: ResolvedModel;
  registry: ModelRegistry;
  attempt: (m: ResolvedModel) => Promise<T>;
  onDeviation?: (d: ModelDeviation) => void;
  /**
   * A4 — user-facing fallback notice seam, called once per hop BEFORE the
   * fallback attempt with the alias that just failed and the alias about to
   * be tried. Nothing is emitted here because this function is not a
   * generator inside the turn: rendering is the caller's job. LIMITATION:
   * nothing in production calls `attemptWithFallbacks` yet — the seam is not
   * wired into the loop, so no `_loop` notice exists today. A future caller
   * inside the turn should pass an `onFallback` that emits a
   * `toolName: '_loop'` `tool_progress` with `audience: 'user'` (the shape
   * the CLI and TUI already render as a one-line yellow notice).
   */
  onFallback?: (from: string, to: string) => void;
}): Promise<T> {
  try {
    return await opts.attempt(opts.resolved);
  } catch (primaryError) {
    const primary = lookupEntry(opts.registry, opts.resolved.alias);
    const declared = primary?.fallbacks ?? [];
    let lastError: unknown = primaryError;
    let lastAlias = opts.resolved.alias;
    let attempted = 0;

    for (const alias of declared) {
      const entry = lookupEntry(opts.registry, alias);
      if (!entry) continue;
      if (entry.provider !== opts.resolved.providerKey) continue;

      const deviation: ModelDeviation = {
        kind: 'entry-fallback',
        declared: opts.resolved.alias,
        effective: entry.alias,
        reason: `${opts.resolved.providerKey} did not answer: ${errorText(lastError)}`,
        once: false,
      };
      opts.onDeviation?.(deviation);
      opts.onFallback?.(lastAlias, entry.alias);
      lastAlias = entry.alias;
      attempted += 1;

      try {
        return await opts.attempt(
          toResolved(entry, opts.resolved.source, opts.resolved.pinned, deviation),
        );
      } catch (fallbackError) {
        lastError = fallbackError;
      }
    }

    if (attempted === 0) throw primaryError;
    throw new ModelFallbacksExhaustedError(
      {
        ok: false,
        code: 'model_unresolved',
        declared: opts.resolved.alias,
        reason: `"${opts.resolved.alias}" and every fallback it declares (${declared.join(', ')}) failed. Last error: ${errorText(lastError)}`,
        configuredAliases: Object.keys(opts.registry.entries),
        fix: 'Settings → Models → Test the provider entry these models share.',
      },
      { cause: lastError },
    );
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
