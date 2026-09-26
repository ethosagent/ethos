// createDecisionToolDecide — the `decide` tool's decide function (plan
// decision-tool D4). The tool (`@ethosagent/tools-decision`) never builds a
// provider; the composition root hands it this function, built on the SAME
// `DecisionProviderHandle` the three decision sites use
// (`packages/wiring/src/build-agent-loop.ts`), so one breaker covers both:
// an outage seen by a site stops the tool, and the reverse (jev §5.5).
//
// Per call, in order:
//   1. `validateDecisionRequest` (@ethosagent/decision-typesafe) — an illegal
//      request is refused before the handle is read or the provider called;
//   2. redact `state` (`redactString` / `redactJson`, @ethosagent/safety-redact)
//      exactly as `runDecisionSite` does (./decision-site.ts) — here, in the
//      composition, never in the extension (jev §8);
//   3. `provider.decide` under `decisions.timeoutMs` (the breaker's yardstick,
//      R9) with the tool call's abort signal;
//   4. one `decision.tool` observability record (`recordDecisionToolCall`,
//      ./observability/ethos-observability.ts).
// It never throws: a throwing provider becomes `unavailable`, as in
// `runDecisionSite`. NOT Tier 0 (D12): the answer carries no authority — the
// model reads it like any other tool result. Pinned by
// `__tests__/decision-tool.test.ts`.

import { validateDecisionRequest } from '@ethosagent/decision-typesafe';
import { estimateCost } from '@ethosagent/pricing';
import { redactJson, redactString } from '@ethosagent/safety-redact';
import type { DecideFn, DecideOutcome } from '@ethosagent/tools-decision';
import type { DecisionErrorCode, DecisionRequest } from '@ethosagent/types';
import type { DecisionProviderHandle } from './decision-provider';

/** One `decide` tool call as observability records it (D7). */
export interface DecisionToolCallRecord {
  provider: string;
  /** The model id the provider RETURNED; absent when the call failed. */
  model?: string;
  latencyMs: number;
  inputTokens: number;
  questionCount: number;
  /** `no_key`: the operator configured a provider but the vault holds no key. */
  outcome: 'ok' | DecisionErrorCode | 'no_key';
  estimatedCostUsd: number;
  personalityId?: string;
  sessionId?: string;
}

export interface DecisionToolRecorder {
  recordDecisionToolCall(record: DecisionToolCallRecord): void;
}

export interface CreateDecisionToolDecideOptions {
  provider: DecisionProviderHandle;
  /** The configured provider's name, recorded when no provider instance exists. */
  providerName: string;
  /** `decisions.timeoutMs` — the breaker's yardstick (R9). */
  timeoutMs: number;
  recorder?: DecisionToolRecorder;
  now?: () => number;
}

function redactState(state: DecisionRequest['state']): DecisionRequest['state'] {
  if (typeof state === 'string') return redactString(state);
  if (Array.isArray(state)) return redactJson({ state }).state as unknown[];
  return redactJson(state);
}

export function createDecisionToolDecide(opts: CreateDecisionToolDecideOptions): DecideFn {
  const now = opts.now ?? Date.now;
  return async (call) => {
    const started = now();
    const questionCount = Object.keys(call.questions ?? {}).length;
    let providerName = opts.providerName;
    let outcome: DecideOutcome;
    let inputTokens = 0;
    try {
      const valid = validateDecisionRequest({ state: call.state, questions: call.questions });
      if (!valid.ok) {
        outcome = valid;
      } else {
        const state = redactState(call.state);
        const provider = await opts.provider.get();
        if (!provider) {
          outcome = {
            ok: false,
            code: 'no_key',
            message: 'no decision-provider key is stored in the vault',
          };
        } else {
          providerName = provider.name;
          const result = await provider.decide({
            state,
            questions: call.questions,
            timeoutMs: opts.timeoutMs,
            signal: call.signal,
          });
          if (result.ok) {
            inputTokens = result.usage.inputTokens;
            outcome = {
              ok: true,
              answers: result.answers,
              model: result.model,
              latencyMs: now() - started,
              calibrated: provider.calibrated,
              costUsd: estimateCost(result.model, {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
              }).costUsd,
            };
          } else {
            outcome = result;
          }
        }
      }
    } catch (err) {
      outcome = {
        ok: false,
        code: 'unavailable',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (opts.recorder) {
      try {
        opts.recorder.recordDecisionToolCall({
          provider: providerName,
          ...(outcome.ok ? { model: outcome.model } : {}),
          latencyMs: outcome.ok ? outcome.latencyMs : now() - started,
          inputTokens,
          questionCount,
          outcome: outcome.ok ? 'ok' : outcome.code,
          estimatedCostUsd: outcome.ok ? outcome.costUsd : 0,
          ...(call.personalityId !== undefined ? { personalityId: call.personalityId } : {}),
          ...(call.sessionId !== undefined ? { sessionId: call.sessionId } : {}),
        });
      } catch {
        // Observability is fail-open: a broken recorder must not change the answer.
      }
    }
    return outcome;
  };
}
