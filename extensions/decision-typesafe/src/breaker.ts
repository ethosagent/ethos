// Circuit breaker for the Jev provider (plan §5.5, R3, R9).
//
//  CLOSED ──(3 consecutive health failures*)──► OPEN ──(60 s)──► HALF-OPEN (one probe)
//    ▲                                     decide() → `breaker_open`,     │        │
//    │                                     no network call                │ fails  │ succeeds
//    │                                           ▲                        │        │
//    │                                           └────────────────────────┘        │
//    └─────────────────────────────────────────────────────────────────────────────┘
//  * auth | timeout on a budget ≥ decisions.timeoutMs (R9) | unavailable | overloaded | rate_limited
//
// The 60 s cooldown copies `ChainedProvider`'s default `cooldownMs`
// (packages/core/src/providers/chained-provider.ts); the pattern is copied,
// not imported. It can only REMOVE Jev's influence (every site then takes
// today's path), never add authority. Per-request codes (`invalid`,
// `malformed`, `too_large`, `aborted`) neither count nor reset the count; a
// success resets it. Pinned by `__tests__/breaker.test.ts`.

import type { DecisionErrorCode } from '@ethosagent/types';

export interface DecisionBreakerEvent {
  type: 'decision.breaker_open' | 'decision.breaker_closed';
  code?: DecisionErrorCode;
}

const HEALTH_CODES: ReadonlySet<DecisionErrorCode> = new Set([
  'auth',
  'timeout',
  'unavailable',
  'overloaded',
  'rate_limited',
]);

export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_COOLDOWN_MS = 60_000;

export type BreakerAdmission = 'pass' | 'probe' | 'reject';

export class DecisionBreaker {
  private failures = 0;
  /** Non-null while open; once `now() >= openUntil` the next call is the half-open probe. */
  private openUntil: number | null = null;
  private probing = false;

  constructor(
    private readonly now: () => number,
    private readonly onEvent?: (event: DecisionBreakerEvent) => void,
  ) {}

  admit(): BreakerAdmission {
    if (this.openUntil === null) return 'pass';
    if (this.now() < this.openUntil || this.probing) return 'reject';
    this.probing = true;
    return 'probe';
  }

  /**
   * Record one call's outcome. `timeoutCounts` is false when the call ran on a
   * budget tighter than the provider's default (R9): that timeout says the
   * caller was impatient, not that the provider is down.
   */
  record(
    outcome: { ok: true } | { ok: false; code: DecisionErrorCode },
    probe: boolean,
    timeoutCounts: boolean,
  ): void {
    if (probe) this.probing = false;

    if (outcome.ok) {
      this.failures = 0;
      if (this.openUntil !== null) {
        this.openUntil = null;
        this.probing = false;
        this.emit({ type: 'decision.breaker_closed' });
      }
      return;
    }

    const counts = HEALTH_CODES.has(outcome.code) && (outcome.code !== 'timeout' || timeoutCounts);
    if (!counts) return;

    if (this.openUntil !== null) {
      // Only the probe's failure reopens; a call admitted before the breaker
      // opened and failing late neither extends the cooldown nor re-emits.
      if (probe) {
        this.openUntil = this.now() + BREAKER_COOLDOWN_MS;
        this.emit({ type: 'decision.breaker_open', code: outcome.code });
      }
      return;
    }

    this.failures += 1;
    if (this.failures >= BREAKER_FAILURE_THRESHOLD) {
      this.failures = 0;
      this.openUntil = this.now() + BREAKER_COOLDOWN_MS;
      this.emit({ type: 'decision.breaker_open', code: outcome.code });
    }
  }

  private emit(event: DecisionBreakerEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // An observer's failure must not turn a decision into a throw (errors are data, §4).
    }
  }
}
