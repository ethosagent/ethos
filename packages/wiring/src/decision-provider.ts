// The ONE decision provider a composition root shares across its decision
// sites (plan/phases/decision-provider-jev.md §7, M1), as a LAZY handle (plan
// decision-provider-personality §7.0, PD8). One handle per build, so every
// site sees the same provider and therefore the same breaker (§5.5): an outage
// opens it once for all.
//
// "Off means today" (R7): creating the handle reads nothing. The vault is read
// — and the provider constructed — on the first `get()`, and every site calls
// `get()` only after `resolvePersonalityDecisionSite` (packages/config) resolved
// a mode other than `off` for the turn's personality. So a build whose
// personalities enable no site never reads `providers/typesafe/apiKey`, and a
// personality that enables a site after boot (hot reload) is served without a
// rebuild. The first result is memoised, INCLUDING `undefined` for a missing
// or blank key (today's read-once semantics): every site then takes today's
// path, and `ethos doctor` names the missing ref (`checkDecisionLayer`,
// apps/ethos/src/commands/doctor.ts). Pinned by `__tests__/decision-wiring.test.ts`.

import { DECISIONS_API_KEY_REF, type ResolvedDecisionsConfig } from '@ethosagent/config';
import type { DecisionBreakerEvent } from '@ethosagent/decision-typesafe';
import type { DecisionProvider, SecretsResolver } from '@ethosagent/types';

export interface DecisionBreakerRecorder {
  recordDecisionBreaker(event: DecisionBreakerEvent): void;
}

export interface CreateDecisionProviderHandleOptions {
  /** The operator's resolved `decisions.*` (a handle exists only when it does). */
  decisions: ResolvedDecisionsConfig;
  secrets: SecretsResolver | undefined;
  observability?: DecisionBreakerRecorder;
}

/** The build's one provider, constructed on first use. */
export interface DecisionProviderHandle {
  /** `undefined` = no key (or no secrets resolver): today's path at every site. */
  get(): Promise<DecisionProvider | undefined>;
}

export function createDecisionProviderHandle(
  opts: CreateDecisionProviderHandleOptions,
): DecisionProviderHandle {
  let pending: Promise<DecisionProvider | undefined> | undefined;
  return {
    get: () => {
      pending ??= buildProvider(opts).catch(() => undefined);
      return pending;
    },
  };
}

async function buildProvider(
  opts: CreateDecisionProviderHandleOptions,
): Promise<DecisionProvider | undefined> {
  const d = opts.decisions;
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
