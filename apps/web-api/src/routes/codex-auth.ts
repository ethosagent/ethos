import { randomBytes } from 'node:crypto';
import {
  CodexTokenStore,
  exchangeForTokens,
  pollForAuthorization,
  requestDeviceCode,
} from '@ethosagent/llm-codex';
import type { SecretsResolver } from '@ethosagent/types';
import { Hono } from 'hono';

interface PendingAuth {
  userCode: string;
  authorized: boolean;
  error?: string;
}

// In-memory store keyed by sessionToken. Tokens expire after 20 minutes.
const pending = new Map<string, PendingAuth>();

export function codexAuthRoutes(opts: { secrets: SecretsResolver }) {
  const app = new Hono();
  const store = new CodexTokenStore(opts.secrets);

  // POST /device-code → request a device code, start background polling
  app.post('/device-code', async (c) => {
    try {
      const { deviceAuthId, userCode } = await requestDeviceCode(fetch);
      const sessionToken = randomBytes(16).toString('hex');
      const entry: PendingAuth = { userCode, authorized: false };
      pending.set(sessionToken, entry);

      // Start background polling — resolves when user authorizes or times out
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 16 * 60 * 1000); // 16 min cleanup
      pollForAuthorization(fetch, deviceAuthId, userCode, controller.signal)
        .then(({ authorizationCode, codeVerifier }) =>
          exchangeForTokens(fetch, authorizationCode, codeVerifier),
        )
        .then((credentials) => store.save(credentials))
        .then(() => {
          const e = pending.get(sessionToken);
          if (e) e.authorized = true;
        })
        .catch((err: unknown) => {
          const e = pending.get(sessionToken);
          if (e) e.error = err instanceof Error ? err.message : String(err);
        })
        .finally(() => {
          // Clean up after 1 minute of authorized state
          setTimeout(() => pending.delete(sessionToken), 60_000);
        });

      return c.json({ ok: true, userCode, sessionToken });
    } catch (err) {
      return c.json(
        { ok: false, error: err instanceof Error ? err.message : 'Device code request failed' },
        500,
      );
    }
  });

  // GET /status?session=<token>
  app.get('/status', (c) => {
    const sessionToken = c.req.query('session');
    if (!sessionToken) return c.json({ ok: false, error: 'Missing session' }, 400);
    const entry = pending.get(sessionToken);
    if (!entry) return c.json({ ok: false, error: 'Session not found or expired' }, 404);
    if (entry.error) return c.json({ ok: false, authorized: false, error: entry.error });
    return c.json({ ok: true, authorized: entry.authorized });
  });

  return app;
}
