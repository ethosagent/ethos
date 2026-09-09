import type { ToolResult } from '@ethosagent/types';
import {
  type FetchLike,
  mintAccessToken,
  parseServiceAccountJson,
  type ServiceAccount,
} from './auth';
import { API_BASE } from './constants';
import {
  describeGscApiError,
  describeTokenMintError,
  ServiceAccountJsonError,
  TokenMintError,
} from './errors';

// ---------------------------------------------------------------------------
// @ethosagent/tools-search-console — gsc_sites + gsc_queries, one
// service-account credential, read-only scope.
// See plan/phases/search-console.md §5-§12.
// ---------------------------------------------------------------------------

export {
  buildAssertion,
  clearTokenCache,
  EXPIRY_SAFETY_MARGIN_MS,
  type FetchLike,
  getAccessToken,
  mintAccessToken,
  parseServiceAccountJson,
  readServiceAccount,
  type ServiceAccount,
} from './auth';
export {
  ALLOWED_HOSTS,
  API_BASE,
  API_HOST,
  type CreateSearchConsoleToolOptions,
  DEFAULT_SECRET_REF,
  NO_KEY_MESSAGE,
  SCOPE,
  SECRET_PREFIX,
  SETTINGS_KEY,
  type SearchConsoleToolSetting,
  selectGscSecretRef,
  TOKEN_HOST,
} from './constants';
export {
  describeGscApiError,
  describeThrownGscError,
  describeTokenMintError,
  ServiceAccountJsonError,
  TokenMintError,
} from './errors';
export {
  createGscQueriesTool,
  DIMENSIONS,
  type GscDimension,
  type GscQueriesArgs,
  renderQueriesJson,
  renderQueriesText,
  resolveRange,
} from './queries';
export { createGscSitesTool } from './sites';

function errorText(result: ToolResult): string {
  return result.ok ? 'Key check could not be completed.' : result.error;
}

/**
 * Collapse a thrown probe failure to text that is safe to render in the Keys
 * pane. Only the two errors this module raises deliberately are surfaced
 * verbatim; anything else (a DNS failure, an abort, a TypeError) becomes a
 * fixed category, because `testKey`'s own catch treats a raw caught message as
 * unsafe to echo and this path is inside that same boundary.
 */
function probeFailureText(err: unknown): string {
  if (err instanceof TokenMintError) return errorText(describeTokenMintError(err));
  if (err instanceof ServiceAccountJsonError) return err.message;
  if (err instanceof Error && err.name === 'AbortError') return 'Key check timed out.';
  return 'Key check could not be completed.';
}

/**
 * Vault probe for the `google-search-console` provider: mint a token from the
 * pasted service-account JSON and call `sites.list`. A 200 is `{ ok: true }`;
 * anything else returns the same actionable text the tools' own mappers
 * produce, so the Keys pane and chat never disagree about what went wrong.
 *
 * This lives HERE, not in `apps/web-api`, because the alternative is ~60 lines
 * of PEM parsing and RS256 signing duplicated into the service — plus a second
 * copy of both error mappers. `apps/web-api` already depends on
 * `@ethosagent/tools-mcp`, `tools-ui` and `tools-voice`, so the edge is
 * precedented and runs apps → extensions, the direction the layer model allows
 * (ARCHITECTURE.md §II). Deliberately UNCACHED: an operator pressing "test key"
 * after rotating a credential must exercise the key they just pasted.
 *
 * `fetch` is injectable so the probe can be exercised without a network; the
 * default is the platform fetch, because a web-api probe has no ToolContext and
 * therefore no `ScopedFetch` (every existing `probeProvider` branch is a bare
 * fetch for the same reason).
 */
export async function probeServiceAccountKey(
  json: string,
  opts: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; error?: string }> {
  const fetchFn: FetchLike = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  try {
    const sa: ServiceAccount = parseServiceAccountJson(json);
    const { token } = await mintAccessToken(sa, fetchFn, opts.signal);
    const response = await fetchFn(`${API_BASE}/sites`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (response.ok) return { ok: true };
    return {
      ok: false,
      error: errorText(await describeGscApiError(response, { clientEmail: sa.clientEmail })),
    };
  } catch (err) {
    return { ok: false, error: probeFailureText(err) };
  }
}
