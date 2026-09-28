// UBP-020 / UBP-033 — what the loop says when a call stops without a usable
// answer: the output token cap cut it off (`finishReason: 'max_tokens'`), or
// the model produced no text at all. Consumed by agent-loop.ts (the text-end
// branch) and stages/stream-step.ts (a tool call cut off at the cap).

import type { StepFinishReason } from './stages/stream-step';

/** Error code of a turn that ended with no reply text and no other error. An
 *  `error` AgentEvent code, not a new variant (frozen union). */
export const EMPTY_COMPLETION_CODE = 'empty_completion';

/** `_loop` progress line (audience 'user') after a reply cut off at the cap. */
export const MAX_TOKENS_REPLY_NOTICE =
  '⚠ reply cut off — the model reached its output token limit before finishing';

/**
 * The rejection a tool call gets when the cap cut its arguments off. Replaces
 * the generic "malformed tool arguments" text so the model splits the work
 * instead of re-sending the same oversized call.
 */
export const MAX_TOKENS_TOOL_REJECTION =
  'output token limit reached before this tool call was complete — its arguments were cut off, ' +
  'so it did not run. Split the content into smaller calls (e.g. write the file in parts).';

/**
 * At a `max_tokens` stop the last tool call's arguments were cut off. Whatever
 * did not parse strictly (a repair of truncated JSON would run the tool on half
 * its content) or never closed is rejected with {@link MAX_TOKENS_TOOL_REJECTION}
 * in place of "malformed tool arguments". A call whose JSON parsed strictly was
 * complete and still runs. Called by `streamStep` (stages/stream-step.ts).
 */
export function rejectCutOffToolCalls(
  calls: Array<{ args?: unknown; parseError?: string; repair?: { outcome: string } }>,
): void {
  for (const tc of calls) {
    if (tc.args !== undefined && tc.repair === undefined) continue;
    tc.args = undefined;
    tc.parseError = MAX_TOKENS_TOOL_REJECTION;
  }
}

/** The `error` event for a turn whose whole answer is empty. */
export function emptyCompletionError(finishReason: StepFinishReason | undefined): {
  error: string;
  code: string;
} {
  return {
    error:
      finishReason === 'max_tokens'
        ? 'The model reached its output token limit before writing any reply.'
        : 'The model finished without writing a reply.',
    code: EMPTY_COMPLETION_CODE,
  };
}
