// The tier router seam (plan/phases/decision-provider-jev.md §8.3, D15, R1).
//
// A wiring-built function that may DOWNGRADE a turn to the `trivial` role
// before it resolves its model. Core owns the call condition and the
// downgrade-only rule; wiring owns what is asked and how the answer is gated
// (`createDecisionTierRouter`, packages/wiring/src/decision-router.ts). Core
// never imports that file: the router is injected at construction
// (`AgentLoopConfig.tierRouter`), like `ToolLoadingResolver`.
//
//   turn setup ─► user override? ── yes ──► use it (router not called)
//                     │ no
//                     ▼
//       trivial and default resolve ok to DIFFERENT models? ── no ──► 'default' (no call, R1)
//                     │ yes
//                     ▼
//       router(message, signal) ─► 'trivial' → 'trivial'; anything else → 'default'
//
// Pinned by `__tests__/tier-router.test.ts`.

/**
 * `'trivial'` routes this turn down; `null` leaves it on `default`. The type
 * names no other role, and `routeTurnTier` below ignores anything that is not
 * exactly `'trivial'`, so a router can never select `deep` or `dreaming` (D15).
 */
export type TierRouter = (input: {
  /** The user's message for this turn, as `AgentLoop.run` received it. */
  message: string;
  /** The turn's abort signal; a router must stop when it fires. */
  signal?: AbortSignal;
  /** The turn's observability trace, so what the router records joins the turn. */
  traceId?: string;
}) => Promise<'trivial' | null>;

/** What a role resolves to for the R1 comparison: the provider entry and the model id. */
export interface ResolvedRoleModel {
  provider: string;
  model: string;
}

/**
 * Whether this turn is routed to `trivial`. Returns `undefined` — no routing,
 * today's path — unless ALL of these hold:
 * - a router is configured and the message has text;
 * - `resolve('trivial')` and `resolve('default')` both succeed (a failure on
 *   either side is `null`) and name a different provider entry or model id
 *   (R1): when a rung 0–3 alias wins or `trivial` is unbound, both resolve to
 *   the same model and no router answer could change it, so no call is made;
 * - the router answers exactly `'trivial'`. A rejection, `null` or any other
 *   value is no routing.
 *
 * The caller decides the user-override case BEFORE calling this: a `/tier`
 * override always wins and the router is not consulted.
 */
export async function routeTurnTier(input: {
  router: TierRouter | undefined;
  message: string;
  signal?: AbortSignal;
  traceId?: string;
  resolve: (role: 'trivial' | 'default') => ResolvedRoleModel | null;
}): Promise<'trivial' | undefined> {
  const { router } = input;
  if (!router || input.message.trim() === '') return undefined;
  const trivial = input.resolve('trivial');
  const fallback = input.resolve('default');
  if (!trivial || !fallback) return undefined;
  if (trivial.provider === fallback.provider && trivial.model === fallback.model) return undefined;
  try {
    const answer: unknown = await router({
      message: input.message,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
    });
    return answer === 'trivial' ? 'trivial' : undefined;
  } catch {
    return undefined;
  }
}
