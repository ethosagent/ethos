// ---------------------------------------------------------------------------
// One OTLP/HTTP JSON POST. No retries here — the poller owns retry/backoff
// state; this function reports whether a retry could help (§4.2 step 6 of
// plan/phases/otlp-export.md, following the OTLP/HTTP spec's retryable set).
//
// NOTHING from the request (headers above all — they carry collector
// credentials, D7) may appear in any result field. `bodySnippet` is always
// the RESPONSE body, capped at 256 chars, and a network/timeout failure
// carries no text at all.
// ---------------------------------------------------------------------------

export type OtlpPostResult =
  | { ok: true; partialRejectedSpans?: number }
  | { ok: false; retryable: boolean; retryAfterMs?: number; status?: number; bodySnippet?: string };

/** The OTLP/HTTP spec's retryable statuses; every other non-2xx is
 *  permanent (D13). */
const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);

const BODY_SNIPPET_MAX_CHARS = 256;

/** `Retry-After` per RFC 9110: delta-seconds or an HTTP date. */
function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - nowMs);
  return undefined;
}

async function readBodySnippet(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    return text.slice(0, BODY_SNIPPET_MAX_CHARS);
  } catch {
    return undefined;
  }
}

/**
 * POST one serialized `ExportTraceServiceRequest` to the collector.
 *
 * - 2xx -> `{ ok: true }`, with `partialRejectedSpans` when the collector's
 *   `partialSuccess.rejectedSpans` is positive (still an accepted export —
 *   the poller counts it, it does not retry it).
 * - Network error or timeout -> `{ ok: false, retryable: true }`.
 * - 408/429/502/503/504 -> retryable, with `retryAfterMs` when the response
 *   carries a parseable `Retry-After`.
 * - Any other non-2xx -> `{ ok: false, retryable: false }` (D13: terminal).
 */
export async function postOtlp(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<OtlpPostResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Network error or AbortSignal timeout. The thrown error is deliberately
    // discarded: nothing from the request may leak into result text.
    return { ok: false, retryable: true };
  }
  if (res.ok) {
    // OTLP partial success: a 2xx whose body carries
    // `partialSuccess.rejectedSpans` (a 64-bit int, so possibly a string in
    // JSON). An unparseable body counts as a full success.
    let rejected = 0;
    try {
      const parsed: unknown = await res.json();
      if (typeof parsed === 'object' && parsed !== null && 'partialSuccess' in parsed) {
        const partial = (parsed as { partialSuccess?: { rejectedSpans?: unknown } }).partialSuccess;
        const raw = partial?.rejectedSpans;
        const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
        if (typeof n === 'number' && Number.isFinite(n) && n > 0) rejected = n;
      }
    } catch {
      rejected = 0;
    }
    return rejected > 0 ? { ok: true, partialRejectedSpans: rejected } : { ok: true };
  }
  const retryable = RETRYABLE_STATUSES.has(res.status);
  const bodySnippet = await readBodySnippet(res);
  const retryAfterMs = retryable
    ? parseRetryAfter(res.headers.get('retry-after'), Date.now())
    : undefined;
  return {
    ok: false,
    retryable,
    status: res.status,
    ...(bodySnippet !== undefined ? { bodySnippet } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}
