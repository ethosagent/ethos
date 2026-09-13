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

import { resolveTurnModel } from '@ethosagent/core';
import type { CharacterSheetRouting } from '@ethosagent/personalities';
import type { ModelRegistry, PersonalityConfig } from '@ethosagent/types';

/** The D11b legacy context: no registry yet, so only `modelRouting` declares. */
const EMPTY_REGISTRY: ModelRegistry = { entries: {}, roles: {} };

/**
 * The `name` the LLM assembled by `createLLM` (`packages/wiring/src/index.ts`)
 * will report. A fallback chain of two or more providers is wrapped in
 * `ChainedProvider`, whose name is `chain(a,b)`
 * (`packages/core/src/providers/chained-provider.ts`). Pinned against the real
 * provider by `tier-diagnostics.test.ts`.
 *
 * Derived from config rather than read off a live provider because the
 * character sheet is a read-only diagnostic — building an LLM to print one
 * line would cost a credential resolution and a network-capable handle.
 */
export function resolveActiveLlmName(config: {
  provider: string;
  providers?: readonly { provider: string }[];
}): string {
  if (config.providers && config.providers.length >= 2) {
    return `chain(${config.providers.map((p) => p.provider).join(',')})`;
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
 * What `## Routing` on the character sheet should say — the model a turn will
 * ACTUALLY send, and, when the personality declares one nothing reads, why.
 *
 * Asks the enforcer rather than restating its rule: `resolveTurnModel`
 * (`packages/core/src/agent-loop/turn-model.ts`) is the function `setupTurn`
 * calls, so the sheet cannot claim a model the turn would not send.
 *
 * **Interim shape (T1.5).** It is called with an EMPTY registry, so it renders
 * the D11b legacy path only: a `modelRouting` entry wins, otherwise the
 * deployment default, and any personality declaration is reported inert — which
 * is exactly what a turn on a registry-less deployment does. T1.11 replaces
 * this with the real rung chain once `ModelResolutionContext` is assembled from
 * config (T1.8) and threaded to the sheet; the `CharacterSheetRouting` shape is
 * unchanged here on purpose, because widening it is that task's job.
 */
export function resolveCharacterSheetRouting(
  personality: PersonalityConfig,
  activeProvider: string,
  globalModel: string,
  modelRouting: Record<string, string> = {},
): CharacterSheetRouting {
  const resolved = resolveTurnModel({
    personality,
    role: 'default',
    ctx: { registry: EMPTY_REGISTRY, routing: modelRouting },
    llmName: activeProvider,
    llmModel: globalModel,
  });
  const override = modelRouting[personality.id];
  const source: CharacterSheetRouting['source'] =
    resolved.ok && resolved.source === 'routing-override' ? 'routing-override' : 'global';
  const routing: CharacterSheetRouting = {
    activeProvider,
    effectiveModel: resolved.ok ? resolved.model : globalModel,
    source,
  };
  const text = declaredModelText(personality.model);
  if (text !== undefined) {
    routing.inert = {
      declared: text,
      reason: override
        ? `\`modelRouting.${personality.id}\` in config.yaml overrides it`
        : 'no model registry is configured on this machine, so every declaration falls ' +
          'through to the deployment default — run `ethos migrate models` to build one',
    };
  }
  return routing;
}
