// Lane 5(i) — tier-mismatch startup diagnostic.
//
// `resolveModelWithTier` (packages/core/src/agent-loop/turn-context.ts) only
// honors a personality's `model` tier map when the personality's declared
// `provider` matches the active LLM's name — the guard prevents e.g.
// Anthropic-specific model IDs from being injected into an Ollama/OpenRouter
// provider, and it STAYS. Its side effect is that a personality declaring
// tiers without a matching `provider` gets them silently dropped: every turn
// falls through to the global model. This helper makes the mismatch visible
// at loop construction. Warning, not refusal (plan risk note: surfacing
// latent misconfiguration is the point).

import { resolveModelWithTier } from '@ethosagent/core';
import type { CharacterSheetRouting } from '@ethosagent/personalities';
import type { PersonalityConfig } from '@ethosagent/types';

/**
 * Returns a warning message when `personality` declares a model tier map that
 * the active LLM will silently ignore, or `undefined` when there is nothing
 * to say (no `model` block, a plain string model, or a matching provider).
 * Pure — the caller decides where the warning goes.
 */
export function evaluateTierMismatch(
  personality: PersonalityConfig,
  activeLlmName: string,
): string | undefined {
  const tierMap = personality.model;
  if (!tierMap || typeof tierMap !== 'object') return undefined;
  if (personality.provider === activeLlmName) return undefined;
  const tiers = Object.entries(tierMap)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
    .map(([tier, model]) => `${tier}=${model}`)
    .join(', ');
  return (
    `personality \`${personality.id}\` declares model tiers (${tiers}) for provider ` +
    `"${personality.provider ?? '(none)'}", but the active LLM is "${activeLlmName}" — ` +
    'the tiers are inert and every turn falls through to the global model. ' +
    `Declare \`provider: ${activeLlmName}\` (with model ids that provider serves) ` +
    "in the personality's config.yaml to activate them."
  );
}

/**
 * The `name` the LLM assembled by `createLLM` (`packages/wiring/src/index.ts`)
 * will report — the value `resolveModelWithTier` compares
 * `personality.provider` against. A fallback chain of two or more providers is
 * wrapped in `ChainedProvider`, whose name is `chain(a,b)`
 * (`packages/core/src/providers/chained-provider.ts`), so in a chained
 * deployment NO personality provider matches and every tier map is inert.
 * Pinned against the real provider by `tier-diagnostics.test.ts`.
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
 * ACTUALLY send, and, when the personality declares one the active LLM ignores,
 * why nothing reads it.
 *
 * Asks the enforcer rather than restating its rule: `resolveModelWithTier`
 * (`packages/core/src/agent-loop/turn-context.ts`) is the function every turn
 * calls, so the sheet cannot drift from the guard. It is called with an EMPTY
 * routing map so the personality's own declaration is evaluated in isolation;
 * the `modelRouting` override is applied here, on top, because it is a
 * different source and the sheet has to name which one won.
 *
 * This is the read-only sibling of {@link evaluateTierMismatch}, which logs the
 * same mismatch once at loop construction.
 */
export function resolveCharacterSheetRouting(
  personality: PersonalityConfig,
  activeProvider: string,
  globalModel: string,
  modelRouting: Record<string, string> = {},
): CharacterSheetRouting {
  const declared = resolveModelWithTier(personality, 'default', {}, activeProvider, globalModel);
  const override = modelRouting[personality.id];
  const source: CharacterSheetRouting['source'] = override
    ? 'routing-override'
    : declared.source === 'personality'
      ? 'personality'
      : 'global';
  const routing: CharacterSheetRouting = {
    activeProvider,
    effectiveModel: override ?? declared.model,
    source,
  };
  const text = declaredModelText(personality.model);
  if (text !== undefined && source !== 'personality') {
    routing.inert = {
      declared: text,
      reason: override
        ? `\`modelRouting.${personality.id}\` in config.yaml overrides it`
        : typeof personality.model === 'string'
          ? 'a plain `model:` string is never applied — resolveModelWithTier reads a tier map only'
          : `declares provider "${personality.provider ?? '(none)'}", active LLM is "${activeProvider}"`,
    };
  }
  return routing;
}
