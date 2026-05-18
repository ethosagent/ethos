import { createHash } from 'node:crypto';
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

    // Read body once for streaming check + request fingerprint.
    let bodyText = '';
    try {
      bodyText = await c.req.raw.clone().text();
      const parsed = JSON.parse(bodyText);
      if (parsed && typeof parsed === 'object' && parsed.stream === true) {
        await next();
        return;
      }
    } catch {
      // Not JSON — proceed; downstream will 400
    }

    const requestHash = createHash('sha256').update(bodyText).digest('hex').slice(0, 16);

    const apiKey = c.get('apiKey');
    const apiKeyId = apiKey.id;
    const compositeKey = `${apiKeyId}:${idempotencyKey}`;

    const cached = opts.store.get(apiKeyId, idempotencyKey);
    if (cached) {
      if (cached.requestHash !== requestHash) {
        return c.json(
          {
            error: {
              message: 'Idempotency-Key reused with a different request body.',
              type: 'invalid_request_error',
              code: 'idempotency_key_reused',
              param: null,
            },
          },
          422,
        );
      }
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
      opts.store.set(apiKeyId, idempotencyKey, requestHash, entry);
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
