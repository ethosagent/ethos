import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { AUTH_COOKIE } from '../middleware/auth';
export function authRoutes(opts) {
  const app = new Hono();
  const maxAge = opts.cookieMaxAgeSeconds ?? 60 * 60 * 24 * 30;
  app.get('/exchange', async (c) => {
    const token = c.req.query('t');
    if (!token) {
      return c.json(
        {
          ok: false,
          code: 'UNAUTHORIZED',
          error: 'Missing token query',
          action: 'Use the URL printed by `ethos serve`.',
        },
        401,
      );
    }
    const valid = await opts.tokens.matches(token);
    if (!valid) {
      return c.json(
        {
          ok: false,
          code: 'UNAUTHORIZED',
          error: 'Invalid or rotated token',
          action: 'Re-run `ethos serve` to print a fresh URL.',
        },
        401,
      );
    }
    // Rotate so the URL can't be replayed (e.g. from browser history,
    // referrer headers, screen-recording, shoulder-surfing).
    const fresh = await opts.tokens.rotate();
    setCookie(c, AUTH_COOKIE, fresh, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: opts.secureCookie ?? false,
      path: '/',
      maxAge,
    });
    // 302 to a clean URL so the token doesn't land in browser history.
    return c.redirect('/', 302);
  });
  return app;
}
