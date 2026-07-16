/** Liveness classification for a failed probe (W1.2 semantics):
 *  - `rejected`    — the credential was DEFINITIVELY refused (bad/revoked token).
 *  - `unreachable` — Slack could not be reached (timeout/5xx/rate_limited); the
 *                    token is unverified, not necessarily invalid. */
export type ValidationReason = 'rejected' | 'unreachable';

export interface ValidationResult {
  ok: boolean;
  label?: string;
  error?: string;
  /** Present when `ok === false` — distinguishes a bad token from an outage. */
  reason?: ValidationReason;
}

/** Slack `auth.test` error codes that mean the token itself is bad, not a
 *  transient outage. */
const REJECTED_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'no_permission',
]);

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
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, error: `Slack returned ${res.status}`, reason: 'unreachable' };
    }
    const data = (await res.json()) as { ok: boolean; team?: string; error?: string };
    if (data.ok) {
      return { ok: true, label: data.team };
    }
    const err = data.error ?? 'Invalid token';
    const reason: ValidationReason = REJECTED_ERRORS.has(err) ? 'rejected' : 'unreachable';
    return { ok: false, error: err, reason };
  } catch {
    return { ok: false, error: 'Could not reach Slack (timeout)', reason: 'unreachable' };
  }
}
