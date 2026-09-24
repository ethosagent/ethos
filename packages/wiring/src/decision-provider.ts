// Builds the ONE decision provider a composition root shares across its
// decision sites (plan/phases/decision-provider-jev.md §7, M1). One instance,
// so every site sees the same breaker (§5.5): an outage opens it once for all.
//
// "Off means today" (R7): returns `undefined` — no provider constructed, no
// vault read — unless `decisions.provider` is configured AND at least one of
// the sites this root wires is `shadow` or `on`. A configured provider with no
// key stored in `providers/typesafe/apiKey` also returns `undefined`, so every
// site takes today's path; `ethos doctor` names the missing ref
// (`checkDecisionLayer`, apps/ethos/src/commands/doctor.ts). Pinned by
// `__tests__/decision-wiring.test.ts`.

import {
  DECISIONS_API_KEY_REF,
  type DecisionSiteId,
  type ResolvedDecisionsConfig,
} from '@ethosagent/config';
import type { DecisionBreakerEvent, DecisionProvider } from '@ethosagent/decision-typesafe';
import type { SecretsResolver } from '@ethosagent/types';

export interface DecisionBreakerRecorder {
  recordDecisionBreaker(event: DecisionBreakerEvent): void;
}

export interface BuildDecisionProviderOptions {
  decisions: ResolvedDecisionsConfig | undefined;
  /** The sites this composition root has wired to a decision provider. */
  sites: readonly DecisionSiteId[];
  secrets: SecretsResolver | undefined;
  observability?: DecisionBreakerRecorder;
}

export async function buildDecisionProvider(
  opts: BuildDecisionProviderOptions,
): Promise<DecisionProvider | undefined> {
  const d = opts.decisions;
  if (!d) return undefined;
  if (!opts.sites.some((site) => d.sites[site].effective !== 'off')) return undefined;
  if (!opts.secrets) return undefined;
  // Same presence rule as `checkDecisionLayer` in doctor: a read failure or a
  // blank value is "no key".
  const apiKey = await opts.secrets.get(DECISIONS_API_KEY_REF).catch(() => null);
  if (apiKey === null || apiKey.trim().length === 0) return undefined;

  const { createTypesafeDecisionProvider } = await import('@ethosagent/decision-typesafe');
  const observability = opts.observability;
  return createTypesafeDecisionProvider({
    apiKey,
    model: d.model,
    baseUrl: d.baseUrl,
    // The breaker's yardstick (R9): a timeout counts only on a budget ≥ this.
    timeoutMs: d.timeoutMs,
    ...(observability
      ? {
          onEvent: (event: DecisionBreakerEvent) => {
            try {
              observability.recordDecisionBreaker(event);
            } catch {
              // Observability is fail-open.
            }
          },
        }
      : {}),
  });
}
