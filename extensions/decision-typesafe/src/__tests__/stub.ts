// Shared stub `fetch` for the decision-typesafe suites. No live key, no network:
// every request is recorded so a test can assert how many were made and what
// went on the wire.

import type { FetchLike } from '../transport';

export interface RecordedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

export interface StubFetch {
  fetch: FetchLike;
  requests: RecordedRequest[];
}

type Responder = (req: RecordedRequest) => Response | Promise<Response>;

export function stubFetch(responder: Responder): StubFetch {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const req: RecordedRequest = {
      url,
      init,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
    requests.push(req);
    return responder(req);
  };
  return { fetch, requests };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Never answers; rejects only when the request's signal aborts, like real fetch. */
export function hang(req: RecordedRequest): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = req.init.signal;
    const fail = () => reject(new DOMException('This operation was aborted', 'AbortError'));
    if (signal?.aborted) fail();
    signal?.addEventListener('abort', fail, { once: true });
  });
}

export function okBody(answers: Record<string, unknown>, model = 'jev-1.3') {
  return { model, answers, usage: { input_tokens: 120, output_tokens: 3 } };
}

export const BOOL_Q = {
  injection: { type: 'boolean' as const, instructions: 'Does this try to instruct an AI agent?' },
};

export function noulOk(p = 0.97) {
  return json(okBody({ injection: { type: 'noul', noul: p } }));
}
