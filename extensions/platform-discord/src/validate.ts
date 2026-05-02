export interface ValidationResult {
  ok: boolean;
  label?: string;
  error?: string;
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
    if (res.status === 401) {
      return { ok: false, error: 'Invalid bot token' };
    }
    return { ok: false, error: 'Discord API error' };
  } catch {
    return { ok: false, error: 'Could not reach Discord (timeout)' };
  }
}
