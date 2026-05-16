import type { MiddlewareHandler } from 'hono';
import type { CachedResponse, IdempotencyStore } from '../stores/idempotency-store';

export interface IdempotencyMiddlewareOptions {
  store: IdempotencyStore;
}

export function idempotencyMiddleware(opts: IdempotencyMiddlewareOptions): MiddlewareHandler {
  const pending = new Map<string, Promise<CachedResponse>>();

  return async (c, next) => {
    const idempotencyKey = c.req.header('idempotency-key');
    if (!idempotencyKey) {
      await next();
      return;
    }

    const apiKey = c.get('apiKey');
    const apiKeyId = apiKey.id;
    const compositeKey = `${apiKeyId}:${idempotencyKey}`;

    const cached = opts.store.get(apiKeyId, idempotencyKey);
    if (cached) {
      return cachedToResponse(cached);
    }

    const inflight = pending.get(compositeKey);
    if (inflight) {
      const result = await inflight;
      return cachedToResponse(result);
    }

    let resolvePending: ((value: CachedResponse) => void) | undefined;
    let rejectPending: ((reason: unknown) => void) | undefined;
    const promise = new Promise<CachedResponse>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    pending.set(compositeKey, promise);

    try {
      await next();

      const status = c.res.status;
      const headers: Record<string, string> = {};
      c.res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const body = await c.res.text();

      const entry: CachedResponse = { status, headers, body };
      opts.store.set(apiKeyId, idempotencyKey, entry);
      if (resolvePending) resolvePending(entry);

      c.res = cachedToResponse(entry);
    } catch (err) {
      if (rejectPending) rejectPending(err);
      throw err;
    } finally {
      pending.delete(compositeKey);
    }
  };
}

function cachedToResponse(cached: CachedResponse): Response {
  return new Response(cached.body, {
    status: cached.status,
    headers: new Headers(cached.headers),
  });
}
