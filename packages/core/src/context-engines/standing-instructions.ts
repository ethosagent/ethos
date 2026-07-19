// Standing-instruction detection + carry-forward partitioning (context-economy
// Phase 2, plan §3.4). Compaction that loses durable user directives ("always
// reply in French", "never push to main") is a named community failure; engines
// that summarize a middle range use this module to pull directive-bearing user
// messages out of the summarized content and carry them forward VERBATIM.
//
// Per §3.4/R5: the heuristic is fuzzy by nature (multilingual, indirect
// phrasing) and only ADDS coverage — the explicit `[pin]` / `pin:` prefix is
// the deterministic fallback a user can always reach for.

import type { Message } from '@ethosagent/types';

/** Explicit user pin — deterministic, phrasing-independent. */
const PIN_PREFIX = /^\s*(\[pin\]|pin:)/i;

/** Imperative durable-scope markers — "this applies beyond the current turn". */
const DURABLE_SCOPE = /\b(always|never|from now on|going forward|every time|do not ever)\b/i;

/**
 * Length guard for the durable-scope heuristic: a real standing directive is a
 * short imperative sentence, while a multi-KB pasted document merely
 * *containing* "always" is content, not a directive. Messages longer than this
 * only qualify via the explicit `[pin]` / `pin:` prefix.
 */
const MAX_DIRECTIVE_CHARS = 500;

/**
 * Deterministic heuristic for durable user directives (plan §3.4.1):
 * - explicit pin — the text starts with `[pin]` or `pin:` (case-insensitive),
 *   any length; or
 * - imperative + durable scope — the text contains a durable-scope marker
 *   ("always", "never", "from now on", "going forward", "every time",
 *   "do not ever") AND is at most {@link MAX_DIRECTIVE_CHARS} chars.
 */
export function isStandingInstruction(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (PIN_PREFIX.test(trimmed)) return true;
  if (trimmed.length > MAX_DIRECTIVE_CHARS) return false;
  return DURABLE_SCOPE.test(trimmed);
}

/**
 * The plain text of a message for directive detection: string content as-is,
 * block content as the joined `text` blocks (tool results / images are never
 * directives).
 */
export function messageDirectiveText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export interface StandingInstructionPartition {
  /** Directive-bearing user messages to carry forward verbatim, in order —
   *  first occurrence per distinct text (deduped). */
  carried: Message[];
  /** Indices (within the input slice) of the carried messages. */
  carriedIndices: Set<number>;
  /** Everything else — the content the engine summarizes. Repeat occurrences
   *  of an already-carried directive stay here (redundant, safe to compact). */
  rest: Message[];
}

/**
 * Split a to-be-summarized message range into standing instructions (carried
 * verbatim ahead of the summary) and the rest (summarized as before).
 */
export function partitionStandingInstructions(messages: Message[]): StandingInstructionPartition {
  const carried: Message[] = [];
  const carriedIndices = new Set<number>();
  const rest: Message[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === 'user') {
      const text = messageDirectiveText(message).trim();
      if (text.length > 0 && isStandingInstruction(text) && !seen.has(text)) {
        seen.add(text);
        carried.push(message);
        carriedIndices.add(i);
        continue;
      }
    }
    rest.push(message);
  }

  return { carried, carriedIndices, rest };
}
