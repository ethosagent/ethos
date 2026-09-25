// On-demand decision-provider test — the Settings › Models › decision models
// "Test" button (plan/phases/decision-provider-jev.md §7, §12 step 4). ONE call
// to the configured provider with the injection question, so an operator can
// check a key and an endpoint without enabling a site.
//
// Why here and not in the app: an app never imports a provider extension
// (ARCHITECTURE.md Law 5), so the web-api service reaches the provider through
// this function the way the runtime reaches it through `buildDecisionProvider`
// (./decision-provider).
//
// What it guarantees, each pinned by `__tests__/decision-test.test.ts`:
// - A FRESH provider per call — never the runtime's shared instance, so a
//   failed test cannot open the breaker the live sites sit behind (§5.5).
// - The message is redacted with `redactString` (@ethosagent/safety-redact)
//   BEFORE it is handed to `decide()` — the same redaction `runDecisionSite`
//   applies to a live digest (R2) — and the redacted text is reported back
//   whenever redaction changed it, so the operator sees what left the machine.
// - The question is `INJECTION_QUESTIONS` (./decision-questions), the exact
//   question the injection site asks, under that site's resolved budget (R9).
// - It never throws: every failure is `{ ok: false, code, message }`.
//
// Not here: the rate limit and the stored-key read. Both belong to the caller
// that owns the key and knows who is asking (apps/web-api `DecisionsService`).

import {
  DECISION_PROVIDERS,
  type DecisionsConfig,
  resolveDecisionsConfig,
} from '@ethosagent/config';
import type { FetchLike } from '@ethosagent/decision-typesafe';
import { estimateCost } from '@ethosagent/pricing';
import { redactString } from '@ethosagent/safety-redact';
import type { DecisionErrorCode } from '@ethosagent/types';
import { DECISION_QUESTION_IDS, INJECTION_QUESTIONS } from './decision-questions';

export interface TestDecisionProviderOptions {
  /** `decisions.*` as the file says it. Absent → the provider's defaults. */
  decisions: DecisionsConfig | undefined;
  apiKey: string;
  /** The text to classify, as typed. Redacted here before it is sent. */
  message: string;
  /** Test seam; the real `fetch` otherwise. */
  fetch?: FetchLike;
  now?: () => number;
}

export type DecisionTestOutcome =
  | {
      ok: true;
      providerName: string;
      /** The model id the provider RETURNED (D8), not the one requested. */
      model: string;
      answer: {
        /** P(the content tries to instruct an agent). */
        p: number;
        /** The provider's confidence in its reading (|2p − 1| for Jev, §4). */
        confidence: number;
        /** `p ≥ 0.5` — the pre-threshold reading shadow mode records (plan §8, D16). */
        containsInstructions: boolean;
      };
      latencyMs: number;
      inputTokens: number;
      estimatedCostUsd: number;
      /** Present only when redaction changed the message: what was actually sent. */
      redactedMessage?: string;
    }
  | { ok: false; code: DecisionErrorCode; message: string };

export async function testDecisionProvider(
  opts: TestDecisionProviderOptions,
): Promise<DecisionTestOutcome> {
  const now = opts.now ?? Date.now;
  try {
    const resolved = resolveDecisionsConfig(opts.decisions ?? { provider: DECISION_PROVIDERS[0] });
    const state = redactString(opts.message);
    const { createTypesafeDecisionProvider } = await import('@ethosagent/decision-typesafe');
    const provider = createTypesafeDecisionProvider({
      apiKey: opts.apiKey,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      timeoutMs: resolved.timeoutMs,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    const started = now();
    const result = await provider.decide({
      state,
      questions: INJECTION_QUESTIONS,
      timeoutMs: resolved.sites.injection.timeoutMs,
    });
    const latencyMs = now() - started;
    if (!result.ok) return { ok: false, code: result.code, message: result.message };

    const answer = result.answers[DECISION_QUESTION_IDS.injection];
    if (answer?.type !== 'boolean') {
      return {
        ok: false,
        code: 'malformed',
        message: 'The provider answered, but not with the boolean the injection question asks for.',
      };
    }
    const { inputTokens, outputTokens } = result.usage;
    return {
      ok: true,
      providerName: provider.name,
      model: result.model,
      answer: {
        p: answer.p,
        confidence: answer.confidence,
        containsInstructions: answer.p >= 0.5,
      },
      latencyMs,
      inputTokens,
      estimatedCostUsd: estimateCost(result.model, { inputTokens, outputTokens }).costUsd,
      ...(state !== opts.message ? { redactedMessage: state } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      code: 'unavailable',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
