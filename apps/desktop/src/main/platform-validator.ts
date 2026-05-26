interface TestResult {
  ok: boolean;
  username?: string;
  error?: string;
}

export async function testTelegram(token: string): Promise<TestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${text}` };
    }
    const data = (await res.json()) as { result: { username: string } };
    return { ok: true, username: data.result.username };
  } catch (err) {
    return {
      ok: false,
      error: controller.signal.aborted ? 'Timeout after 10s' : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function testDiscord(token: string): Promise<TestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${text}` };
    }
    const user = (await res.json()) as { username: string; discriminator: string };
    return { ok: true, username: `${user.username}#${user.discriminator}` };
  } catch (err) {
    return {
      ok: false,
      error: controller.signal.aborted ? 'Timeout after 10s' : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// TODO: wire imapflow once dependency is installed
export async function testImap(config: {
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
}): Promise<TestResult> {
  if (!config.host || !config.user || !config.port) {
    return { ok: false, error: 'host, port, and user are required' };
  }
  return { ok: false, error: 'IMAP testing not yet available — install imapflow to enable' };
}

// TODO: wire nodemailer/smtp once dependency is installed
export async function testSmtp(config: {
  host: string;
  port: number;
  user: string;
  password: string;
  starttls: boolean;
}): Promise<TestResult> {
  if (!config.host || !config.user || !config.port) {
    return { ok: false, error: 'host, port, and user are required' };
  }
  return { ok: false, error: 'SMTP testing not yet available — install nodemailer to enable' };
}
