import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  lockedUntil: number;
}

export function rateLimitMiddleware(opts?: {
  maxTokens?: number;
  refillMs?: number;
  lockoutMs?: number;
  /** Honor `X-Forwarded-For` / `X-Real-IP` for the bucket key. Only enable when
   *  the server sits behind a trusted reverse proxy that sets these headers —
   *  otherwise a client spoofs the header to mint a fresh bucket per request.
   *  Default false (WEB-006). */
  trustProxy?: boolean;
}): MiddlewareHandler {
  const maxTokens = opts?.maxTokens ?? 5;
  const refillMs = opts?.refillMs ?? 60_000; // 1 minute
  const lockoutMs = opts?.lockoutMs ?? 600_000; // 10 minutes
  const trustProxy = opts?.trustProxy ?? false;
  const buckets = new Map<string, TokenBucket>();

  return async (c, next) => {
    const ip = clientKey(c, trustProxy);

    const now = Date.now();
    let bucket = buckets.get(ip);

    if (!bucket) {
      bucket = { tokens: maxTokens, lastRefill: now, lockedUntil: 0 };
      buckets.set(ip, bucket);
    }

    // Check lockout
    if (now < bucket.lockedUntil) {
      const retryAfter = Math.ceil((bucket.lockedUntil - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json(
        {
          ok: false,
          code: 'rate_limited',
          detail: `Too many requests. Retry after ${retryAfter}s.`,
        },
        429,
      );
    }

    // Refill tokens
    const elapsed = now - bucket.lastRefill;
    if (elapsed >= refillMs) {
      const refills = Math.floor(elapsed / refillMs);
      bucket.tokens = Math.min(maxTokens, bucket.tokens + refills);
      bucket.lastRefill = now;
    }

    // Consume token
    if (bucket.tokens <= 0) {
      bucket.lockedUntil = now + lockoutMs;
      const retryAfter = Math.ceil(lockoutMs / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json(
        {
          ok: false,
          code: 'rate_limited',
          detail: `Rate limit exceeded. Locked out for ${retryAfter}s.`,
        },
        429,
      );
    }

    bucket.tokens -= 1;
    return next();
  };
}

// Derive the rate-limit bucket key. When `trustProxy` is off (default), we
// IGNORE `X-Forwarded-For` / `X-Real-IP` — both are client-spoofable and would
// otherwise let an attacker rotate the header to get a fresh bucket per request
// (WEB-006). We key on the socket peer address instead, so each real client
// gets its own bucket and no shared `unknown` catch-all couples distinct
// callers. `unknown` is only reached when there is no socket (e.g. `app.request`
// in tests).
function clientKey(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
    const realIp = c.req.header('x-real-ip');
    if (realIp) return realIp;
  }
  try {
    const address = getConnInfo(c).remote.address;
    if (address) return address;
  } catch {
    // No Node socket in context (tests / non-node adapters) — fall through.
  }
  return 'unknown';
}
