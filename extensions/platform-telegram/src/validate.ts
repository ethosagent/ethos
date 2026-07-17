/** Liveness classification for a failed probe (W1.2 semantics):
 *  - `rejected`    — the credential was DEFINITIVELY refused (401/403 / bad token).
 *  - `unreachable` — the platform could not be reached (timeout/DNS/5xx);
 *                    the token is unverified, not necessarily invalid.
 *  - `unverified`  — a rate limit (429) blocked the probe. Distinct from
 *                    `unreachable` so a bad token seen during a 429 burst is
 *                    never silently persisted as a settled/clean verdict. */
export type ValidationReason = 'rejected' | 'unreachable' | 'unverified';

export interface ValidationResult {
  ok: boolean;
  label?: string;
  error?: string;
  /** Present when `ok === false` — distinguishes a bad token from an outage. */
  reason?: ValidationReason;
}

export async function validateTelegramToken(token: string): Promise<ValidationResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Invalid token', reason: 'rejected' };
    }
    if (res.status === 429) {
      return { ok: false, error: 'Telegram returned 429 (rate limited)', reason: 'unverified' };
    }
    if (res.status >= 500) {
      return { ok: false, error: `Telegram returned ${res.status}`, reason: 'unreachable' };
    }
    const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
    if (data.ok) {
      return { ok: true, label: `@${data.result?.username ?? ''}` };
    }
    return { ok: false, error: 'Invalid token', reason: 'rejected' };
  } catch {
    return { ok: false, error: 'Could not reach Telegram (timeout)', reason: 'unreachable' };
  }
}
