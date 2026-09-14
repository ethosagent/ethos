// What THIS turn runs on — `resolveModel` plus the one thing a pure resolver
// cannot own: a deployment that has no registry yet (D11b).
//
// `resolveModel` (`packages/core/src/model-resolution.ts`) is the six-rung
// resolver and stays pure: with an empty registry it REFUSES, because there is
// no alias to name and refusing is the right answer once a registry exists. But
// every deployment that upgrades into this release has no `modelRegistry.*` at
// all, and refusing every turn on all of them is not a migration — it is an
// outage. D11b gives that case one minor release of today's behaviour.
//
// The shim lives HERE rather than in `model-resolution.ts` (whose own comment
// says the legacy fallback is not there) and rather than in
// `packages/wiring` (where D11b suggests it, but where nothing sits between the
// caller and `setupTurn`). One implementation, read by the turn path
// (`turn-setup.ts`), the mid-turn escalation (`stream-step.ts`) and the
// character sheet (`packages/wiring/src/tier-diagnostics.ts`), so the sheet
// cannot claim a model the turn would not send.

import type {
  ModelDeviation,
  ModelResolutionContext,
  ModelResolutionFailure,
  ModelResolutionSource,
  ModelRoleName,
  PersonalityConfig,
} from '@ethosagent/types';
import {
  mapLegacyModelDeclaration,
  parseModelDeclaration,
  resolveModel,
} from '../model-resolution';

/** What a turn resolved to, flattened to what `run_start` and the LLM call need. */
export interface TurnModel {
  ok: true;
  /** `ResolvedModel.providerKey`, or the loop's own provider on the legacy path. */
  provider: string;
  /** The vendor id to send on the wire. */
  model: string;
  source: ModelResolutionSource;
  /**
   * `ResolvedModel.pinned` (D21): someone named this model, so it never rides
   * the provider chain. On the legacy path a `/model` pin or a routing
   * override is pinned and the deployment default is not.
   */
  pinned: boolean;
  deviation?: ModelDeviation;
}

export type TurnModelResult = TurnModel | ModelResolutionFailure;

/**
 * The D11b legacy context: no registry, no routing. A FACTORY, not a shared
 * frozen const — two loops in one process must not hand each other the same
 * mutable object.
 */
export function emptyModelResolution(): ModelResolutionContext {
  return { registry: { entries: {}, roles: {} }, routing: {} };
}

