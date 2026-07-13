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
import {
  estimateMessagesChars,
  estimateMessagesTokens,
  estimateTokens,
} from '../context-engines/token-estimator';
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
  /**
   * T3 — max output tokens the pending completion may generate. Reserved from
   * the window before computing pressure so the *response* can't push the
   * request past the context limit. Defaults to `DEFAULT_OUTPUT_RESERVE_TOKENS`
   * when the caller didn't set a completion budget.
   */
  reservedOutputTokens?: number;
  /**
   * §5 — pressure gate as a fraction of the window in (0,1]. Compaction fires
   * when estimated usage exceeds this. Defaults to 0.8 when unset. Resolved
   * upstream as: per-model profile > global `compaction:` config > this default.
   */
  pressure?: number;
  /**
   * §5 — target usage as a fraction of the window in (0,1]; compaction shrinks
   * toward it. Defaults to 0.7 when unset. Same precedence as `pressure`.
   */
  target?: number;
  /**
   * §5 — per-model gate estimator divisor (chars per token). When set, the gate
   * computes usage as `chars / charsPerToken` INSTEAD of char/4 and does NOT
   * apply the small-window safety factor (this is the accurate per-model value —
   * inflating it would double-count). Absent → char/4 + small-window factor.
   */
  charsPerToken?: number;
}

// T3 — gate-hardening constants (generic, no per-model config).
/**
 * Output-token headroom reserved when the caller doesn't specify a completion
 * budget. Keeps the pending response from pushing the request past the window.
 */
const DEFAULT_OUTPUT_RESERVE_TOKENS = 4_096;
/**
 * Windows at or below this size get a conservative estimate inflation: char/4
 * undershoots real local tokenizers (~3.3–3.8 char/tok, worse on dense code)
 * by ~15%, and overflowing a small window is fatal. Large (Anthropic-class)
 * windows are left effectively unchanged — the factor only bites here.
 */
const SMALL_WINDOW_THRESHOLD = 16_000;
const SMALL_WINDOW_SAFETY_FACTOR = 1.15;

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
  const rawWindow = deps.llm.maxContextTokens || 200_000;

  // T3.1 — reserve headroom for the pending completion's output. The next
  // provider call generates up to `maxTokens`; gating on input alone lets the
  // *response* push the request past the window. Subtract the output reserve
  // from the window before computing pressure. Never reserve more than half the
  // window, else no input ever fits on a tiny local window.
  const requestedOutput = deps.reservedOutputTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  const outputReserve = Math.min(Math.max(0, requestedOutput), Math.floor(rawWindow / 2));
  const window = rawWindow - outputReserve;

  // §5 — effective gate/target fractions. Resolved upstream (per-model profile >
  // global config); the hardcoded 0.8/0.7 defaults live here so an unset caller
  // is byte-identical to before.
  const pressureFraction = deps.pressure ?? 0.8;
  const targetFraction = deps.target ?? 0.7;
  const target = Math.floor(window * targetFraction);
  const pressureGate = Math.floor(window * pressureFraction);

  // §5 — usage estimate. When the model carries an accurate `charsPerToken`,
  // divide the true char total by it and skip the small-window safety factor
  // (stacking the generic factor on an already-accurate divisor would
  // double-count). Otherwise keep the char/4 estimate + small-window factor.
  let current: number;
  const charsPerToken = deps.charsPerToken;
  if (charsPerToken !== undefined) {
    current = Math.ceil((systemPrompt.length + estimateMessagesChars(messages)) / charsPerToken);
  } else {
    // T3.2 — conservative safety factor for small windows (see constant docs).
    const safetyFactor = rawWindow <= SMALL_WINDOW_THRESHOLD ? SMALL_WINDOW_SAFETY_FACTOR : 1;
    current = Math.ceil(
      (estimateTokens(systemPrompt) + estimateMessagesTokens(messages)) * safetyFactor,
    );
  }
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
