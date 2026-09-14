// Which provider ENTRY a resolved model is sent to, and whether it carries a
// `modelOverride` at all (D21 / D23b of plan/phases/model-registry.md).
//
// `turn-setup.ts` used to compare the resolved model against `deps.llm.model`.
// For a `ChainedProvider` that getter is the first hop NOT cooling down, so
// while hop 1 cooled, a default-rung turn resolved hop 1's model, saw it
// differ from hop 2's, and sent hop 1's model id as an override to EVERY hop.
// Here the comparison is against the entry the registry named, and the
// override is scoped to that entry (`CompletionOptions.providerEntry`, read by
// `ChainedProvider.optionsFor`).

import type { CompletionOptions, LLMProvider, ModelResolutionContext } from '@ethosagent/types';
import { ChainedProvider, providerEntriesOf } from '../providers/chained-provider';
import type { TurnModel } from './turn-model';

export type TurnModelRoute =
  | {
      ok: true;
      modelOverride?: string;
      providerEntry?: NonNullable<CompletionOptions['providerEntry']>;
    }
  | { ok: false; reason: string };

export function routeTurnModel(
  llm: LLMProvider,
  turn: TurnModel,
  ctx: ModelResolutionContext,
): TurnModelRoute {
  const registryConfigured = Object.keys(ctx.registry.entries).length > 0;
  // D11b legacy path, or a provider nothing tagged with an entry key: there is
  // no entry to scope against, so the value read in this same tick decides.
  const entries = registryConfigured ? providerEntriesOf(llm) : undefined;
  if (!entries)
    return turn.model !== llm.model ? { ok: true, modelOverride: turn.model } : { ok: true };

  const entry = entries.find((e) => e.key === turn.provider);
  if (!entry) {
    return {
      ok: false,
      reason:
        `The model "${turn.model}" runs on provider entry "${turn.provider}", which this agent ` +
        `cannot call — the providers it runs are: ${entries.map((e) => e.key).join(', ')}. ` +
        `Nothing ran, and it was not sent to one of those instead. Fix: make "${turn.provider}" a ` +
        `failover hop (remove \`providers.<n>.failover: false\` from that entry in ` +
        `~/.ethos/config.yaml), or point this model at one of those entries in Settings → Models.`,
    };
  }

  const modelOverride = turn.model !== entry.model ? turn.model : undefined;
  // A default-rung turn on the entry's own model rides the chain with every
  // hop on its own model — nothing to scope.
  if (!turn.pinned && modelOverride === undefined) return { ok: true };
  return {
    ok: true,
    ...(modelOverride !== undefined ? { modelOverride } : {}),
    // A single provider IS its entry; only a chain has other hops to keep out.
    ...(llm instanceof ChainedProvider
      ? { providerEntry: { key: entry.key, pinned: turn.pinned } }
      : {}),
  };
}
