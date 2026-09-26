// `createTypesafeDecisionProvider` — the Jev DecisionProvider (plan §5).
//
// A thin adapter over ./transport, per ARCHITECTURE.md §IV's
// thin-adapter-over-a-transport pattern. `decide()` is:
// validate → size guard → breaker → one POST → map. Errors are data, never
// thrown (§4): every step returns `{ ok: false, code, message }`, and the whole
// body is wrapped so an unexpected throw becomes `unavailable`. Pinned by
// `__tests__/contract.test.ts`.

import type { DecisionProvider, DecisionRequest, DecisionResult } from '@ethosagent/types';
import { DecisionBreaker, type DecisionBreakerEvent } from './breaker';
import { mapResponse, toWireQuestions } from './mapping';
import { checkSize } from './size-guard';
import { type FetchLike, postSystemOne } from './transport';
import { validateDecisionRequest } from './validate';

export interface TypesafeDecisionProviderOptions {
  apiKey: string;
  /** Default `jev-latest`, the vendor's stable alias; never `jev-preview` (D8). */
  model?: string;
  baseUrl?: string;
  /** Default per-call budget (ms); also the breaker's timeout-counting floor (R9). */
  timeoutMs?: number;
  fetch?: FetchLike;
  now?: () => number;
  onEvent?: (event: DecisionBreakerEvent) => void;
}

export const TYPESAFE_DEFAULT_MODEL = 'jev-latest';
export const TYPESAFE_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const TYPESAFE_DEFAULT_TIMEOUT_MS = 2000;

export function createTypesafeDecisionProvider(
  opts: TypesafeDecisionProviderOptions,
): DecisionProvider {
  const model = opts.model ?? TYPESAFE_DEFAULT_MODEL;
  const baseUrl = opts.baseUrl ?? TYPESAFE_DEFAULT_BASE_URL;
  const defaultTimeoutMs = opts.timeoutMs ?? TYPESAFE_DEFAULT_TIMEOUT_MS;
  const breaker = new DecisionBreaker(opts.now ?? Date.now, opts.onEvent);

  async function decide(request: DecisionRequest): Promise<DecisionResult> {
    try {
      const valid = validateDecisionRequest(request);
      if (!valid.ok) return valid;
      const size = checkSize(request);
      if (!size.ok) return size;

      const admission = breaker.admit();
      if (admission === 'reject') {
        // PD19 (plan decision-provider-personality §15.1): its own code, so a
        // surface can say "skipped" rather than "failed". Returned before
        // `breaker.record`, so the breaker never counts its own refusal.
        return {
          ok: false,
          code: 'breaker_open',
          message: 'typesafe: breaker open after repeated failures; no request sent',
        };
      }

      const budget = request.timeoutMs ?? defaultTimeoutMs;
      let result: DecisionResult;
      try {
        const sent = await postSystemOne({
          baseUrl,
          apiKey: opts.apiKey,
          body: { state: request.state, model, questions: toWireQuestions(request.questions) },
          signal: request.signal,
          timeoutMs: budget,
          fetch: opts.fetch,
        });
        result = sent.ok ? mapResponse(request.questions, sent.body) : sent;
      } catch (err) {
        result = unavailable(err);
      }
      breaker.record(result, admission === 'probe', budget >= defaultTimeoutMs);
      return result;
    } catch (err) {
      return unavailable(err);
    }
  }

  return { name: 'typesafe', calibrated: true, decide };
}

function unavailable(err: unknown): DecisionResult {
  return {
    ok: false,
    code: 'unavailable',
    message: `typesafe: ${err instanceof Error ? err.message : String(err)}`,
  };
}
