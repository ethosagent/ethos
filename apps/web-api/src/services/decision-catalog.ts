// The decision-provider TYPE catalog — every kind of decision model Settings
// can add (plan/phases/decision-provider-jev.md §7). One entry today: Jev, by
// TypeSafe. `decisions.list` returns it as `catalog`; the Add decision model
// drawer (apps/web settings/components/decision-models-section.tsx) renders
// whatever is here, so a second provider is one entry below plus its
// extension and wiring — no UI change.
//
// Lockstep, both directions:
// - `DECISION_PROVIDER_META` is a `Record<DecisionProviderName, …>`, so a
//   provider added to `DECISION_PROVIDERS` (@ethosagent/config) without an
//   entry here fails typecheck, and one whose id the contract enum
//   (`DecisionProviderIdSchema`, @ethosagent/web-contracts) lacks fails the
//   `DecisionProviderType` annotation below.
// - The reverse (an enum value with no config provider) is pinned by
//   `__tests__/services/decisions.service.test.ts` ("catalog").

import {
  DECISION_PROVIDERS,
  DECISIONS_API_KEY_REF,
  DECISIONS_DEFAULT_BASE_URL,
  DECISIONS_DEFAULT_MODEL,
  type DecisionProviderName,
} from '@ethosagent/config';
import type { DecisionProviderType } from '@ethosagent/web-contracts';

const DECISION_PROVIDER_META: Record<DecisionProviderName, Omit<DecisionProviderType, 'id'>> = {
  typesafe: {
    label: 'Jev',
    vendor: 'TypeSafe',
    description:
      'Answers typed questions about what the agent is doing — does this tool output carry ' +
      'instructions, should this call be approved, which model fits this turn — with a ' +
      'probability instead of text.',
    getKeyUrl: 'https://console.typesafe.ai',
    // The ref `buildDecisionProvider` (@ethosagent/wiring) reads.
    keyRef: DECISIONS_API_KEY_REF,
    defaultModel: DECISIONS_DEFAULT_MODEL,
    defaultBaseUrl: DECISIONS_DEFAULT_BASE_URL,
  },
};

/** Every decision-provider type, in `DECISION_PROVIDERS` order. */
export const DECISION_PROVIDER_CATALOG: readonly DecisionProviderType[] = DECISION_PROVIDERS.map(
  (id): DecisionProviderType => ({ id, ...DECISION_PROVIDER_META[id] }),
);

/** The catalog entry for `id`. Total over `DecisionProviderName`. */
export function decisionProviderType(id: DecisionProviderName): DecisionProviderType {
  return { id, ...DECISION_PROVIDER_META[id] };
}