/** A `modelRouting` / manifest lookup that a `__proto__` key cannot answer for. */
function lookup(map: Record<string, string> | undefined, key: string): string | undefined {
  if (!map || !Object.hasOwn(map, key)) return undefined;
  const value = map[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Resolve the model for one turn.
 *
 * With a configured registry this is exactly `resolveModel` — the D7 rung
 * order, unmodified.
 *
 * With an EMPTY registry it is today's behaviour (D11b): a `/model` pin, then
 * `modelRouting[id]`, then the deployment default. The personality's own
 * declaration is deliberately NOT read on that path — the values in it are raw
 * vendor ids (V1/V2) and applying them verbatim is how an Anthropic SKU reaches
 * an Ollama endpoint. That is the case the deleted `personality.provider ===
 * llm.name` guard was protecting, and once a registry exists the protection is
 * structural instead: every alias names its own provider entry (D8). No
 * deviation is raised here — nothing deviated from anything that resolves.
 */
export function resolveTurnModel(input: {
  personality: Pick<PersonalityConfig, 'id' | 'model'>;
  role: ModelRoleName;
  ctx: ModelResolutionContext;
  runOverride?: string;
  isCoordinator?: boolean;
  /** `LLMProvider.name` — the legacy path's provider. */
  llmName: string;
  /** `LLMProvider.model` — the legacy path's deployment default. */
  llmModel: string;
}): TurnModelResult {
  if (Object.keys(input.ctx.registry.entries).length === 0) {
    const pin = input.runOverride?.trim();
    if (pin) {
      return {
        ok: true,
        provider: input.llmName,
        model: pin,
        source: 'run-override',
        pinned: true,
      };
    }
    const routed = lookup(input.ctx.routing, input.personality.id);
    if (routed) {
      return {
        ok: true,
        provider: input.llmName,
        model: routed,
        source: 'routing-override',
        pinned: true,
      };
    }
    return {
      ok: true,
      provider: input.llmName,
      model: input.llmModel,
      source: 'default',
      pinned: false,
    };
  }

  const resolved = resolveModel({
    personality: personalityForRole(input.personality, input.role, input.ctx),
    role: input.role,
    ctx: input.ctx,
    ...(input.runOverride ? { runOverride: input.runOverride } : {}),
    ...(input.isCoordinator !== undefined ? { isCoordinator: input.isCoordinator } : {}),
  });
  if ('ok' in resolved) return resolved;

  return {
    ok: true,
    provider: resolved.providerKey,
    model: resolved.modelId,
    source: resolved.source,
    pinned: resolved.pinned,
    ...(resolved.deviation ? { deviation: resolved.deviation } : {}),
  };
}

/**
 * A per-turn ROLE request outranks a role the personality declared as its own.
 *
 * The turn-level cases are `/tier deep` and the one-shot `think_deeper`
 * escalation: both mean "for this turn, give me your deep model". A personality
 * declaring a TIER MAP already answers that — `personalityDeclaration` indexes
 * the map by the requested role. A personality declaring the string form of a
 * role does not: `resolveModel` reads that string as THE role and replaces the
 * request with it, so `deep` would resolve to whatever the declared role binds
 * to and the escalation would be inert — the same silence V10 describes, moved
 * one layer down.
 *
 * So on an escalated turn the declared ROLE is dropped and the request falls to
 * the role binding (rung 4). A declared ALIAS is NOT dropped: an alias is a pin
 * — the author naming one model, for a reason the framework cannot see — and
 * rung 3 beating rung 4 is the D7 rung table, pinned by `rung 3 beats rung 4`
 * in `model-resolution.test.ts`.
 */
function personalityForRole(
  personality: Pick<PersonalityConfig, 'id' | 'model'>,
  role: ModelRoleName,
  ctx: ModelResolutionContext,
): Pick<PersonalityConfig, 'id' | 'model'> {
  if (role === 'default') return personality;
  if (typeof personality.model !== 'string') return personality;
  const parsed = parseModelDeclaration(personality.model, {
    aliases: Object.keys(ctx.registry.entries),
  });
  if (parsed.kind === 'role') return { id: personality.id };
  // A legacy vendor id the D11c shim reads as a ROLE is a role declaration for
  // this purpose too — otherwise `model: claude-sonnet-4-6` would pin every
  // escalation to the `default` role. One mapped to an ALIAS stays a pin.
  if (parsed.kind === 'invalid') {
    const legacy = mapLegacyModelDeclaration({
      personalityId: personality.id,
      declared: personality.model,
      key: 'model',
      ctx,
    });
    if (legacy.kind === 'mapped' && legacy.declaration.kind === 'role')
      return { id: personality.id };
  }
  return personality;
}

/**
 * The refusal a turn shows when the declaration does not resolve (D6/D14).
 *
 * One builder so the CLI, the channels and the web all read the same sentence,
 * and so the configured aliases are always listed — a refusal that does not say
 * what WOULD have worked is a refusal the operator has to go read a file to act
 * on.
 */
export function describeResolutionFailure(
  personalityId: string,
  failure: ModelResolutionFailure,
): string {
  const fix = failure.fix?.trim();
  // `resolveModel` puts the roster in its `fix` for the declaration cases, so
  // adding it again would print the same list twice in one sentence.
  const listed = fix?.includes('Configured models:') === true;
  const configured = listed
    ? ''
    : failure.configuredAliases.length > 0
      ? ` Configured models: ${failure.configuredAliases.join(', ')}.`
      : ' No models are configured on this machine.';
  return `Personality "${personalityId}" declares the model "${failure.declared}", which does not resolve. ${failure.reason}${configured}${fix ? ` ${fix}` : ''}`;
}
