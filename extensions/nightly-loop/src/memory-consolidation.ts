// Memory consolidation (Phase 3c) — distils a personality's long-term memory.
//
// consolidateMemory() makes a single LLM call that reads the current
// MEMORY.md and USER.md plus the day's raw interaction context and produces
// dense, durable rewrites. It is pure and injectable: it touches no Storage
// and never calls sync() itself — it returns the distilled text, and
// buildConsolidationUpdates() turns that into the MemoryUpdate[] the
// orchestrator applies. This keeps the module trivially testable.
//
// Phase M3 extends the SAME single call to also (a) emit both files as
// lightly-structured `### <slug>` sections and (b) score each section 0–1 by
// importance. The slug + score ride out on ConsolidationResult (internal to
// this extension — no frozen contract touched); the decay planner in
// ./memory-decay consumes them.

import type { LLMProvider, MemoryUpdate } from '@ethosagent/types';

export interface ConsolidationInput {
  /** Current MEMORY.md content ('' if empty). */
  memory: string;
  /** Current USER.md content ('' if empty). */
  user: string;
  /** The day's raw accumulated turn context (digest). */
  recentContext: string;
}

/** One distilled section with its model-assigned importance (M3, §4.1). */
export interface ScoredSection {
  /** Stable lowercase-hyphen identity chosen by the model, kept across passes. */
  slug: string;
  /** Section body (the text under the `### <slug>` heading), trimmed. */
  content: string;
  /** Importance in [0,1]. Defaults to 0.5 when the model omits a score. */
  score: number;
}

export interface ConsolidationResult {
  /** Distilled MEMORY.md (with `### <slug>` headings when the model structured it). */
  memory: string;
  /** Distilled USER.md. */
  user: string;
  /** Parsed MEMORY.md sections + scores. Empty when the output was unstructured. */
  memorySections?: ScoredSection[];
  /** Parsed USER.md sections + scores. */
  userSections?: ScoredSection[];
  /**
   * True only when a SCORES block was parsed AND at least one section was
   * found. The decay planner runs only when this is true — a malformed /
   * unstructured response degrades to "no decay this pass" (§4.3).
   */
  scored?: boolean;
}

const SYSTEM_PROMPT =
  'You consolidate a personality’s long-term memory. ' +
  'Given the current MEMORY.md (rolling project context) and USER.md (durable user profile) ' +
  "plus the day's raw interaction context, produce DENSE, DURABLE summaries — " +
  'keep durable facts, drop transient chatter, do not invent. ' +
  'Personality-scoped: never mix in other personalities. ' +
  'Organise BOTH files into short sections, each under a `### <slug>` heading. ' +
  'A slug is a short lowercase-hyphen identifier (e.g. `daughter-priya`, `project-ethos`); ' +
  'REUSE the same slug for the same topic across runs so it stays stable. ' +
  'When a newer fact REPLACES an older one, keep only the newer section and drop the ' +
  'stale/contradicted one (a superseded fact is a candidate for `ethos memory supersede`); ' +
  'never keep two sections that contradict each other. ' +
  'Render recurring proper nouns — people, projects, places — as `[[wikilinks]]` ' +
  '(e.g. `[[Priya]]`, `[[Project Ethos]]`) so entities cross-link. ' +
  'Then rate each section from 0.0 to 1.0 by how durable and important it is ' +
  '(1.0 = crown-jewel identity, 0.0 = passing trivia). ' +
  'Output exactly three labelled blocks and nothing else:\n' +
  'MEMORY:\n### <slug>\n<content>\n\nUSER:\n### <slug>\n<content>\n\nSCORES:\n<slug>: <score>';

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
    'Produce the consolidated MEMORY:, USER:, and SCORES: blocks.',
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

