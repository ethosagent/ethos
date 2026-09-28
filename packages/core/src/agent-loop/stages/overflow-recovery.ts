import type { AgentEvent, Message, PersonalityConfig, SessionStore } from '@ethosagent/types';
import type { AgentLoopObservability } from '../../observability/agent-loop-observability';
import { applyOverflowRetry, overflowErrorEvent } from '../overflow';
import type { LoopDeps } from '../turn-context';
import { flushTurnUsage, type TurnUsageAccumulator } from './turn-finalizer';

export interface OverflowRecoveryDeps
  extends Pick<LoopDeps, 'llm' | 'contextEngines' | 'llmHandle' | 'compaction'> {
  session: SessionStore;
  observability?: AgentLoopObservability;
  turnUsage: TurnUsageAccumulator;
}

export interface OverflowRecoveryContext {
  sessionId: string;
  sessionKey: string;
  traceId: string | undefined;
  turnNumber: number;
  lastCompactionTurn: number;
  serverCompaction?: { active: boolean };
  systemPrompt: string;
  personality: PersonalityConfig;
  llmMessages: Message[];
  /** The loop iteration that overflowed. */
  iteration: number;
  /**
   * The iteration the last retry was spent on. One compact-and-retry per
   * iteration: a retry that overflows again on the same iteration surfaces the
   * error, but a LATER iteration — the turn made progress since, e.g. another
   * tool batch landed (UBP-021) — may retry again. Updated here.
   */
  lastRetry: { iteration: number };
}

/**
 * Phase 3 — a context-overflow rejection is recoverable (the assistant message
 * was NOT persisted): compact the in-memory history and retry. Returns `true`
 * when `llmMessages` was shrunk in place and the caller should re-run the
 * iteration; otherwise the turn's usage is flushed, the overflow `error` is
 * yielded and `false` tells the caller to return.
 *
 * Pinned by __tests__/overflow-retry-notice.test.ts and
 * __tests__/overflow-current-turn.test.ts.
 */
export async function* recoverFromOverflow(
  deps: OverflowRecoveryDeps,
  ctx: OverflowRecoveryContext,
  providerError: string,
): AsyncGenerator<AgentEvent, boolean> {
  const canRetry =
    ctx.lastRetry.iteration !== ctx.iteration && deps.compaction?.retryOnOverflow !== false;
  ctx.lastRetry.iteration = ctx.iteration;
  const meta = {
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    turnNumber: ctx.turnNumber,
    lastCompactionTurn: ctx.lastCompactionTurn,
    ...(ctx.serverCompaction ? { serverCompaction: ctx.serverCompaction } : {}),
  };
  const retry = canRetry
    ? await applyOverflowRetry(deps, ctx.llmMessages, ctx.systemPrompt, ctx.personality, meta)
    : { retried: false };
  if (retry.retried) {
    // A4 — the compact-and-retry is user-visible work, not silence.
    // `_loop` is a reserved name (DefaultToolRegistry.register refuses
    // `_`-prefixed tools), so renderers can key on it for notice style.
    yield {
      type: 'tool_progress',
      toolName: '_loop',
      message: 'context overflow — compacting and retrying',
      audience: 'user',
    };
    return true;
  }
  await flushTurnUsage(deps.session, ctx.sessionId, deps.turnUsage, deps.observability);
  yield { type: 'error', ...overflowErrorEvent(retry, providerError, deps.compaction) };
  if (ctx.traceId) {
    deps.observability?.endTrace(ctx.traceId, 'error');
    deps.observability?.flush();
  }
  return false;
}
