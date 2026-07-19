// context_compression F1 — the compression summarizer prompt.
//
// The summary is not "summarize this" — it is a structured handoff. It has to
// survive a long session: file paths, identifiers, and tool error strings are
// copied verbatim, never paraphrased, so the agent can still act on them after
// the middle of the conversation has been condensed.

import type { Message, MessageContent } from '@ethosagent/types';

// Chars-per-token heuristic — matches the framework's token estimator. Used
// only to enforce the summary length cap; exact accuracy is not required.
const CHARS_PER_TOKEN = 4;

export const SUMMARIZER_SYSTEM_PROMPT = `You are a context-compression summarizer. You are given the MIDDLE of a longer agent conversation — the opening turns and the most recent turns are kept verbatim and are NOT shown to you. Produce a dense, factual summary that lets the agent continue the task without the original middle messages.

Write the summary under these exact headings, in this order. Omit a heading only if it genuinely has no content.

## Open task / goal
What the user is ultimately trying to accomplish, in plain prose.

## Standing instructions
Bullet list of durable user directives that apply beyond a single turn — "always…", "never…", "from now on…", "going forward…", pinned notes. Copy each directive VERBATIM. Omit this heading only when there are none.

## Decisions made
Bullet list. Each bullet: the decision, then its rationale.

## Files touched
Bullet list of every file path that was read, written, or discussed. Copy each path CHARACTER-FOR-CHARACTER. Never paraphrase, shorten, or "tidy" a path.

## Identifiers introduced
Function names, variable names, type names, IDs, command names. Copy verbatim.

## Tool outcomes
For each meaningful tool call: what it did and whether it succeeded, failed, or was skipped. For failures, quote the error string VERBATIM.

## Open questions / blockers
Anything unresolved the agent still needs to handle.

Rules:
- Respond in the SAME LANGUAGE as the input. If the input mixes languages, preserve each part in its source language. Never translate code, file paths, identifiers, quoted user text, command lines, or URLs — copy them exactly.
- Be terse. No preamble, no "here is the summary", no closing remarks.
- Do not invent facts. If something is unclear in the input, say so under Open questions.`;

/**
 * Build the summarizer system prompt, optionally biased by `/compact <focus…>`
 * guidance. The focus directive is appended (not substituted) so the structured
 * headings and verbatim-preservation rules always apply.
 */
export function buildSummarizerSystemPrompt(instructions?: string): string {
  const focus = instructions?.trim();
  if (!focus) return SUMMARIZER_SYSTEM_PROMPT;
  return `${SUMMARIZER_SYSTEM_PROMPT}\n\n## Focus\nThe reader asked you to pay special attention to: ${focus}\nKeep detail relevant to that focus; you may compress the rest more aggressively, but never drop file paths, identifiers, or error strings.`;
}

/**
 * Serialize the middle messages into a single plain-text block for the
 * summarizer's user turn. Tool calls and tool results are rendered explicitly
 * so the summarizer can report tool outcomes accurately.
 */
export function renderMiddleForSummary(middle: Message[]): string {
  const parts: string[] = [];
  for (const msg of middle) {
    parts.push(`### ${msg.role}`);
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
      continue;
    }
    for (const block of msg.content) {
      parts.push(renderBlock(block));
    }
  }
  return parts.join('\n\n');
}

function renderBlock(block: MessageContent): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'tool_use') {
    return `[tool_use ${block.name}] ${JSON.stringify(block.input)}`;
  }
  if (block.type === 'tool_result') {
    const status = block.is_error ? 'error' : 'ok';
    return `[tool_result ${status}] ${block.content}`;
  }
  // image / document — opaque to the summariser; render as a typed placeholder
  // so the textual summary doesn't lose track of the attachment.
  return `[${block.type} ${block.mediaType}]`;
}

/**
 * Enforce the summary length cap. When the summary exceeds `targetTokens`,
 * truncate at the last sentence boundary that fits rather than mid-word, so
 * the persisted summary stays readable.
 */
export function capSummary(text: string, targetTokens: number): string {
  const maxChars = Math.max(1, targetTokens) * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;

  const head = text.slice(0, maxChars);
  // Last sentence-ending punctuation or newline within the budget.
  const boundary = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('! '),
    head.lastIndexOf('? '),
    head.lastIndexOf('\n'),
  );
  // Only honor the boundary if it keeps a meaningful chunk (>50% of budget),
  // otherwise a single long sentence would collapse the whole summary.
  if (boundary > maxChars * 0.5) {
    return `${head.slice(0, boundary + 1).trimEnd()}\n\n[summary truncated to fit budget]`;
  }
  return `${head.trimEnd()}\n\n[summary truncated to fit budget]`;
}
