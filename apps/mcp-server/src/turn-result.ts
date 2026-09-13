// One place where an `AgentLoop.run()` turn becomes an MCP tool result.
//
// Two rules live here, and both were bugs before:
//
//  1. The `error` and `halt` AgentEvents are NOT dropped. A refused turn
//     (`BUDGET_EXCEEDED`, a watcher halt) used to arrive as an empty success —
//     the caller saw `""` and no way to tell a silent model from a refusal.
//  2. The iterator is drained to exhaustion. `done` is the answer, not the end
//     of the turn: breaking early skips `runTurnComplete`, the turn-end memory
//     flush and auto-compaction (CLAUDE.md, "Two lifecycle rules").
//
// Shared on purpose: the global console's `ask_personality` and the
// personality MCP export both collect a turn the same way.

import type { AgentEvent } from '@ethosagent/core';
import { answerSuffix } from '@ethosagent/types';

/** Why a turn did not produce a plain answer. */
export interface TurnFailure {
  /** The `error` event's own code, or `HALT_BUDGET` / `HALT_WATCHER` for a halt. */
  code: string;
  message: string;
}

export interface TurnResult {
  text: string;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * The turn's observability trace id, from the `run_start` event (the first
   * event of a turn) — `undefined` when no observability is wired, never `''`.
   *
   * Here because the MCP export's audit entries carry it (Part 3, "Audit"):
   * the `mcp.export.call` event is metadata only, so the trace id is the ONLY
   * handle joining a refused or expensive external call to what the turn
   * actually did in `observability.db`.
   */
  traceId?: string;
  /** Present when the turn carried an `error` or `halt` event. First one wins. */
  error?: TurnFailure;
}

/**
 * Consume a turn's events into a single result.
 *
 * A `halt` is an early safety stop that a normal `done` still follows, so the
 * partial text is kept alongside the failure — the caller decides how much of
 * it to show.
 */
export async function collectTurnResult(events: AsyncIterable<AgentEvent>): Promise<TurnResult> {
  let text = '';
  let turnCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let error: TurnFailure | undefined;
  let traceId: string | undefined;

  for await (const event of events) {
    switch (event.type) {
      case 'run_start':
        traceId = event.traceId;
        break;
      case 'text_delta':
        text += event.text;
        break;
      case 'usage':
        inputTokens += event.inputTokens;
        outputTokens += event.outputTokens;
        break;
      case 'error':
        error ??= { code: event.code, message: event.error };
        break;
      case 'halt':
        error ??= {
          code: `HALT_${event.kind.toUpperCase()}`,
          message: `${event.message} (rule: ${event.rule})`,
        };
        break;
      case 'done':
        // A `returnDirect` tool's answer arrives only as `done.text`, after any
        // preamble that streamed: `answerSuffix` (@ethosagent/types) is what the
        // stream still owes — the caller gets the whole reply, not one half.
        text += answerSuffix(text, event.text);
        turnCount = event.turnCount;
        break;
      default:
        break;
    }
  }

  return {
    text,
    turnCount,
    inputTokens,
    outputTokens,
    ...(traceId ? { traceId } : {}),
    ...(error ? { error } : {}),
  };
}
