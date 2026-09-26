/**
 * A time-limited approval grant (reach-and-containment 3b).
 *
 * One lease answers "yes" to every call of ONE tool, with any args, inside ONE
 * session, for ONE personality, until `expiresAt` — or until someone revokes
 * it. It is the widest answer an always-ask tool can get: those tools cannot be
 * permanently allowlisted (`ApprovalsService.approve` refuses, and
 * `AllowlistRepository.matches` skips them, in `apps/web-api`).
 *
 * Binding (D3-7): a lease with `personalityId` set matches only that id; a
 * lease with `personalityId: null` matches only a call that carries none. So a
 * `/personality` switch inside the session never inherits a lease, and a lease
 * never leaks to another session.
 *
 * The shape is deliberately generic — nothing here is web-specific — so the
 * other grant shapes in the codebase (the Pi run-scope, plugin `revokedAt`) can
 * move onto it later. Today its only store is `LeaseRepository` in
 * `apps/web-api/src/repositories/lease.repository.ts`.
 */
export interface ApprovalLease {
  /** uuid */
  id: string;
  toolName: string;
  sessionId: string;
  personalityId: string | null;
  /** Who granted it — the deciding client id on the web surface. */
  grantedBy: string;
  /** ISO-8601 */
  grantedAt: string;
  /** ISO-8601. Required: a lease always ends. */
  expiresAt: string;
  /** ISO-8601, or null while the lease stands. */
  revokedAt: string | null;
}

/**
 * True iff the lease is unrevoked and `expiresAt` is strictly after `nowMs`.
 * An unparseable `expiresAt` is inactive — a lease whose end cannot be read is
 * treated as already ended, never as open-ended. This is the call-time
 * enforcer (D3-10): `LeaseRepository.findActive` evaluates it on every gated
 * call, so expiry and revocation take effect on the next call with no timer.
 */
export function isLeaseActive(lease: ApprovalLease, nowMs: number): boolean {
  if (lease.revokedAt !== null) return false;
  const end = Date.parse(lease.expiresAt);
  return Number.isFinite(end) && end > nowMs;
}
