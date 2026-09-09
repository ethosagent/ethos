import type { ToolResult } from '@ethosagent/types';
import { API_HOST, TOKEN_HOST } from './constants';

// ---------------------------------------------------------------------------
// TWO describers, because two error vocabularies are in play and neither can
// map the other's shape (D26):
//
//   • describeGscApiError    — searchconsole.googleapis.com, which reports the
//                              reason at `error.errors[0].reason`.
//   • describeTokenMintError — oauth2.googleapis.com, which answers the RFC
//                              6749 shape `{ error, error_description }` with
//                              HTTP 400.
//
// A key deleted or disabled in the Cloud console NEVER produces a 401 from
// Search Console, because that call is never made: the failure happens one
// step earlier, at the mint. That is why §11's original 401 row was
// unreachable and why there are two functions here rather than one.
// ---------------------------------------------------------------------------

/**
 * Read Google's error reason out of a Search Console error body.
 *
 * Deliberately duplicated rather than shared with `readErrorReason`
 * (extensions/tools-social-search/src/youtube/constants.ts) and
 * `readGoogleErrorReason` (apps/web-api/src/services/named-secrets.service.ts):
 * only the optional chain overlaps, the reason VOCABULARIES differ
 * (`quotaExceeded`/`keyInvalid` vs `accessNotConfigured`/permission reasons),
 * and extracting it would cross a package boundary to save three lines (D27).
 */
async function readErrorReason(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { errors?: Array<{ reason?: string }> } };
    return body.error?.errors?.[0]?.reason;
  } catch {
    return undefined;
  }
}

export interface GscErrorContext {
  /** The service account the call authenticated as — the thing an operator has
   *  to paste into Search Console's Users and permissions form. */
  clientEmail: string;
  /** The property the call named, when there was one. */
  siteUrl?: string;
}

/**
 * Map a non-ok Search Console response to an actionable ToolResult.
 *
 * A 403 with no reason is deliberately mapped to the GRANT message rather than
 * to a bare failure: 403 is also what a malformed `siteUrl` produces (a
 * `sc-domain:` property addressed as a URL prefix, or a URL prefix missing its
 * trailing slash), and the grant message is the one that gets an operator to
 * re-run `gsc_sites` and copy the exact string.
 *
 * Both premises behind that choice — that a malformed siteUrl surfaces as 403
 * rather than 404, and that an over-16-month range is clipped silently rather
 * than refused — are Google-server facts asserted in the plan and NOT verified
 * against the live API (plan §18). This unit suite cannot settle either.
 */
export async function describeGscApiError(
  response: Response,
  ctx: GscErrorContext,
): Promise<ToolResult> {
  if (response.status === 403) {
    const reason = await readErrorReason(response);
    if (reason === 'accessNotConfigured') {
      return {
        ok: false,
        error:
          "The Search Console API is not enabled for this service account's Google Cloud project. Enable it at https://console.cloud.google.com/apis/library/searchconsole.googleapis.com and retry.",
        code: 'not_available',
      };
    }
    const target = ctx.siteUrl ? `"${ctx.siteUrl}"` : 'this Search Console property';
    return {
      ok: false,
      error:
        `This service account (${ctx.clientEmail}) does not have access to ${target}. ` +
        'A verified owner must add that email as a user on the property in Search Console → Settings → Users and permissions. ' +
        'If the grant is already in place, re-run gsc_sites and copy the siteUrl exactly — a domain property is "sc-domain:example.com" and a URL-prefix property is "https://www.example.com/" with the trailing slash.',
      code: 'not_available',
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      error: 'Search Console rate limit hit (1,200 queries per minute per site). Retry shortly.',
      code: 'execution_failed',
    };
  }
  const body = await response.text().catch(() => '');
  return {
    ok: false,
    error: `Search Console API error ${response.status}: ${body}`,
    code: 'execution_failed',
  };
}

/**
 * A non-ok answer from the token mint. Carries the status and the raw body so
 * `describeTokenMintError` can map it — the body comes from Google's OAuth
 * endpoint and never contains the private key.
 */
export class TokenMintError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Google token mint failed: HTTP ${status}`);
    this.name = 'TokenMintError';
  }
}

/** The service-account JSON in the vault could not be read as a credential. */
export class ServiceAccountJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceAccountJsonError';
  }
}

/**
 * Map an RFC 6749 mint failure. `invalid_grant` names BOTH likely causes with
 * their fixes: a single "the key was rejected" sends an operator to the wrong
 * fix half the time, which is the same reasoning `describeGscApiError` applies
 * to the 403 family (D26).
 */
export function describeTokenMintError(err: TokenMintError): ToolResult {
  let code: string | undefined;
  let description: string | undefined;
  try {
    const parsed = JSON.parse(err.body) as { error?: unknown; error_description?: unknown };
    if (typeof parsed.error === 'string') code = parsed.error;
    if (typeof parsed.error_description === 'string') description = parsed.error_description;
  } catch {
    // Not JSON — fall through to the generic message below.
  }

  if (code === 'invalid_grant') {
    return {
      ok: false,
      error:
        'Google rejected the service-account assertion (invalid_grant). Two causes are likely: ' +
        "(1) this machine's clock is more than 5 minutes away from real time, which invalidates every assertion — sync the system clock and retry; " +
        '(2) the key was deleted or disabled in the Google Cloud console — mint a new JSON key (IAM & Admin → Service Accounts → Keys → Add key) and re-paste it into the named secret.',
      code: 'not_available',
    };
  }

  const detail = [code, description].filter(Boolean).join(': ');
  return {
    ok: false,
    error: `Google token mint failed (HTTP ${err.status})${detail ? `: ${detail}` : '.'}`,
    code: 'execution_failed',
  };
}

/**
 * Map a thrown error to a ToolResult.
 *
 * `ScopedFetchImpl.fetch` (packages/core/src/scoped/scoped-fetch.ts) THROWS
 * `HOST_NOT_ALLOWED` rather than returning a Response, and
 * `resolveToolCapabilities` (packages/core/src/capability-resolver.ts)
 * INTERSECTS a tool's declared hosts with the personality's `network.allow` —
 * so a personality that allows the query host but not the mint host produces a
 * tool that can never authenticate. A Response-keyed error table can never see
 * that case, which is why it is mapped here and names BOTH hosts (plan §18).
 */
export function describeThrownGscError(err: unknown): ToolResult {
  if (err instanceof TokenMintError) return describeTokenMintError(err);
  if (err instanceof ServiceAccountJsonError) {
    return { ok: false, error: err.message, code: 'input_invalid' };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('HOST_NOT_ALLOWED')) {
    return {
      ok: false,
      error:
        `Network access denied. The Search Console tools need BOTH "${API_HOST}" (the query) and "${TOKEN_HOST}" (the token mint) — ` +
        "add both to the personality's safety.network.allow and retry.",
      code: 'not_available',
    };
  }
  return { ok: false, error: message, code: 'execution_failed' };
}
