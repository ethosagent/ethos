// What `## Routing` on the character sheet says, and how the active LLM's name
// is derived for it.
//
// `evaluateTierMismatch` lived here and is GONE (D8/T1.7). It existed only to
// describe the damage done by the `personality.provider === llmName` guard in
// `resolveModelWithTier` — a guard that made every tier map inert on any
// chained deployment (V2) and every plain-string declaration inert everywhere
// (V1). The guard is deleted at all three of its sites and its stated purpose —
// stop an Anthropic SKU reaching an Ollama endpoint — is served structurally
// now: a resolved model carries the provider entry its own registry row names
// (`toResolved` in `packages/core/src/model-resolution.ts`), so there is no
// path left that pairs a model with a provider it did not name.

import type { ProviderChainEntry } from '@ethosagent/config';
import {
  describeDeviation,
  describeResolutionFailure,
  mapLegacyModelDeclaration,
  resolveModel,
  resolveTurnModel,
} from '@ethosagent/core';
import type { CharacterSheetRouting } from '@ethosagent/personalities';
import type { ModelRegistry, ModelResolutionContext, PersonalityConfig } from '@ethosagent/types';
import { selectServingProviderEntries } from './chain-hops';
import { lookupLegacyCatalogModelId } from './model-catalog';

/** The D11b legacy context: no registry yet, so only `modelRouting` declares. */
const EMPTY_REGISTRY: ModelRegistry = { entries: {}, roles: {} };

/** A `modelRouting` lookup a `__proto__` key cannot answer for — the same
 *  guard `lookupString` applies in `packages/core/src/model-resolution.ts`. */
