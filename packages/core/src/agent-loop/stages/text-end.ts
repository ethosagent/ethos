import type { AgentEvent, Message, SessionStore, SteerSink } from '@ethosagent/types';
import type { AgentLoopObservability } from '../../observability/agent-loop-observability';
import { EMPTY_ASSISTANT_TEXT } from '../history';
import { emptyCompletionError, MAX_TOKENS_REPLY_NOTICE } from '../output-cap';
import { foldTextEndSteers, type SteerVision } from '../steer';
import type { StepFinishReason } from './stream-step';
import { flushTurnUsage, type TurnUsageAccumulator } from './turn-finalizer';

export interface TextEndDeps {
  session: SessionStore;
  observability?: AgentLoopObservability;
  turnUsage: TurnUsageAccumulator;
}

export interface TextEndContext {
  sessionId: string;
  traceId: string | undefined;
  steerSink: SteerSink | undefined;
  steerVision: SteerVision;
  llmMessages: Message[];
  /** No fold after an abort. */
  abortSignal: AbortSignal;
  /** The turn's reply so far. */
  fullText: string;
  /** Tool calls this turn has made so far (`TurnBudgetCounters.totalToolCalls`). */
  toolCalls: number;
}

/**
 * What the loop does after a call that ended in text with no tool call:
 *   - `continue` — a steer was folded in (UBP-001 / D1); run one more call;
 *   - `return` — the whole turn produced no reply text (UBP-020) AND either the
 *     output cap cut it off or no tool ran; an `error` with code
 *     `empty_completion` was yielded in place of a blank `done`;
 *   - `break` — the answer is final; the finalizer yields `done`.
 * A reply the output cap cut off gets a `_loop` notice first (UBP-033).
 * A turn that did its work through tools and then stopped without a word is a
 * success and ends with a blank `done` (V-CP-1): the dream executor, delegate_task
 * and the goal runner treat `error` as failure; the gateway turns a blank `done`
 * into EMPTY_REPLY_NOTICE.
 *
 * Pinned by __tests__/steer-text-end.test.ts, __tests__/output-cap.test.ts and
 * __tests__/silent-tool-turn.test.ts.
 */
export async function* settleTextEnd(
  deps: TextEndDeps,
  step: { chunkText: string; finishReason: StepFinishReason | undefined },
  ctx: TextEndContext,
  /** No iteration is left after this one (`AgentLoop.maxIterations`). */
  lastIteration: boolean,
): AsyncGenerator<AgentEvent, { next: 'continue' | 'return' | 'break'; fullText: string }> {
  let fullText = ctx.fullText;
  if (step.finishReason === 'max_tokens' && step.chunkText.trim()) {
    yield {
      type: 'tool_progress',
      toolName: '_loop',
      message: MAX_TOKENS_REPLY_NOTICE,
      audience: 'user',
    };
  }

  // A steer that arrived while this answer streamed was acked as folded into
  // it. Never on the last allowed iteration or after an abort — the steer then
  // stays queued for the surface to report. The next iteration's top re-checks
  // abort, the watcher and the budgets.
  const answerIdx = ctx.llmMessages.length - 1;
  if (
    ctx.steerSink &&
    !ctx.abortSignal.aborted &&
    !lastIteration &&
    (await foldTextEndSteers(
      deps.session,
      ctx.sessionId,
      ctx.traceId,
      ctx.steerSink,
      ctx.llmMessages,
      ctx.steerVision,
    ))
  ) {
    const answer = ctx.llmMessages[answerIdx];
    // No longer the final message, so it may not be blank (EMPTY_ASSISTANT_TEXT).
    if (
      answer?.role === 'assistant' &&
      typeof answer.content === 'string' &&
      !answer.content.trim()
    ) {
      answer.content = EMPTY_ASSISTANT_TEXT;
    }
    // One reply: the streamed deltas and `done.text` stay the same string.
    if (fullText.trim() && !fullText.endsWith('\n\n')) {
      const sep = fullText.endsWith('\n') ? '\n' : '\n\n';
      fullText += sep;
      yield { type: 'text_delta', text: sep };
    }
    return { next: 'continue', fullText };
  }

  // A turn with no reply text and no error would reach the surface as a blank
  // `done` and deliver nothing — a failure when the cap cut the answer off or
  // the model did nothing at all. Silence after tool work is a normal end.
  if (!fullText.trim() && (step.finishReason === 'max_tokens' || ctx.toolCalls === 0)) {
    await flushTurnUsage(deps.session, ctx.sessionId, deps.turnUsage, deps.observability);
    yield { type: 'error', ...emptyCompletionError(step.finishReason) };
    if (ctx.traceId) {
      deps.observability?.endTrace(ctx.traceId, 'error');
      deps.observability?.flush();
    }
    return { next: 'return', fullText };
  }
  return { next: 'break', fullText };
}
