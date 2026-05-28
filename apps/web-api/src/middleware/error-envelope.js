import { randomUUID } from 'node:crypto';
import { EthosError, isEthosError } from '@ethosagent/types';

const STATUS_BY_CODE = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  SESSION_NOT_FOUND: 404,
  CONFIG_MISSING: 400,
  CONFIG_INVALID: 400,
  INVALID_INPUT: 400,
  PERSONALITY_NOT_FOUND: 404,
  FILE_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  SKILL_NOT_FOUND: 404,
  SKILL_EXISTS: 409,
  PERSONALITY_EXISTS: 409,
  PERSONALITY_READ_ONLY: 403,
  PROVIDER_AUTH_FAILED: 502,
  LLM_ERROR: 502,
  STREAM_TIMEOUT: 504,
  TOOL_REJECTED: 403,
  NETWORK_ERROR: 502,
};
export function toEnvelope(err) {
  return { ok: false, code: err.code, error: err.cause, action: err.action };
}
export function statusFor(code) {
  return STATUS_BY_CODE[code] ?? 500;
}
/**
 * Last-resort handler. Mounted via `app.onError(...)` in `createWebApi`.
 * Routes themselves can also `c.json(toEnvelope(err), statusFor(err.code))`
 * directly when they want to short-circuit without throwing.
 */
export function errorHandler(err, c) {
  if (isEthosError(err)) {
    return c.json(toEnvelope(err), statusFor(err.code));
  }
  // Anything else is a bug (uncaught raw Error). Log the full error server-side
  // for debugging but never reflect raw err.message to the client — it may
  // contain internal paths, stack traces, or database details.
  const requestId = randomUUID();
  console.error('[internal_error]', requestId, err);
  const wrapped = new EthosError({
    code: 'INTERNAL',
    cause: `Internal server error (request_id: ${requestId})`,
    action: 'Re-run the request. If the error repeats, file an issue with the request_id.',
  });
  return c.json(toEnvelope(wrapped), 500);
}
/**
 * Convenience middleware that wraps the rest of the chain in a try/catch.
 * Equivalent to `app.onError`, but composable into sub-routers when a single
 * Hono instance hosts both the API and (later) the static Vite assets.
 */
export const errorEnvelope = async (c, next) => {
  try {
    await next();
  } catch (err) {
    return errorHandler(err instanceof Error ? err : new Error(String(err)), c);
  }
};
