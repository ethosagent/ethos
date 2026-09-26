// R10 (openclaw-9.6-gaps) — the context engine's own deadline, shared by
// `maybeCompact` (./compaction) and the overflow path's `emergencyCompact`
// (./overflow). Its own module so compaction.ts stays under the helper-size
// guardrail (packages/core/src/__tests__/guardrails.test.ts).

import type {
  ContextEngine,
  ContextEngineCompactInput,
  ContextEngineCompactOutput,
} from '@ethosagent/types';

/**
 * R10 — the compaction summarizer's own deadline. Without it a stalled
 * summarizer held the turn (and its gateway lane) until the provider's 20-min
 * `DEFAULT_STREAMING_TIMEOUT_MS`. Two minutes is well past a healthy summary
 * pass and far below that.
 */
export const DEFAULT_COMPACTION_TIMEOUT_MS = 120_000;

/** Thrown by {@link compactWithTimeout} when the engine outlives its deadline. */
export class CompactionTimeoutError extends Error {
  constructor(engineName: string, ms: number) {
    super(`context engine "${engineName}" did not finish within ${ms}ms — compaction abandoned`);
    this.name = 'CompactionTimeoutError';
  }
}

/**
 * Run `engine.compact` with a deadline. At the deadline the returned promise
 * rejects with {@link CompactionTimeoutError}; the engine's eventual result is
 * discarded, so nothing it computes after that is persisted or replayed. Used
 * by `maybeCompact` and the overflow path's `emergencyCompact`.
 */
export async function compactWithTimeout(
  engine: ContextEngine,
  input: ContextEngineCompactInput,
  ms: number = DEFAULT_COMPACTION_TIMEOUT_MS,
): Promise<ContextEngineCompactOutput> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CompactionTimeoutError(engine.name, ms)), ms);
  });
  try {
    return await Promise.race([engine.compact(input), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `engine` with {@link compactWithTimeout}'s deadline on `compact`. A timeout
 * rejects like any engine failure, so `maybeCompact`'s fail-open catch keeps
 * the turn's un-compacted history (pinned by
 * packages/core/src/__tests__/compaction-summarizer-timeout.test.ts).
 */
export function withCompactionDeadline(
  engine: ContextEngine,
  ms: number = DEFAULT_COMPACTION_TIMEOUT_MS,
): Pick<ContextEngine, 'compact'> {
  return { compact: (input) => compactWithTimeout(engine, input, ms) };
}

/** The observability code for a failed compaction: a timeout is named as one. */
export function compactionFailureCode(err: unknown): string {
  return err instanceof CompactionTimeoutError
    ? 'context_engine_timed_out'
    : 'context_engine_failed';
}
