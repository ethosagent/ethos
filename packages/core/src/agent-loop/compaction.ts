import type {
  ContextEngineLLMHandle,
  ContextEngineRegistry,
  ContextEngineStore,
  LLMProvider,
  Message,
  PersonalityConfig,
  SessionStore,
  Storage,
} from '@ethosagent/types';
import { estimateMessagesTokens, estimateTokens } from '../context-engines/token-estimator';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';

export interface CompactionDeps {
  llm: LLMProvider;
  contextEngines: ContextEngineRegistry;
  session: SessionStore;
  observability?: AgentLoopObservability;
  /** Context-engine LLM handle — preferred over engine-constructor injection. */
  llmHandle?: ContextEngineLLMHandle;
  /** Raw storage + dataDir for building a per-personality ContextEngineStore. */
  storage?: Storage;
  dataDir?: string;
  /** Framework-owned, model-pinned token counter. */
  countTokens?: (messages: Message[]) => Promise<number>;
}

// ---------------------------------------------------------------------------
// E4 — pre-LLM compaction. Resolves the personality's context engine and
// calls into it when estimated context usage exceeds the pressure
// threshold (80% of the model's window). When the personality declares no
// engine, we still resolve to `drop_oldest` — but the engine is only
// *invoked* when there is real pressure, so static configs see no change.
// ---------------------------------------------------------------------------
export async function maybeCompact(
  deps: CompactionDeps,
  messages: Message[],
  systemPrompt: string,
  personality: PersonalityConfig,
  sessionMetadata: {
    sessionId: string;
    sessionKey: string;
    turnNumber: number;
    lastCompactionTurn: number;
  },
): Promise<{
  messages: Message[];
  cacheBreakpoints?: number[];
  notice?: { engineName: string; droppedCount: number; summaryTokens: number };
}> {
  const window = deps.llm.maxContextTokens || 200_000;
  const target = Math.floor(window * 0.7);
  const pressureGate = Math.floor(window * 0.8);
  const current = estimateTokens(systemPrompt) + estimateMessagesTokens(messages);
  if (current <= pressureGate) return { messages };

  // Q2 — anti-thrashing cooldown. After a compaction, skip the next few
  // turns of *normal* pressure: re-compacting immediately would summarize the
  // summary, degrading meaning. `lastCompactionTurn === 0` means "never
  // compacted" — the first compaction is always allowed through. The cooldown
  // is bypassed under hard overflow (>95% of the window): its job is to
  // prevent summary churn, not to disable context-limit protection.
  const cooldownTurns = 5;
  const hardOverflowGate = Math.floor(window * 0.95);
  const inCooldown =
    sessionMetadata.lastCompactionTurn > 0 &&
    sessionMetadata.turnNumber - sessionMetadata.lastCompactionTurn < cooldownTurns;
  if (inCooldown && current <= hardOverflowGate) {
    return { messages };
  }

  const engineName = personality.context_engine ?? 'drop_oldest';
  const engine = deps.contextEngines.get(engineName) ?? deps.contextEngines.get('drop_oldest');
  if (!engine) return { messages };

  // Build a per-personality ContextEngineStore when raw storage is available.
  let store: ContextEngineStore | undefined;
  const stStorage = deps.storage;
  const stDataDir = deps.dataDir;
  if (stStorage && stDataDir) {
    const basePath = `${stDataDir}/compaction/${personality.id}`;
    store = {
      read: (key) => stStorage.read(`${basePath}/${key}`),
      write: (key, value) => stStorage.write(`${basePath}/${key}`, value),
      list: () => stStorage.list(basePath),
    };
  }

  try {
    const startedAt = Date.now();
    const result = await engine.compact({
      messages,
      currentSystem: systemPrompt,
      targetTokens: target,
      personality,
      sessionMetadata,
      ...(deps.llmHandle ? { llm: deps.llmHandle } : {}),
      ...(store ? { store } : {}),
      ...(deps.countTokens ? { countTokens: deps.countTokens } : {}),
    });
    const durationMs = Date.now() - startedAt;
    deps.observability?.recordCompaction({
      code: 'context_compacted',
      cause: `${engine.name}: ${result.notes}`,
    });
    // F3 — persist the compaction event so the session stays auditable. The
    // original messages remain in `messages`; this row only records the
    // LLM-facing replay change. Best-effort: a persistence failure must not
    // break the turn, so it never propagates to the fail-open catch below.
    const changed = result.messages.length !== messages.length || result.summaryText !== undefined;
    const summaryTokens = result.summaryText ? estimateTokens(result.summaryText) : 0;
    if (changed) {
      try {
        await deps.session.recordCompression({
          sessionId: sessionMetadata.sessionId,
          engineName: engine.name,
          originalCount: messages.length,
          keptCount: result.messages.length,
          ...(result.summaryText !== undefined ? { summaryText: result.summaryText } : {}),
          summaryTokens,
          preTotalTokens: current,
          postTotalTokens: estimateTokens(systemPrompt) + estimateMessagesTokens(result.messages),
          durationMs,
        });
        await deps.session.updateUsage(sessionMetadata.sessionId, { compactionCount: 1 });
        // Q2 — mark this turn so the cooldown suppresses the next few turns.
        await deps.session.recordCompactionTurn(
          sessionMetadata.sessionId,
          sessionMetadata.turnNumber,
        );
      } catch (persistErr) {
        deps.observability?.recordCompaction({
          severity: 'warn',
          code: 'compaction_persist_failed',
          cause: persistErr instanceof Error ? persistErr.message : String(persistErr),
        });
      }
    }
    // F2 — forward the engine's stable cache breakpoints to the provider so
    // the prompt cache survives compaction. Only meaningful when the engine
    // actually compacted; a no-op return carries no breakpoints.
    // V1 — `notice` lets the caller surface a one-line in-chat compaction
    // notice; only set when the engine actually changed the history.
    return {
      messages: result.messages,
      ...(changed && result.cacheBreakpoints ? { cacheBreakpoints: result.cacheBreakpoints } : {}),
      ...(changed
        ? {
            notice: {
              engineName: engine.name,
              droppedCount: messages.length - result.messages.length,
              summaryTokens,
            },
          }
        : {}),
    };
  } catch (err) {
    // Fail open — better to send the un-compacted history and let the
    // provider error than to silently drop messages on engine failure.
    deps.observability?.recordCompaction({
      severity: 'warn',
      code: 'context_engine_failed',
      cause: err instanceof Error ? err.message : String(err),
    });
    return { messages };
  }
}
