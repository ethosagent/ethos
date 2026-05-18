import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

export interface OpenAiCorsOptions {
  /** Comma-separated origins or `*`. When empty/undefined, CORS is disabled. */
  origins?: string;
}

const ALLOW_METHODS = ['GET', 'POST', 'OPTIONS', 'DELETE'] as const;
const ALLOW_HEADERS = ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Ethos-Session'];

export function openAiCors(opts?: OpenAiCorsOptions): MiddlewareHandler {
  const raw = opts?.origins ?? process.env.ETHOS_API_CORS_ORIGINS ?? '';
  const trimmed = raw.trim();

  if (!trimmed) {
    return async (_c, next) => {
      await next();
    };
  }

  if (trimmed === '*') {
    return cors({
      origin: '*',
      allowMethods: [...ALLOW_METHODS],
      allowHeaders: ALLOW_HEADERS,
    });
  }

  const allowed = new Set(
    trimmed
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );

  return cors({
    origin: (origin) => (allowed.has(origin) ? origin : ''),
    allowMethods: [...ALLOW_METHODS],
    allowHeaders: ALLOW_HEADERS,
  });
}
