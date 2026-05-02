export interface ValidationResult {
  ok: boolean;
  label?: string;
  error?: string;
}

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
    const data = (await res.json()) as { ok: boolean; team?: string; error?: string };
    if (data.ok) {
      return { ok: true, label: data.team };
    }
    return { ok: false, error: data.error ?? 'Invalid token' };
  } catch {
    return { ok: false, error: 'Could not reach Slack (timeout)' };
  }
}
