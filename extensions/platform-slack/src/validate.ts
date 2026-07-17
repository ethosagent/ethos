/** Liveness classification for a failed probe (W1.2 semantics):
 *  - `rejected`    — the credential was DEFINITIVELY refused (bad/revoked token).
 *  - `unreachable` — Slack could not be reached (timeout/5xx); the token is
 *                    unverified, not necessarily invalid.
 *  - `unverified`  — a rate limit (429 / `ratelimited`) blocked the probe, so a
 *                    bad token is never silently persisted as a clean verdict. */
export type ValidationReason = 'rejected' | 'unreachable' | 'unverified';

export interface ValidationResult {
  ok: boolean;
  label?: string;
  error?: string;
  /** Present when `ok === false` — distinguishes a bad token from an outage. */
  reason?: ValidationReason;
}

// INVERTED allowlist (W1.2): any `auth.test` failure is a REJECTED token
// unless its error code is a KNOWN transient/outage code. The old
// rejected-allowlist silently downgraded real bad-credential codes it didn't
// enumerate (missing_scope, not_allowed_token_type, ekm_access_denied, …) to
// `unreachable`, persisting a bad token with only a warning. Fail closed
// instead: an unrecognised error means the token is bad.
/** Error codes that mean Slack itself is temporarily unavailable, not the token. */
const TRANSIENT_ERRORS = new Set(['service_unavailable', 'internal_error', 'fatal_error']);
/** Rate-limit error codes — a bad token here can't be settled, so `unverified`. */
const RATE_LIMIT_ERRORS = new Set(['ratelimited', 'rate_limited']);

export async function validateSlackToken(token: string): Promise<ValidationResult> {
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 429) {
      return { ok: false, error: 'Slack returned 429 (rate limited)', reason: 'unverified' };
    }
    if (res.status >= 500) {
      return { ok: false, error: `Slack returned ${res.status}`, reason: 'unreachable' };
    }
    const data = (await res.json()) as { ok: boolean; team?: string; error?: string };
    if (data.ok) {
      return { ok: true, label: data.team };
    }
    const err = data.error ?? 'invalid_auth';
    const reason: ValidationReason = RATE_LIMIT_ERRORS.has(err)
      ? 'unverified'
      : TRANSIENT_ERRORS.has(err)
        ? 'unreachable'
        : 'rejected';
    return { ok: false, error: err, reason };
  } catch {
    return { ok: false, error: 'Could not reach Slack (timeout)', reason: 'unreachable' };
  }
}
