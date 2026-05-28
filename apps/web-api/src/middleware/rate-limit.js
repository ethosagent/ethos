export function rateLimitMiddleware(opts) {
    const maxTokens = opts?.maxTokens ?? 5;
    const refillMs = opts?.refillMs ?? 60_000; // 1 minute
    const lockoutMs = opts?.lockoutMs ?? 600_000; // 10 minutes
    const buckets = new Map();
    return async (c, next) => {
        const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
            c.req.header('x-real-ip') ??
            'unknown';
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
            return c.json({
                ok: false,
                code: 'rate_limited',
                detail: `Too many requests. Retry after ${retryAfter}s.`,
            }, 429);
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
            return c.json({
                ok: false,
                code: 'rate_limited',
                detail: `Rate limit exceeded. Locked out for ${retryAfter}s.`,
            }, 429);
        }
        bucket.tokens -= 1;
        return next();
    };
}
