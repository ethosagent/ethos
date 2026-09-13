import { EthosError, type EthosErrorCode, isEthosError } from '@ethosagent/types';
import type { Context, MiddlewareHandler } from 'hono';
// Side-effect import: `hono/request-id` augments Hono's `ContextVariableMap`
// with `requestId`, which is what types `c.get('requestId')` below. The
// middleware itself is mounted in routes/index.ts.
import 'hono/request-id';

// Uniform JSON error shape on the wire. Services throw `EthosError`; this
// middleware catches anything that escaped a route and renders it as
// `{ ok: false, code, error, action }`. oRPC handlers also feed through here
// when their procedure body throws.
//
// HTTP status is derived from the code so `fetch().ok` is meaningful client
// side. Unknown codes bucket as 500 — the `INTERNAL` fallback used by
// `toEthosError` already does this naturally.

export interface ErrorEnvelope {
  ok: false;
  code: EthosErrorCode;
  error: string;
  action: string;
  /** B1 — the request's `x-request-id`, echoed so a user can quote the exact
   *  failed request. Optional because `toEnvelope` is also called from routes
   *  that build an envelope without a Hono context. */
  requestId?: string;
}

const STATUS_BY_CODE: Partial<Record<EthosErrorCode, number>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  SESSION_NOT_FOUND: 404,
  CONFIG_MISSING: 400,
  CONFIG_INVALID: 400,
  // A write built against a provider chain that has since changed (ConfigService.update).
  CONFIG_CONFLICT: 409,
  INVALID_INPUT: 400,
  PERSONALITY_NOT_FOUND: 404,
  FILE_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  SKILL_NOT_FOUND: 404,
  SKILL_EXISTS: 409,
  PERSONALITY_EXISTS: 409,
  PERSONALITY_READ_ONLY: 403,
  WORKDIR_NOT_CONFIGURED: 400,
  DOCUMENT_EXISTS: 409,
  PAYLOAD_TOO_LARGE: 413,
  PROVIDER_AUTH_FAILED: 502,
  LLM_ERROR: 502,
  STREAM_TIMEOUT: 504,
  TOOL_REJECTED: 403,
  CRON_TARGET_NOT_ALLOWED: 403,
  RECIPE_NOT_FOUND: 404,
  // The catalog is first-party and in-repo: a bundle that fails its own schema
  // in production is our bug, not the caller's.
  RECIPE_INVALID: 500,
  RECIPE_STALE: 409,
  RECIPE_BLOCKED: 400,
  // The caller supplied a credential or a chat the platform did not accept.
  RECIPE_CHANNEL_SETUP_FAILED: 400,
  NETWORK_ERROR: 502,
  // `PluginsService.install` refusals (services/plugins.service.ts —
  // `resolveRegistrySpec`, `classifyNpmFailure`, `install`). Nothing is left
  // installed by any of them unless the cause says so: a failure once `npm install`
  // has run is undone by `undoPluginInstall` and described from the end state it
  // confirmed by `describeUndoneInstall` (extensions/plugin-loader/src/install-undo.ts).
  // The spec names no exact published version with a sha512 digest: the caller fixes the spec.
  PLUGIN_SPEC_UNVERIFIABLE: 400,
  // `npm view` reported E404 for the package name: the named thing does not resolve,
  // the same convention as RECIPE_NOT_FOUND / SKILL_NOT_FOUND for a name given in the body.
  PLUGIN_PACKAGE_NOT_FOUND: 404,
  // `npm view` could not get an answer from the registry (network, registry 5xx, auth): upstream failure.
  PLUGIN_REGISTRY_FAILED: 502,
  // The registry served a tarball that does not match its own digest: upstream misbehaving, not the caller.
  PLUGIN_INTEGRITY_MISMATCH: 502,
  // npm installed a package.json naming another package/version than resolved: upstream, not the caller.
  PLUGIN_PACKAGE_MISMATCH: 502,
  // `npm pack` / `npm install` failed for a reason that is neither the registry
  // (network errno, E5xx → PLUGIN_REGISTRY_FAILED) nor a missing npm (NOT_CONFIGURED):
  // a dependency npm cannot resolve, disk, permissions. Not the caller's spec (the
  // version was already verified) and not proven upstream, so 500 — npm's own code
  // in the cause is what tells these apart. The CLI raises the same code for its own
  // install refusals (apps/ethos/src/commands/plugin.ts); this status applies only here.
  PLUGIN_INSTALL_FAILED: 500,
  // This server is not set up to do that (no LLM, no goal executor, no
  // approval queue, no attachment cache, …): a precondition of the deployment,
  // not a crash and not the caller's fault. 503 matches /healthz's degraded
  // answer. Limitation: `requireStorage` (repositories/require-storage.ts)
  // throws this code for a wiring bug. Today its only callers are constructors,
  // so it fails `createWebApi` rather than a request, but nothing enforces
  // that — a request-time caller would surface a wiring bug as 503.
  NOT_CONFIGURED: 503,
};

export function toEnvelope(err: EthosError): ErrorEnvelope {
  return { ok: false, code: err.code, error: err.cause, action: err.action };
}

export function statusFor(code: EthosErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

/**
 * Last-resort handler. Mounted via `app.onError(...)` in `createWebApi`.
 * Routes themselves can also `c.json(toEnvelope(err), statusFor(err.code))`
 * directly when they want to short-circuit without throwing.
 */
export function errorHandler(err: Error, c: Context): Response {
  // B1 — the id the `x-request-id` middleware settled on for THIS request (an
  // inbound one it accepted, or the UUID it generated). This used to be a
  // freshly minted UUID visible only in the 500 body, so the id the client was
  // told to quote appeared in no response header and named no other log line.
  // Widened to `| undefined` on purpose: Hono types the variable as `string`
  // once the middleware is registered, but `errorHandler` is also mounted on
  // sub-apps in tests where it never ran.
  const requestId: string | undefined = c.get('requestId');
  if (isEthosError(err)) {
    return c.json(
      { ...toEnvelope(err), ...(requestId ? { requestId } : {}) },
      statusFor(err.code) as 400 | 401 | 403 | 404 | 409 | 413 | 500 | 502 | 503 | 504,
    );
  }
  // Anything else is a bug (uncaught raw Error). Log the full error server-side
  // for debugging but never reflect raw err.message to the client — it may
  // contain internal paths, stack traces, or database details.
  console.error('[internal_error]', requestId, err);
  const wrapped = new EthosError({
    code: 'INTERNAL',
    cause: requestId ? `Internal server error (request_id: ${requestId})` : 'Internal server error',
    action: 'Re-run the request. If the error repeats, file an issue with the request_id.',
  });
  return c.json({ ...toEnvelope(wrapped), ...(requestId ? { requestId } : {}) }, 500);
}

/**
 * Convenience middleware that wraps the rest of the chain in a try/catch.
 * Equivalent to `app.onError`, but composable into sub-routers when a single
 * Hono instance hosts both the API and (later) the static Vite assets.
 */
export const errorEnvelope: MiddlewareHandler = async (c, next) => {
  try {
    await next();
  } catch (err) {
    return errorHandler(err instanceof Error ? err : new Error(String(err)), c);
  }
};
