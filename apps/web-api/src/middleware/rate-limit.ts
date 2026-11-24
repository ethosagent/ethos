import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  lockedUntil: number;
}

const PRUNE_EVERY = 256;

export type TokenTake =
  | { ok: true }
  | {
      ok: false;
      retryAfterS: number;
      /** True when THIS take started the lockout. */
      newLockout: boolean;
    };

/**
 * The token-bucket arithmetic, pure (no clock, no Hono): one bucket per key, refilled by whole
 * `refillMs` periods, a lockout of `lockoutMs` once empty. `rateLimitMiddleware` and the node
 * pairing lane (node/node-pairing.ts) share it. Pinned by __tests__/middleware/rate-limit.test.ts.
 */
export function createTokenBuckets(opts: {
  maxTokens: number;
  refillMs: number;
  lockoutMs: number;
  /** Most keys kept; idle ones are dropped first. Default 10_000. */
  maxKeys?: number;
}): {
  take(key: string, now: number): TokenTake;
  /** Keys currently tracked (tests and diagnostics). */
  size(): number;
} {
  const { maxTokens, refillMs, lockoutMs } = opts;
  const maxKeys = opts.maxKeys ?? 10_000;
  const buckets = new Map<string, TokenBucket>();
  let takes = 0;
  // A bucket that is unlocked and would be full again is indistinguishable from a new one, so
  // dropping it changes nothing (pinned by rate-limit.test.ts "prunes idle buckets").
  const prune = (now: number, force: boolean): void => {
    for (const [k, b] of buckets) {
      const idle =
        now >= b.lockedUntil && b.tokens + Math.floor((now - b.lastRefill) / refillMs) >= maxTokens;
      if (idle || (force && now >= b.lockedUntil && buckets.size > maxKeys)) buckets.delete(k);
    }
  };
  return {
    size: () => buckets.size,
    take(key, now) {
      takes += 1;
      if (takes % PRUNE_EVERY === 0 || buckets.size > maxKeys) prune(now, true);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { tokens: maxTokens, lastRefill: now, lockedUntil: 0 };
        buckets.set(key, bucket);
      }
      if (now < bucket.lockedUntil) {
        return {
          ok: false,
          retryAfterS: Math.ceil((bucket.lockedUntil - now) / 1000),
          newLockout: false,
        };
      }
      const elapsed = now - bucket.lastRefill;
      if (elapsed >= refillMs) {
        const refills = Math.floor(elapsed / refillMs);
        bucket.tokens = Math.min(maxTokens, bucket.tokens + refills);
        bucket.lastRefill = now;
      }
      if (bucket.tokens <= 0) {
        bucket.lockedUntil = now + lockoutMs;
        return { ok: false, retryAfterS: Math.ceil(lockoutMs / 1000), newLockout: true };
      }
      bucket.tokens -= 1;
      return { ok: true };
    },
  };
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
  const buckets = createTokenBuckets({ maxTokens, refillMs, lockoutMs });

  return async (c, next) => {
    const taken = buckets.take(clientKey(c, trustProxy), Date.now());
    if (!taken.ok) {
      c.header('Retry-After', String(taken.retryAfterS));
      return c.json(
        {
          ok: false,
          code: 'rate_limited',
          detail: taken.newLockout
            ? `Rate limit exceeded. Locked out for ${taken.retryAfterS}s.`
            : `Too many requests. Retry after ${taken.retryAfterS}s.`,
        },
        429,
      );
    }
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
  let remoteAddress: string | undefined;
  try {
    remoteAddress = getConnInfo(c).remote.address;
  } catch {
    // No Node socket in context (tests / non-node adapters) — fall through.
  }
  return clientKeyOf(
    {
      forwardedFor: c.req.header('x-forwarded-for'),
      realIp: c.req.header('x-real-ip'),
      remoteAddress,
    },
    trustProxy,
  );
}

/**
 * The bucket key from raw header values, shared with the node pairing upgrade (node/node-socket.ts,
 * which has no Hono context). `trustProxy` is the same `ETHOS_TRUST_PROXY` switch. Pinned by
 * __tests__/middleware/rate-limit.test.ts and node-socket.test.ts "trustProxy".
 */
export function clientKeyOf(
  src: {
    forwardedFor?: string | undefined;
    realIp?: string | undefined;
    remoteAddress?: string | undefined;
  },
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = src.forwardedFor?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
    if (src.realIp) return src.realIp;
  }
  return src.remoteAddress || 'unknown';
}
