// Extraction (§3.1 step 2) — one cheap LLM call per eligible turn. Pure and
// injectable: it takes an LLMProvider and returns parsed facts, touching no
// Storage. Output is restricted to `add` on MEMORY.md / USER.md.

import type { LLMProvider } from '@ethosagent/types';
import type { CaptureFact } from './types';

/**
 * Hard cap on a single extracted FACT. The fact is free-form, attacker-
 * influenceable text that lands in USER.md / MEMORY.md and persists through the
 * 90-day dedup window, so an unbounded fact is a memory-pollution vector.
 * Truncate to bound the blast radius; a real durable fact fits comfortably.
 */
const MAX_FACT_CHARS = 240;

const SYSTEM_PROMPT =
  'You extract durable facts from a single conversation turn for long-term memory. ' +
  'Record only DURABLE facts about the user (identity, preferences, relationships, ' +
  'stable circumstances) or long-running project state. IGNORE chit-chat, transient ' +
  'requests, questions, and anything already obvious. If there is nothing durable, ' +
  'output exactly the single word NONE.\n\n' +
  'Otherwise output one fact per line, no prose, in this exact pipe format:\n' +
  'STORE|IMPORTANCE|FACT\n' +
  'where STORE is USER (facts about the person) or MEMORY (project/context facts), ' +
  'IMPORTANCE is a number 0.0–1.0, and FACT is a terse single sentence. Example:\n' +
  'USER|0.8|Has a daughter named Priya, born 2019.\n' +
  'MEMORY|0.5|Working on the Q3 launch, deadline mid-September.';

export interface ExtractionInput {
  initialPrompt: string;
  finalText: string;
}

/**
 * Ask the auxiliary model for durable facts. Returns `[]` for chit-chat, a
 * malformed response, or any provider error surfaced by the caller. Never
 * throws for parse reasons — an unparseable line is dropped.
 */
export async function extractFacts(
  input: ExtractionInput,
  llm: LLMProvider,
): Promise<CaptureFact[]> {
  const userContent = [
    '## User message',
    input.initialPrompt,
    '',
    '## Assistant response',
    input.finalText,
    '',
    'Extract durable facts (or NONE).',
  ].join('\n');

  let text = '';
  for await (const chunk of llm.complete([{ role: 'user', content: userContent }], [], {
    system: SYSTEM_PROMPT,
    maxTokens: 512,
    temperature: 0,
  })) {
    if (chunk.type === 'text_delta') text += chunk.text;
  }

  return parseFacts(text);
}

/** Parse `STORE|IMPORTANCE|FACT` lines; drop anything malformed. */
export function parseFacts(text: string): CaptureFact[] {
  const trimmed = text.trim();
  if (trimmed.length === 0 || /^none\.?$/i.test(trimmed)) return [];

  const facts: CaptureFact[] = [];
  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const parts = line.split('|');
    if (parts.length < 3) continue;

    const storeRaw = (parts[0] ?? '').trim().toLowerCase();
    const store = storeRaw === 'user' ? 'user' : storeRaw === 'memory' ? 'memory' : null;
    if (!store) continue;

    const hint = clamp01(Number.parseFloat((parts[1] ?? '').trim()));
    if (hint === null) continue;

    // FACT may itself contain `|`; rejoin the tail.
    const factText = parts.slice(2).join('|').trim();
    if (factText.length === 0) continue;
    // Cap length to bound the memory-pollution blast radius (see MAX_FACT_CHARS).
    const capped = factText.length > MAX_FACT_CHARS ? factText.slice(0, MAX_FACT_CHARS) : factText;

    facts.push({ store, text: capped, hint });
  }
  return facts;
}

function clamp01(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
