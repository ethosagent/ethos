import { InMemoryStorage } from '@ethosagent/storage-fs';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { WebAdminRepository } from '../../repositories/web-admin.repository';
import { WebSessionStore } from '../../repositories/web-session.store';
import { WebTokenRepository } from '../../repositories/web-token.repository';
import { authRoutes } from '../../routes/auth';

// web-auth-bootstrap Phase 1 — the /auth bootstrap endpoints (D1, D5–D8,
// D16). These are the enforcers of record for the D14 route guarantees:
// claim happy/failure paths, uniform login failure shape, token-login pre/
// post-claim, reset session invalidation, exchange pre/post-claim, and the
// unauthenticated /auth/state probe.

const DIR = '/data';
const HOST = 'localhost:3000';
const SAME_ORIGIN = { origin: `http://${HOST}`, host: HOST };
const PASSWORD = 'correct-horse-battery';

describe('auth bootstrap routes', () => {
  let app: Hono;
  let tokens: WebTokenRepository;
  let admin: WebAdminRepository;
  let sessions: WebSessionStore;
  let token: string;

  beforeEach(async () => {
    const storage = new InMemoryStorage();
    tokens = new WebTokenRepository({ dataDir: DIR, storage });
    admin = new WebAdminRepository({ dataDir: DIR, storage });
    sessions = new WebSessionStore({ dataDir: DIR, storage });
    token = await tokens.getOrCreate();
    app = new Hono();
    app.route('/auth', authRoutes({ tokens, admin, sessions }));
  });

  function post(path: string, body: unknown, headers: Record<string, string> = SAME_ORIGIN) {
    return app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  function cookieValue(res: Response): string | null {
    const raw = res.headers.get('set-cookie');
    if (!raw) return null;
    const m = raw.match(/ethos_auth=([^;]*)/);
    return m?.[1] ?? null;
  }

  describe('GET /auth/state (D8, unauthenticated)', () => {
    it('reports claimed=false pre-claim and claimed=true after, with no secrets', async () => {
      const before = await app.request('/auth/state');
      expect(before.status).toBe(200);
      expect(await before.json()).toEqual({ claimed: false, tokenFromEnv: false });

      await admin.claim({ username: 'admin', password: PASSWORD });
      const after = await app.request('/auth/state');
      expect(await after.json()).toEqual({ claimed: true, tokenFromEnv: false });
    });
  });

  describe('POST /auth/setup (D1)', () => {
    it('claims with token + username + password and signs in with a session cookie', async () => {
      const res = await post('/auth/setup', { token, username: 'admin', password: PASSWORD });
      expect(res.status).toBe(204);
      const cookie = cookieValue(res);
      expect(cookie).toMatch(/^[0-9a-f]{64}$/);
      // The cookie is a SESSION id, not the token.
      expect(cookie).not.toBe(token);
      expect(await sessions.has(cookie as string)).toBe(true);
      expect(await admin.isClaimed()).toBe(true);
      const raw = res.headers.get('set-cookie') ?? '';
      expect(raw).toMatch(/HttpOnly/i);
      expect(raw).toMatch(/SameSite=Strict/i);
    });

    it('rejects a wrong bootstrap token with 401 and claims nothing', async () => {
      const res = await post('/auth/setup', {
        token: 'wrong-token',
        username: 'admin',
        password: PASSWORD,
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(await admin.isClaimed()).toBe(false);
    });

    it('rejects a password under 12 chars with a named 400', async () => {
      const res = await post('/auth/setup', { token, username: 'admin', password: 'short-pw' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('PASSWORD_TOO_SHORT');
      expect(await admin.isClaimed()).toBe(false);
    });

    it('refuses a second claim with 409 even with a valid token', async () => {
      await admin.claim({ username: 'admin', password: PASSWORD });
      const res = await post('/auth/setup', { token, username: 'evil', password: PASSWORD });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('ALREADY_CLAIMED');
    });
  });

  describe('POST /auth/login (D5)', () => {
    it('409s pre-claim, pointing at setup', async () => {
      const res = await post('/auth/login', { username: 'admin', password: PASSWORD });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('NOT_CLAIMED');
    });

    it('signs in with a fresh session cookie on correct credentials', async () => {
      await admin.claim({ username: 'admin', password: PASSWORD });
      const res = await post('/auth/login', { username: 'admin', password: PASSWORD });
      expect(res.status).toBe(204);
      const cookie = cookieValue(res);
      expect(await sessions.has(cookie as string)).toBe(true);
    });

    it('fails uniformly — wrong-user and wrong-password get the SAME status and body (D14)', async () => {
      await admin.claim({ username: 'admin', password: PASSWORD });
      const wrongUser = await post('/auth/login', { username: 'nobody', password: PASSWORD });
      const wrongPassword = await post('/auth/login', {
        username: 'admin',
        password: 'not-the-password',
      });
      expect(wrongUser.status).toBe(401);
      expect(wrongPassword.status).toBe(401);
      expect(await wrongUser.json()).toEqual(await wrongPassword.json());
      expect(wrongUser.headers.get('set-cookie')).toBeNull();
      expect(wrongPassword.headers.get('set-cookie')).toBeNull();
    });
  });

  describe('POST /auth/token-login (D16)', () => {
    it('pre-claim: a valid token grants the raw-token cookie (same as exchange, no rotation)', async () => {
      const res = await post('/auth/token-login', { token });
      expect(res.status).toBe(204);
      expect(cookieValue(res)).toBe(token);
      // Not rotated — the token still matches afterwards.
      expect(await tokens.matches(token)).toBe(true);
    });

    it('pre-claim: a wrong token is 401', async () => {
      const res = await post('/auth/token-login', { token: 'wrong-token' });
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('post-claim: 410 with a named error, even with the valid token', async () => {
      await admin.claim({ username: 'admin', password: PASSWORD });
      const res = await post('/auth/token-login', { token });
      expect(res.status).toBe(410);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('TOKEN_LOGIN_RETIRED');
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });

  describe('POST /auth/reset (D6)', () => {
    it('re-claims, invalidates every session, and signs the resetter in fresh', async () => {
      await admin.claim({ username: 'admin', password: PASSWORD });
      const oldSession = await sessions.create();

      const res = await post('/auth/reset', {
        token,
        username: 'admin2',
        password: 'fresh-password-123',
      });
      expect(res.status).toBe(204);
      // Every previous session is gone (D14: session invalidation on reset)…
      expect(await sessions.has(oldSession)).toBe(false);
      // …and the response cookie is a NEW live session.
      const fresh = cookieValue(res);
      expect(await sessions.has(fresh as string)).toBe(true);
      expect(await admin.verify({ username: 'admin2', password: 'fresh-password-123' })).toBe(true);
      // The bootstrap token is NOT rotated (machine clients keep working).
      expect(await tokens.matches(token)).toBe(true);
    });

    it('rejects a wrong token with 401 and touches nothing', async () => {
      await admin.claim({ username: 'admin', password: PASSWORD });
      const session = await sessions.create();
      const res = await post('/auth/reset', {
        token: 'wrong-token',
        username: 'x',
        password: 'fresh-password-123',
      });
      expect(res.status).toBe(401);
      expect(await sessions.has(session)).toBe(true);
      expect(await admin.verify({ username: 'admin', password: PASSWORD })).toBe(true);
    });
  });

  describe('GET /auth/exchange (D7 amended per D16)', () => {
    it('pre-claim: grants the raw-token cookie and 302s to / (no rotation)', async () => {
      const res = await app.request(`/auth/exchange?t=${token}`, { headers: SAME_ORIGIN });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
      expect(cookieValue(res)).toBe(token);
      expect(await tokens.matches(token)).toBe(true);
    });

    it('post-claim: NO cookie, 302 to /welcome/reset with the token URL-encoded as prefill', async () => {
      await admin.claim({ username: 'admin', password: PASSWORD });
      const res = await app.request('/auth/exchange?t=abc%2F%2Bdef', { headers: SAME_ORIGIN });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        `/welcome/reset?t=${encodeURIComponent('abc/+def')}`,
      );
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });

  describe('Origin check + rate limit on the auth POSTs', () => {
    it('rejects a cross-origin POST with 401', async () => {
      const res = await post(
        '/auth/login',
        { username: 'admin', password: PASSWORD },
        { origin: 'http://evil.example.com', host: HOST },
      );
      expect(res.status).toBe(401);
    });

    it('allows an operator-allowlisted cross-origin POST', async () => {
      const allowApp = new Hono();
      allowApp.route(
        '/auth',
        authRoutes({ tokens, admin, sessions, allowedOrigins: ['http://companion.example.com'] }),
      );
      const res = await allowApp.request('/auth/token-login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://companion.example.com',
          host: HOST,
        },
        body: JSON.stringify({ token }),
      });
      expect(res.status).toBe(204);
    });

    it('allows a POST with no Origin header (non-browser clients)', async () => {
      const res = await post('/auth/token-login', { token }, {});
      expect(res.status).toBe(204);
    });

    it('rate-limits after 5 attempts with 429 (same bucket params as /auth/codex)', async () => {
      for (let i = 0; i < 5; i += 1) {
        const res = await post('/auth/token-login', { token: `wrong-${i}` });
        expect(res.status).toBe(401);
      }
      const sixth = await post('/auth/token-login', { token });
      expect(sixth.status).toBe(429);
    });
  });
});