function routedValue(routing: Record<string, string>, id: string): string | undefined {
  if (!Object.hasOwn(routing, id)) return undefined;
  const value = routing[id];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The `name` the LLM assembled by `createLLM` (`packages/wiring/src/index.ts`)
 * will report. For a chain of two or more entries the hops are
 * `selectServingProviderEntries` (`./chain-hops.ts`) — the same call
 * `createLLMFromRegistry` builds from, so a `failover: false` entry is left out
 * here exactly as it is there. Two or more hops are wrapped in
 * `ChainedProvider`, whose name is `chain(a,b)`
 * (`packages/core/src/providers/chained-provider.ts`); one hop is used directly
 * and reports its own name. Pinned against the real provider by
 * `tier-diagnostics.test.ts`.
 *
 * Derived from config rather than read off a live provider because the
 * character sheet is a read-only diagnostic — building an LLM to print one
 * line would cost a credential resolution and a network-capable handle.
 */
export function resolveActiveLlmName(config: {
  provider: string;
  providers?: readonly ProviderChainEntry[];
  modelRegistry?: ModelRegistry;
}): string {
  if (config.providers && config.providers.length >= 2) {
    const serving = selectServingProviderEntries(config.providers, config.modelRegistry);
    const names = serving.map(({ entry }) => entry.provider);
    return names.length >= 2 ? `chain(${names.join(',')})` : (names[0] ?? config.provider);
  }
  return config.provider;
}

/** The declared model as a reader would recognise it: the string itself, or
 *  the tier map spelled out. `undefined` when nothing usable is declared. */
function declaredModelText(model: PersonalityConfig['model']): string | undefined {
  if (!model) return undefined;
  if (typeof model === 'string') return model;
  const tiers = Object.entries(model)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
    .map(([tier, id]) => `${tier}=${id}`);
  return tiers.length > 0 ? tiers.join(', ') : undefined;
}

/**
 * The personality's own declaration for the `default` role — the value rung 3
 * of `resolveModel` reads (`personalityDeclaration` in
 * `packages/core/src/model-resolution.ts`): a string, or a tier map's `default`
 * leaf. Only used to NAME the role that was declared; the model itself always
 * comes from the resolver.
 */
function defaultRoleDeclaration(model: PersonalityConfig['model']): string | undefined {
  const picked = typeof model === 'string' ? model : model?.default;
  if (typeof picked !== 'string') return undefined;
  const trimmed = picked.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * What `## Routing` on the character sheet should say — the vendor model a turn
 * will ACTUALLY send, how it was reached (alias, role, the rung that declared
 * it), a refusal when nothing resolves, and, when the personality declares a
 * model something outranks, why it is not used.
 *
 * Asks the enforcer rather than restating its rule: `resolveTurnModel`
 * (`packages/core/src/agent-loop/turn-model.ts`) is the function `setupTurn`
 * calls, so the sheet cannot claim a model the turn would not send. With a
 * non-empty registry and the `default` role that function IS `resolveModel`
 * (`personalityForRole` returns the personality unchanged for `default`), which
 * is called alongside it only for the alias and role the flattened `TurnModel`
 * drops. Agreement of the two is pinned by `tier-diagnostics.test.ts`.
 *
 * The sheet has no run pin and no team manifest, so the declaring rung is the
 * `modelRouting` entry (rung 2) when there is one, otherwise the personality
 * (rung 3), otherwise nothing — `declaringRungs` in
 * `packages/core/src/model-resolution.ts` owns that order.
 *
 * `registry` is the deployment's `modelRegistry` — required, not optional, so a
 * caller cannot forget it and silently render the legacy path. `undefined` (no
 * registry configured) is the D11b legacy path: a `modelRouting` entry wins,
 * otherwise the deployment default, and any declaration falls through.
 */
export function resolveCharacterSheetRouting(
  personality: PersonalityConfig,
  activeProvider: string,
  globalModel: string,
  modelRouting: Record<string, string>,
  registry: ModelRegistry | undefined,
): CharacterSheetRouting {
  // The same context `build-agent-loop.ts` hands the loop, catalog lookup
  // included, so the sheet and the turn apply the same D11c shim.
  const ctx: ModelResolutionContext = {
    registry: registry ?? EMPTY_REGISTRY,
    routing: modelRouting,
    catalogModelId: lookupLegacyCatalogModelId,
  };
  const turn = resolveTurnModel({
    personality,
    role: 'default',
    ctx,
    llmName: activeProvider,
    llmModel: globalModel,
  });
  const routed = routedValue(modelRouting, personality.id);
  const declared = routed ?? defaultRoleDeclaration(personality.model);
  // The same emptiness test `resolveTurnModel` branches on.
  const legacy = Object.keys(ctx.registry.entries).length === 0;

  const source: CharacterSheetRouting['source'] = routed
    ? 'routing-override'
    : declared !== undefined && !legacy
      ? 'personality'
      : 'global';

  let routing: CharacterSheetRouting;
  if (!turn.ok) {
    routing = { activeProvider, source, refusal: describeResolutionFailure(personality.id, turn) };
  } else if (legacy) {
    routing = { activeProvider, effectiveModel: turn.model, source };
  } else {
    routing = { activeProvider, effectiveModel: turn.model, source };
    const resolved = resolveModel({ personality, role: 'default', ctx });
    if (!('ok' in resolved)) {
      routing.alias = resolved.alias;
      const deviation = resolved.deviation;
      if (deviation?.kind === 'role-unbound') {
        routing.role = { name: deviation.declared, bound: false };
      } else if (deviation?.kind === 'legacy-id-mapped') {
        // D11c — the same shim the turn ran, asked again only for the ROLE the
        // flattened result drops; the words come from `describeDeviation`.
        const { line, fix } = describeDeviation(deviation);
        routing.notice = fix ? `${line} ${fix}` : line;
        const mapped = mapLegacyModelDeclaration({
          personalityId: personality.id,
          declared: deviation.declared,
          key: 'model',
          ctx,
        });
        if (mapped.kind === 'mapped' && mapped.declaration.kind === 'role') {
          routing.role = { name: mapped.declaration.role, bound: false };
        }
      } else if (resolved.source === 'role-binding') {
        // A role reached with nothing declared is the `default` role's binding.
        routing.role = { name: declared ?? 'default', bound: true };
      }
    }
  }

  const text = declaredModelText(personality.model);
  if (text !== undefined && (routed || legacy)) {
    routing.inert = {
      declared: text,
      reason: routed
        ? `\`modelRouting.${personality.id}\` in config.yaml takes priority`
        : 'no model registry is configured on this machine, so every declaration falls ' +
          'through to the deployment default — run `ethos migrate models` to build one',
    };
  }
  return routing;
}
