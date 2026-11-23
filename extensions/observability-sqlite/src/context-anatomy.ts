// Phase 0 — per-session context anatomy. Aggregates `llm_call` spans (and
// ONLY those) into a per-section token breakdown plus a cache-hit rate.
//
// Deliberately reads a single store (observability.db spans) so the numbers
// can never double-count against the sessions.db message rows. The section
// breakdown (system / tools / messages) reflects the MOST RECENT llm_call —
// i.e. the size of the context as it stands now — while the cache-hit rate is
// aggregated across every call in the session.

import type { Span } from '@ethosagent/types';

export interface ContextAnatomy {
  /** System-prompt tokens on the most recent llm_call. */
  system: number;
  /** Tool-schema tokens on the most recent llm_call. */
  tools: number;
  /** Message-history tokens on the most recent llm_call. */
  messages: number;
  /** system + tools + messages of the most recent llm_call. This is the context
   *  meter's numerator: the provider-measured prompt, which stays correct across
   *  providers whose `inputTokens` include cached tokens (Codex, xAI) and those
   *  whose do not (Anthropic), unlike any input+cache sum. */
  total: number;
  /** Fresh (non-cached) input tokens on the most recent llm_call. */
  inputTokens: number;
  /** Cache-read input tokens on the most recent llm_call. */
  cacheReadTokens: number;
  /** Cache-hit rate across the session in [0,1] — cache reads as a fraction of
   *  all input tokens (fresh + cache-read + cache-creation). */
  cacheHitRate: number;
  /** Number of llm_call spans aggregated. */
  llmCallCount: number;
  /** Approximate memory tokens inside `system` (by character share); 0 on legacy spans. */
  memory: number;
  /** Approximate skills tokens inside `system` (by character share); 0 on legacy spans. */
  skills: number;
  /** Model window the latest call ran against; null when its span predates the meter. */
  contextWindow: number | null;
  /** Token count at which auto-compaction fires; null when absent from the latest span. */
  compactAtTokens: number | null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A window or gate of 0 or less is meaningless; treat it as absent. */
function positiveOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  return n !== null && n > 0 ? n : null;
}

const num = (v: unknown): number => numOrNull(v) ?? 0;

function sections(attrs: Record<string, unknown> | undefined): { memory: number; skills: number } {
  const v = attrs?.systemSections;
  if (typeof v !== 'object' || v === null) return { memory: 0, skills: 0 };
  return { memory: num(Reflect.get(v, 'memory')), skills: num(Reflect.get(v, 'skills')) };
}

function requestSlice(attrs: Record<string, unknown> | undefined): {
  system: number;
  tools: number;
  messages: number;
} | null {
  const rt = attrs?.requestTokens;
  if (!rt || typeof rt !== 'object') return null;
  const r = rt as Record<string, unknown>;
  return { system: num(r.system), tools: num(r.tools), messages: num(r.messages) };
}

/**
 * Aggregate `llm_call` spans into a context anatomy. Returns `null` when the
 * session has no llm_call spans (or none carry token attributes).
 */
export function computeContextAnatomy(spans: Span[]): ContextAnatomy | null {
  const calls = spans.filter((s) => s.kind === 'llm_call').sort((a, b) => a.startTs - b.startTs);
  if (calls.length === 0) return null;

  // Aggregate cache stats across the whole session.
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  // Section breakdown: most recent call that carries a requestTokens slice.
  let latestSlice: { system: number; tools: number; messages: number } | null = null;
  let latestInput = 0;
  let latestCacheRead = 0;
  let latestAttrs: Record<string, unknown> | undefined;

  for (const span of calls) {
    const attrs = span.attrs;
    totalInput += num(attrs?.inputTokens);
    totalCacheRead += num(attrs?.cacheReadTokens);
    totalCacheCreation += num(attrs?.cacheCreationTokens);
    const slice = requestSlice(attrs);
    if (slice) {
      latestSlice = slice;
      latestInput = num(attrs?.inputTokens);
      latestCacheRead = num(attrs?.cacheReadTokens);
      latestAttrs = attrs;
    }
  }

  if (!latestSlice) return null;

  const cacheDenom = totalInput + totalCacheRead + totalCacheCreation;
  const cacheHitRate = cacheDenom > 0 ? totalCacheRead / cacheDenom : 0;

  return {
    system: latestSlice.system,
    tools: latestSlice.tools,
    messages: latestSlice.messages,
    total: latestSlice.system + latestSlice.tools + latestSlice.messages,
    inputTokens: latestInput,
    cacheReadTokens: latestCacheRead,
    cacheHitRate,
    llmCallCount: calls.length,
    ...sections(latestAttrs),
    contextWindow: positiveOrNull(latestAttrs?.contextWindow),
    compactAtTokens: positiveOrNull(latestAttrs?.compactAtTokens),
  };
}
