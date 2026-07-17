/** Liveness classification for a failed probe (W1.2 semantics):
 *  - `rejected`    — the credential was DEFINITIVELY refused (401/403 / bad token).
 *  - `unreachable` — Discord could not be reached (timeout/DNS/5xx); the
 *                    token is unverified, not necessarily invalid.
 *  - `unverified`  — a rate limit (429) blocked the probe, so a bad token is
 *                    never silently persisted as a settled/clean verdict. */
export type ValidationReason = 'rejected' | 'unreachable' | 'unverified';

export interface ValidationResult {
  ok: boolean;
  label?: string;
  error?: string;
  /** Present when `ok === false` — distinguishes a bad token from an outage. */
  reason?: ValidationReason;
}

export async function validateDiscordToken(token: string): Promise<ValidationResult> {
  try {
    const res = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 200) {
      const data = (await res.json()) as { username?: string };
      return { ok: true, label: data.username };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Invalid bot token', reason: 'rejected' };
    }
    if (res.status === 429) {
      return { ok: false, error: 'Discord returned 429 (rate limited)', reason: 'unverified' };
    }
    return { ok: false, error: `Discord returned ${res.status}`, reason: 'unreachable' };
  } catch {
    return { ok: false, error: 'Could not reach Discord (timeout)', reason: 'unreachable' };
  }
}
