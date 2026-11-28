// Extraction (§3.1 step 2) — one cheap LLM call per eligible turn. Pure and
// injectable: it takes an LLMProvider and returns parsed facts, touching no
// Storage. Output is restricted to `add` on MEMORY.md / USER.md.

import type { LLMProvider } from '@ethosagent/types';
import { z } from 'zod';
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

/**
 * Appended to the prompt ONLY when a `routeFact` router is configured, so with
 * no router the prompt is byte-identical to before the seam existed (pinned by
 * route-fact.test.ts "no routeFact → today's behaviour").
 */
const TRIPLE_PROMPT =
  '\n\nWhen a fact states a relationship between two named things (for example ' +
  '"Ravi owns billing-svc"), append a fourth field: a JSON object with subject, ' +
  'relation and object, for example:\n' +
  'MEMORY|0.8|Ravi owns billing-svc.|{"subject":"Ravi","relation":"owns","object":"billing-svc"}\n' +
  'Omit the fourth field for preferences and anything that is not such a relationship.';

const tripleZ = z.object({
  subject: z.string().trim().min(1).max(120),
  relation: z.string().trim().min(1).max(60),
  object: z.string().trim().min(1).max(120),
});

export interface ExtractionInput {
  initialPrompt: string;
  finalText: string;
  /** Ask for the optional subject/relation/object field (a `routeFact` is set). */
  withTriples?: boolean;
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
    system: input.withTriples ? SYSTEM_PROMPT + TRIPLE_PROMPT : SYSTEM_PROMPT,
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

    // FACT may itself contain `|`; rejoin the tail. An optional trailing JSON
    // triple (a fourth field) is split off only when it parses; otherwise the
    // line is read exactly as before.
    let tail = parts.slice(2);
    let triple: CaptureFact['triple'];
    if (tail.length >= 2) {
      const parsed = parseTriple(tail[tail.length - 1] ?? '');
      if (parsed) {
        triple = parsed;
        tail = tail.slice(0, -1);
      }
    }
    const factText = tail.join('|').trim();
    if (factText.length === 0) continue;
    // Cap length to bound the memory-pollution blast radius (see MAX_FACT_CHARS).
    const capped = factText.length > MAX_FACT_CHARS ? factText.slice(0, MAX_FACT_CHARS) : factText;

    facts.push({ store, text: capped, hint, ...(triple ? { triple } : {}) });
  }
  return facts;
}

function parseTriple(raw: string): CaptureFact['triple'] | undefined {
  const t = raw.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(t);
  } catch {
    return undefined; // not JSON: part of the fact text, as before
  }
  const r = tripleZ.safeParse(json);
  return r.success ? r.data : undefined;
}

function clamp01(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
