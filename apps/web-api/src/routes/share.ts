import { randomBytes } from 'node:crypto';
import { ShareSnapshotWireSchema } from '@ethosagent/web-contracts';
import { hashShareToken, type SqliteShareLinkStore } from '@ethosagent/wiring';
import { type Context, Hono } from 'hono';
import { NOT_FOUND_PAGE, renderSharePage } from '../features/share/render';
import type { ShareSettingsReader } from '../features/share/settings';
import { rateLimitMiddleware } from '../middleware/rate-limit';
import type { RouteModule } from './route-module';

// GET /share/<token> — the public, unauthenticated, read-only page for a share link
// (plan share-links §3 Public page, §4, D1, D3, D14). Guarantees, each pinned by
// __tests__/routes/share-route.test.ts:
// - every miss (bad token shape, unknown, revoked, expired, feature off, any other path or
//   method under /share) returns the one 404 of `NOT_FOUND_PAGE`, byte for byte ('uniform 404');
// - the switch is read from config.yaml on every request, not cached ('live switch');
// - the response carries the exact CSP, x-robots-tag, referrer-policy, no-store and nosniff
//   headers, and the style nonce matches the CSP nonce, fresh per response ('headers');
// - no cookie is read or set: nothing here touches `verifyCookie`, and the page is
//   sandboxed to an opaque origin ('no cookie');
// - 30 requests per client, one more per 2 s, then a 10 minute lockout ('rate limit');
// - a 200 counts one view ('view count').
// LIMITATION: the limiter's bucket is in-memory and per process; a restart resets it.
//
// Deliberately NOT `RouteModule.enabledCheck`: that gate answers `{"error":"DISABLED"}`
// (routes/index.ts), which differs from the 404 a missing link gets and would tell a
// guesser the feature is off. The switch is checked inside the handler instead.

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const BASE_HEADERS = {
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

const csp = (styleSource: string): string =>
  `default-src 'none'; style-src ${styleSource}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox`;

export interface ShareRouteDeps {
  store: Pick<SqliteShareLinkStore, 'findLive' | 'recordView'>;
  settings: ShareSettingsReader;
  /** `ETHOS_TRUST_PROXY`: bucket by X-Forwarded-For (same switch as every limiter). */
  trustProxy?: boolean;
  now?: () => Date;
}

export function shareRouteModule(deps: ShareRouteDeps): RouteModule {
  const now = deps.now ?? (() => new Date());
  const router = new Hono();

  // The limiter answers 429 itself and never reaches the handler, so the share headers are
  // added on the way out (pinned by share-route.test.ts '429 carries the same share headers').
  router.use('*', async (c, next) => {
    await next();
    if (c.res.status === 429) {
      for (const [k, v] of Object.entries(BASE_HEADERS)) c.res.headers.set(k, v);
    }
  });

  router.use(
    '*',
    rateLimitMiddleware({
      maxTokens: 30,
      refillMs: 2_000,
      lockoutMs: 600_000,
      trustProxy: deps.trustProxy ?? false,
    }),
  );

  const notFound = (c: Context) =>
    c.html(NOT_FOUND_PAGE.html, 404, {
      ...BASE_HEADERS,
      'content-security-policy': csp(NOT_FOUND_PAGE.styleHash),
    });

  router.get('/:token', async (c) => {
    const token = c.req.param('token');
    if (!TOKEN_SHAPE.test(token)) return notFound(c);
    if (!(await deps.settings()).enabled) return notFound(c);
    const at = now();
    let record: ReturnType<typeof deps.store.findLive>;
    try {
      record = deps.store.findLive(hashShareToken(token), at);
    } catch {
      // A store fault must look like any other miss, never a distinguishable 500 (uniform 404).
      return notFound(c);
    }
    if (!record?.snapshot) return notFound(c);
    let parsed: ReturnType<typeof ShareSnapshotWireSchema.safeParse>;
    try {
      parsed = ShareSnapshotWireSchema.safeParse(JSON.parse(record.snapshot));
    } catch {
      return notFound(c);
    }
    if (!parsed.success) return notFound(c);
    // HEAD fetches no body, so it is not a view (pinned: 'HEAD serves the page headers…').
    // LIMITATION: link unfurlers (Slack, Teams) GET the page, so they count as views and show
    // the redacted title in previews; see docs/content/security/controls/share-links.md.
    if (c.req.method !== 'HEAD') {
      try {
        deps.store.recordView(record.id, at);
      } catch {
        // The count is a display hint on the Settings list; a failed bump must not hide the page.
      }
    }
    const nonce = randomBytes(16).toString('base64');
    return c.html(renderSharePage(parsed.data, { nonce, expiresAt: record.expiresAt }), 200, {
      ...BASE_HEADERS,
      'content-security-policy': csp(`'nonce-${nonce}'`),
    });
  });

  router.all('*', (c) => notFound(c));

  return {
    basePath: '/share',
    router,
    auth: 'public',
    description:
      'Read-only, redacted, expiring conversation snapshot at an unguessable URL. No sign-in: ' +
      'the 256-bit token in the path is the credential, only its hash is stored, and every ' +
      'miss is one identical 404. Rate limited; switched by config shareLinks.enabled.',
  };
}
