import { RETURNED_DIRECT_TOOL_RESULT, type SessionStore, type ToolResult } from '@ethosagent/types';
import { EMPTY_ASSISTANT_TEXT } from '../history';
import { capIngestedResult } from '../ingestion-cap';

/**
 * Persist the tail of a turn a `returnDirect` tool answered, and return the
 * answer the caller must yield as `done.text`.
 *
 * Rows written: one tool_result per call in the batch — rejected, executed, or
 * lost by the registry — then the answer as an assistant row. The answering
 * call's tool_result is `RETURNED_DIRECT_TOOL_RESULT` (@ethosagent/types), not
 * its value: the assistant row is the one copy — storing it in both doubled it
 * in every later request, and the tool_result copy sits outside tool-result
 * aging. Only what is PERSISTED changes — the live
 * `tool_end` still carries the value. Every tool_use keeps its tool_result.
 *
 * The answer row is what makes the turn replayable. No LLM call writes a reply
 * on this path, so without it history ends at the tool_result: a surface that
 * rebuilds the transcript from the session store (web chat after a reload) has
 * no answer to show, and the next turn's request runs tool_result → user with
 * the reply the user actually saw missing. With it the stored shape is the
 * ordinary tool_use → tool_result → assistant(text) of any tool-using turn.
 *
 * A blank value answers with {@link EMPTY_ASSISTANT_TEXT}: a blank assistant
 * row mid-history is a request Anthropic rejects. The returned answer is the
 * persisted row's exact text — the web replay defense (`finaliseTurn` in
 * apps/web/src/lib/chat-reducer.ts) matches the live turn against it by text.
 * Pinned by __tests__/return-direct-history.test.ts.
 */
export async function persistReturnDirect(
  session: SessionStore,
  turn: { sessionId: string; traceId: string | undefined; resultBudgetChars: number },
  calls: ReadonlyArray<{ toolCallId: string; name: string; rejected?: string }>,
  results: ReadonlyMap<string, { result: ToolResult }>,
  direct: { toolCallId: string; value: string },
): Promise<string> {
  for (const p of calls) {
    const result: ToolResult = p.rejected
      ? { ok: false, error: p.rejected, code: 'execution_failed' }
      : (results.get(p.toolCallId)?.result ?? {
          ok: false,
          error: 'Tool result missing',
          code: 'execution_failed',
        });
    const content =
      p.toolCallId === direct.toolCallId
        ? RETURNED_DIRECT_TOOL_RESULT
        : // Lane 1(c) — same ingestion cap as processTools' main persist path.
          capIngestedResult(result.ok ? result.value : result.error, turn.resultBudgetChars);
    await session.appendMessage({
      sessionId: turn.sessionId,
      role: 'tool_result',
      content,
      toolCallId: p.toolCallId,
      toolName: p.name,
      traceId: turn.traceId,
      isError: !result.ok,
    });
  }
  const answer = direct.value.trim() ? direct.value : EMPTY_ASSISTANT_TEXT;
  await session.appendMessage({
    sessionId: turn.sessionId,
    role: 'assistant',
    content: answer,
    traceId: turn.traceId,
  });
  return answer;
}
