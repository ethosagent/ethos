// `postSystemOne` — the only code in this package that touches the wire
// (plan §5.1, §5.4, D3). One JSON POST to `${baseUrl}/v1/systemone`.
//
// - Plain injectable `fetch`; no `@typesafe-ai/sdk`, which retries by default
//   where the call site must own the budget (D3).
// - Exactly one request per call, whatever the status: no retries and no
//   backoff sleep (R5). A 429/529 returns its code at once; sustained failure
//   is the breaker's job (./breaker). Pinned by `__tests__/transport.test.ts`.
// - Never throws: every failure is `{ ok: false, code, message }`.

import type { DecisionErrorCode } from './contract';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PostSystemOneOptions {
  baseUrl: string;
  apiKey: string;
  body: { state: unknown; model: string; questions: Record<string, unknown> };
  signal?: AbortSignal;
  timeoutMs: number;
  fetch?: FetchLike;
}

export type PostSystemOneResult =
  | { ok: true; body: unknown }
  | { ok: false; code: DecisionErrorCode; message: string };

const STATUS_CODES: Record<number, DecisionErrorCode> = {
  401: 'auth',
  422: 'invalid',
  429: 'rate_limited',
  529: 'overloaded',
};

export function systemOneUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/systemone`;
}

export async function postSystemOne(opts: PostSystemOneOptions): Promise<PostSystemOneResult> {
  const { signal, timeoutMs } = opts;
  if (signal?.aborted) {
    return { ok: false, code: 'aborted', message: 'typesafe: aborted by caller before request' };
  }

  // One controller carries both the budget and the caller's signal into fetch
  // (and into the body read). `cause` records which of the two fired, because
  // the fetch rejection alone cannot tell them apart.
  const controller = new AbortController();
  let cause: 'timeout' | 'aborted' | null = null;
  const timer = setTimeout(() => {
    cause ??= 'timeout';
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => {
    cause ??= 'aborted';
    controller.abort();
  };
  signal?.addEventListener('abort', onCallerAbort, { once: true });

  const interrupted = (): PostSystemOneResult | null => {
    if (cause === 'timeout') {
      return { ok: false, code: 'timeout', message: `typesafe: no answer within ${timeoutMs} ms` };
    }
    if (cause === 'aborted') {
      return { ok: false, code: 'aborted', message: 'typesafe: aborted by caller' };
    }
    return null;
  };

  try {
    const doFetch = opts.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await doFetch(systemOneUrl(opts.baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(opts.body),
        signal: controller.signal,
      });
    } catch (err) {
      return (
        interrupted() ?? {
          ok: false,
          code: 'unavailable',
          message: `typesafe: network error: ${err instanceof Error ? err.message : String(err)}`,
        }
      );
    }

    if (!response.ok) {
      // The response body is deliberately not echoed into the message: a
      // vendor error body can quote the request, and the request is state.
      return {
        ok: false,
        code: STATUS_CODES[response.status] ?? 'unavailable',
        message: `typesafe: HTTP ${response.status}`,
      };
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      return (
        interrupted() ?? {
          ok: false,
          code: 'unavailable',
          message: `typesafe: body read failed: ${err instanceof Error ? err.message : String(err)}`,
        }
      );
    }
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return { ok: false, code: 'malformed', message: 'typesafe: response is not valid JSON' };
    }
  } catch (err) {
    return {
      ok: false,
      code: 'unavailable',
      message: `typesafe: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}
