// Memory consolidation (Phase 3c) — distils a personality's long-term memory.
//
// consolidateMemory() makes a single LLM call that reads the current
// MEMORY.md and USER.md plus the day's raw interaction context and produces
// dense, durable rewrites. It is pure and injectable: it touches no Storage
// and never calls sync() itself — it returns the distilled text, and
// buildConsolidationUpdates() turns that into the MemoryUpdate[] the
// orchestrator applies. This keeps the module trivially testable.

import type { LLMProvider, MemoryUpdate } from '@ethosagent/types';

export interface ConsolidationInput {
  /** Current MEMORY.md content ('' if empty). */
  memory: string;
  /** Current USER.md content ('' if empty). */
  user: string;
  /** The day's raw accumulated turn context (digest). */
  recentContext: string;
}

export interface ConsolidationResult {
  /** Distilled MEMORY.md. */
  memory: string;
  /** Distilled USER.md. */
  user: string;
}

const SYSTEM_PROMPT =
  'You consolidate a personality’s long-term memory. ' +
  'Given the current MEMORY.md (rolling project context) and USER.md (durable user profile) ' +
  "plus the day's raw interaction context, produce DENSE, DURABLE summaries — " +
  'keep durable facts, drop transient chatter, do not invent. ' +
  'Personality-scoped: never mix in other personalities. ' +
  'Output exactly two sections in this format and nothing else:\n' +
  'MEMORY:\n<distilled MEMORY.md>\n\nUSER:\n<distilled USER.md>';

export async function consolidateMemory(
  input: ConsolidationInput,
  llm: LLMProvider,
): Promise<ConsolidationResult> {
  const userContent = [
    '## Current MEMORY.md (rolling project context)',
    input.memory,
    '',
    '## Current USER.md (durable user profile)',
    input.user,
    '',
    "## Today's raw interaction context",
    input.recentContext,
    '',
    'Produce the consolidated MEMORY: and USER: sections.',
  ].join('\n');

  let text = '';
  for await (const chunk of llm.complete([{ role: 'user', content: userContent }], [], {
    system: SYSTEM_PROMPT,
    maxTokens: 2048,
    temperature: 0.2,
  })) {
    if (chunk.type === 'text_delta') text += chunk.text;
  }

  return parseConsolidation(text, input);
}

// Parse the `MEMORY:\n...\n\nUSER:\n...` convention tolerantly. A missing
// section falls back to the CURRENT content for that key, so a malformed
// response never blows away existing memory.
function parseConsolidation(text: string, input: ConsolidationInput): ConsolidationResult {
  const memorySection = extractSection(text, 'MEMORY', 'USER');
  const userSection = extractSection(text, 'USER', 'MEMORY');
  return {
    memory: memorySection !== null ? memorySection.trim() : input.memory,
    user: userSection !== null ? userSection.trim() : input.user,
  };
}

// Return the body following `<label>:` up to the next `<other>:` label (or
// end of text). Returns null if the label is absent.
function extractSection(text: string, label: string, otherLabel: string): string | null {
  const labelRe = new RegExp(`^\\s*${label}:`, 'm');
  const match = labelRe.exec(text);
  if (!match) return null;
  const bodyStart = match.index + match[0].length;
  const rest = text.slice(bodyStart);
  const otherRe = new RegExp(`^\\s*${otherLabel}:`, 'm');
  const otherMatch = otherRe.exec(rest);
  return otherMatch ? rest.slice(0, otherMatch.index) : rest;
}

/**
 * Build the sync updates for a personality scope from a consolidation result.
 *
 * Emits a `replace` for MEMORY.md / USER.md only when the distilled content is
 * non-empty AND differs from the current content. No-op keys are skipped, so a
 * re-run with an identical distillation yields `[]`, and an empty distillation
 * never destroys existing memory.
 */
export function buildConsolidationUpdates(
  current: { memory: string; user: string },
  next: ConsolidationResult,
): MemoryUpdate[] {
  const updates: MemoryUpdate[] = [];
  const memory = next.memory.trim();
  if (memory.length > 0 && memory !== current.memory) {
    updates.push({ action: 'replace', key: 'MEMORY.md', content: memory });
  }
  const user = next.user.trim();
  if (user.length > 0 && user !== current.user) {
    updates.push({ action: 'replace', key: 'USER.md', content: user });
  }
  return updates;
}