// Parse the `MEMORY:\n...\n\nUSER:\n...\n\nSCORES:\n...` convention tolerantly.
// A missing MEMORY/USER section falls back to the CURRENT content for that key,
// so a malformed response never blows away existing memory. When no SCORES
// block parses (or no `### slug` section is found) `scored` is false and the
// decay planner leaves memory untouched.
function parseConsolidation(text: string, input: ConsolidationInput): ConsolidationResult {
  const blocks = sliceLabeledBlocks(text);
  const memory = blocks.MEMORY !== null ? blocks.MEMORY.trim() : input.memory;
  const user = blocks.USER !== null ? blocks.USER.trim() : input.user;

  const scores = blocks.SCORES !== null ? parseScores(blocks.SCORES) : new Map<string, number>();
  const memorySections = parseSections(memory, scores);
  const userSections = parseSections(user, scores);
  const scored = scores.size > 0 && memorySections.length + userSections.length > 0;

  return { memory, user, memorySections, userSections, scored };
}

const BLOCK_LABELS = ['MEMORY', 'USER', 'SCORES'] as const;
type BlockLabel = (typeof BLOCK_LABELS)[number];

// Locate each top-level label and slice its body up to the next label (or end
// of text). Returns null for a label that is absent. Ordering-agnostic — the
// bodies are cut by label position, so USER never bleeds into a trailing
// SCORES block.
function sliceLabeledBlocks(text: string): Record<BlockLabel, string | null> {
  const found: Array<{ label: BlockLabel; start: number; bodyStart: number }> = [];
  for (const label of BLOCK_LABELS) {
    const re = new RegExp(`^\\s*${label}:`, 'm');
    const m = re.exec(text);
    if (m) found.push({ label, start: m.index, bodyStart: m.index + m[0].length });
  }
  found.sort((a, b) => a.start - b.start);

  const out: Record<BlockLabel, string | null> = { MEMORY: null, USER: null, SCORES: null };
  for (let i = 0; i < found.length; i++) {
    const cur = found[i];
    if (!cur) continue;
    const next = found[i + 1];
    out[cur.label] = text.slice(cur.bodyStart, next ? next.start : text.length);
  }
  return out;
}

// Parse `### <slug>` sections out of a block. The body is everything up to the
// next heading (or end). Scores are matched by slug; a section with no score
// defaults to 0.5 (mid) rather than being dropped.
function parseSections(text: string, scores: Map<string, number>): ScoredSection[] {
  const re = /^###\s+(.+?)\s*$/gm;
  const heads: Array<{ slug: string; headStart: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    heads.push({ slug: slugify(m[1] ?? ''), headStart: m.index, bodyStart: m.index + m[0].length });
    m = re.exec(text);
  }

  const sections: ScoredSection[] = [];
  for (let i = 0; i < heads.length; i++) {
    const cur = heads[i];
    if (!cur?.slug) continue;
    const next = heads[i + 1];
    const body = text.slice(cur.bodyStart, next ? next.headStart : text.length).trim();
    sections.push({ slug: cur.slug, content: body, score: scores.get(cur.slug) ?? 0.5 });
  }
  return sections;
}

// `<slug>: <number>` per line. Slugs are normalised so `Daughter Priya: 0.9`
// and `daughter-priya: 0.9` map to the same section.
function parseScores(block: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of block.split('\n')) {
    const m = /^\s*(.+?):\s*([0-9]*\.?[0-9]+)\s*$/.exec(line);
    if (!m) continue;
    const slug = slugify(m[1] ?? '');
    const val = Number(m[2]);
    if (slug && Number.isFinite(val)) map.set(slug, Math.max(0, Math.min(1, val)));
  }
  return map;
}

/** Normalise heading text to a stable lowercase-hyphen slug. */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build the sync updates for a personality scope from a consolidation result.
 *
 * Emits a `replace` for MEMORY.md / USER.md only when the distilled content is
 * non-empty AND differs from the current content. No-op keys are skipped, so a
 * re-run with an identical distillation yields `[]`, and an empty distillation
 * never destroys existing memory.
 *
 * This is the NO-DECAY fallback path (§4.3). The decay-aware path lives in
 * ./memory-decay's `planConsolidation`; the orchestrator picks between them
 * based on whether the result was `scored` and the meta deps are wired.
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
