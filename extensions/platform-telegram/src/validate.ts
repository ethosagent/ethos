export interface ValidationResult {
  ok: boolean;
  label?: string;
  error?: string;
}

export async function validateTelegramToken(token: string): Promise<ValidationResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
    if (data.ok) {
      return { ok: true, label: `@${data.result?.username ?? ''}` };
    }
    return { ok: false, error: 'Invalid token' };
  } catch {
    return { ok: false, error: 'Could not reach Telegram (timeout)' };
  }
}
