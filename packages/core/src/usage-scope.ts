import { AsyncLocalStorage } from 'node:async_hooks';
import type { UsageAttribution } from '@ethosagent/types';

/**
 * The usage scope (plan/phases/background-usage-accounting.md §5.2): who a
 * metered model call made inside some piece of work is billed to, and — for a
 * user's turn — where its cost is charged. Same shape as the run taint
 * (`./scoped/run-taint.ts`), for the same reason: a `ToolContext` field would
 * not reach a provider a tool or a hook built itself, and `CompletionOptions`
 * is frozen (D15), so the attribution travels in the async context instead.
 *
 * `MeteredProvider` (`./providers/metered-provider.ts`) reads it. Its static
 * attribution wins field by field; the scope fills the gaps.
 *
 * The opener's scope closes when its work settles. Async work that outlives it
 * (an executor loop, a timer) still lends the scope's ATTRIBUTION — the money
 * was spent on that work's behalf — but `charge` is no longer called: a turn
 * that has ended cannot be billed again. Pinned by "work that outlives the
 * scope" in `__tests__/usage-scope.test.ts`.
 *
 * A nested scope replaces the outer one wholesale, never merges with it, so a
 * per-job scope (D10) never borrows another job's fields. Open scopes only
 * around promise-returning work, never across a generator `yield`.
 */
export interface UsageScopeLink {
  readonly attribution: UsageAttribution;
  /** False once the work that opened this scope has settled. */
  open: boolean;
  /** Charge a `turn_utility` call's cost to the opener (session budget + a `usage` event). */
  readonly charge?: (usd: number) => void;
}

const scope = new AsyncLocalStorage<UsageScopeLink>();

/** Run `fn` with `attribution` (and `charge`, while open) as its usage scope. */
export async function withUsageScope<T>(
  opts: { attribution: UsageAttribution; charge?: (usd: number) => void },
  fn: () => Promise<T>,
): Promise<T> {
  const link: UsageScopeLink = {
    attribution: opts.attribution,
    open: true,
    ...(opts.charge ? { charge: opts.charge } : {}),
  };
  try {
    return await scope.run(link, fn);
  } finally {
    link.open = false;
  }
}

/** The usage scope this code runs inside, open or closed, if any. */
export function activeUsageScope(): UsageScopeLink | undefined {
  return scope.getStore();
}
