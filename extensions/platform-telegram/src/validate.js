export async function validateTelegramToken(token) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json();
    if (data.ok) {
      return { ok: true, label: `@${data.result?.username ?? ''}` };
    }
    return { ok: false, error: 'Invalid token' };
  } catch {
    return { ok: false, error: 'Could not reach Telegram (timeout)' };
  }
}
