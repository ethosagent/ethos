// FW-9 — Steer sink interface.
//
// Surfaces (CLI REPL, gateway slash dispatchers) push user-typed text while
// the agent is mid-turn. AgentLoop drains the sink at two seams and folds each
// entry in as a `[USER STEER]: <text>` text block:
//   - the tool seam (between tool_results landing and the next LLM call), on
//     the user message that carries the tool_results (`processTools`,
//     packages/core/src/agent-loop/stages/tool-processing.ts);
//   - the text-end seam (the model answered with text and no tool call), as a
//     user message of its own, followed by one more LLM call so the answer the
//     user is waiting for takes the steer in (UBP-001 / D1,
//     `foldTextEndSteers` in packages/core/src/agent-loop/steer.ts).
// Both seams persist each entry as a `user_steer` row.

import type { MessageContent } from './llm';

/** A native attachment a steer carries: the same image/document blocks a
 *  user message sends inline (`MessageContent` in ./llm). */
export type SteerAttachmentBlock = Extract<MessageContent, { type: 'image' | 'document' }>;

/**
 * UBP-012 — one steer with the attachments it came with. A surface whose
 * mid-turn message carried an image or PDF pushes it with
 * {@link SteerSink.pushEntry} so the bytes reach the model instead of only a
 * text placeholder. A block the turn's model cannot read is degraded to a text
 * line naming it at the drain (`steerContentBlocks`,
 * packages/core/src/agent-loop/steer.ts). Audio has no block: the surface
 * transcribes it into `text` before pushing.
 */
export interface SteerEntry {
  text: string;
  blocks?: SteerAttachmentBlock[];
}

export interface SteerSink {
  /** Append a steer entry. Returns false if the sink is closed/full. */
  push(text: string): boolean;
  /**
   * UBP-012 — append a steer with attachment blocks. Optional: a sink without
   * it takes text only. Same queue as {@link push}, same false-when-full rule.
   */
  pushEntry?(entry: SteerEntry): boolean;
  /** Atomically remove and return everything currently queued. */
  drain(): string[];
  /**
   * UBP-012 — atomically remove and return everything queued WITH its blocks,
   * in push order. AgentLoop prefers this over {@link drain} when present
   * (`drainSteerEntries`, packages/core/src/agent-loop/steer.ts); a sink that
   * implements {@link pushEntry} must implement this too, or the blocks are
   * lost at the drain.
   */
  drainEntries?(): SteerEntry[];
  /** Number of entries currently queued. */
  depth(): number;
}
