// UBP-030 — bounded retry of a transient failure BEFORE the first byte.
//
// The fetch-based providers (codex, xai via llm-codex's
// `streamResponsesApi`, gemini-native, bedrock) have no SDK underneath, so a
// single 429/503 or a dropped connection used to fail the turn outright in a
// single-provider deployment, where no `ChainedProvider` exists to retry it.
//
// This wraps only the `fetch()` that returns the response headers: once a
// response is handed back and the caller starts yielding chunks, nothing is
// ever retried (a retry after output would duplicate it). The policy mirrors
// `ChainedProvider`'s pinned retry (`pinnedRetryDelayMs` / `retryAfterMs` in
// packages/core/src/providers/chained-provider.ts): 500ms then 1500ms plus up
// to 25% jitter, an honoured `retry-after-ms` / `retry-after` capped at 10s,
// at most 2 retries. A chain hop is built with `maxRetries: 0`
// (packages/wiring/src/index.ts, `chainHop`) so failover stays the retry
// policy there, the same rule the SDK-based providers follow.
//
// One home for the three fetch-based providers: extensions/llm-codex,
// extensions/llm-gemini and extensions/llm-bedrock import
// `fetchWithTransientRetry` from @ethosagent/core (their transport.ts). Pinned
// by packages/core/src/__tests__/transient-retry.test.ts and each provider's
// transport tests.

export interface TransientRetryOptions {
  /** Retries after the first attempt. Default 2; `0` disables retrying. */
  maxRetries?: number;
  /** Test seam — replaces the abortable timer between attempts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;
const BACKOFF_FACTOR = 3;
const JITTER_RATIO = 0.25;
const MAX_WAIT_MS = 10_000;

/** 408, 429 and the 5xx statuses a vendor uses for "try again". A 400/401/403/404 never is. */
export function isTransientStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 529
  );
}

/** The wait a response asked for: `retry-after-ms`, then `retry-after` as seconds or an HTTP date. */
export function retryAfterMs(headers: Headers | undefined): number | undefined {
  const read = (name: string): string | undefined => {
    const value = headers?.get(name);
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };
  const ms = Number(read('retry-after-ms') ?? Number.NaN);
  if (Number.isFinite(ms)) return Math.max(0, ms);
  const after = read('retry-after');
  if (after === undefined) return undefined;
  const seconds = Number(after);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(after);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Delay before retry number `retry` (1-based). */
export function transientRetryDelayMs(retry: number, requestedMs: number | undefined): number {
  if (requestedMs !== undefined) return Math.min(requestedMs, MAX_WAIT_MS);
  const base = BASE_DELAY_MS * BACKOFF_FACTOR ** (retry - 1);
  return Math.min(base + Math.random() * base * JITTER_RATIO, MAX_WAIT_MS);
}

function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * Run `doFetch` until it yields a response that is not a transient failure, or
 * the retry budget is spent. Returns the last response (the caller turns a
 * non-2xx into its own error, exactly as before); rethrows the last network
 * error. An abort is never retried.
 */
export async function fetchWithTransientRetry(
  doFetch: () => Promise<Response>,
  signal: AbortSignal | undefined,
  options: TransientRetryOptions = {},
): Promise<Response> {
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const sleep = options.sleep ?? sleepUnlessAborted;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await doFetch();
    } catch (err) {
      if (attempt >= maxRetries || isAbort(err, signal)) throw err;
      await sleep(transientRetryDelayMs(attempt + 1, undefined), signal);
      continue;
    }
    if (response.ok || !isTransientStatus(response.status) || attempt >= maxRetries) {
      return response;
    }
    const requested = retryAfterMs(response.headers);
    // Release the failed response's connection before waiting.
    await response.body?.cancel().catch(() => undefined);
    await sleep(transientRetryDelayMs(attempt + 1, requested), signal);
  }
}
