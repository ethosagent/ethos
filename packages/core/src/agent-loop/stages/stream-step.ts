import { randomUUID } from 'node:crypto';
import {
  type AgentEvent,
  type CompactionEnvelope,
  compactionStoredRow,
  encodeCompactionEnvelope,
  type HookRegistry,
  type LLMProvider,
  type Message,
  type MessageContent,
  type ModelResolutionContext,
  type ModelTierName,
  type PersonalityConfig,
  type PersonalityObservabilityConfig,
  type RequestDumpStore,
  SERVER_COMPACTION_REJECTED_WARNING,
  type SessionStore,
  type ToolFilterOpts,
  type ToolRegistry,
} from '@ethosagent/types';
import type { AgentLoopObservability } from '../../observability/agent-loop-observability';
import { handleChunk } from '../chunk-handler';
import { currentTurnFitError, currentTurnStart } from '../compaction';
import { routeTurnModel } from '../model-route';
import { isContextOverflowError } from '../overflow';
import { composeDefinitions, type ToolLoadingState } from '../tool-loading';
import type { WatcherTap } from '../turn-context';
import { resolveTurnModel } from '../turn-model';
import type { TurnUsageAccumulator } from './turn-finalizer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageSink {
  llmInputTokens: number;
  llmOutputTokens: number;
}

export interface CompletedToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  // Set when the streamed arguments were unparseable and unrepairable. The
  // call still reaches tool-processing (so the tool_use gets a matching
  // tool_result) but is rejected there instead of executing with empty args.
  parseError?: string;
  // Set only when strict parse failed and a mechanical repair pass ran.
  // `outcome: 'repaired'` means `args` is the repaired object — tool-processing
  // validates it against the tool's `required` fields (§4) before executing,
  // since a repair signals the model produced malformed output.
  repair?: { outcome: 'repaired' | 'failed' };
}

export type StreamStepResult =
  | { outcome: 'text-end'; chunkText: string; fullTextDelta: string; usageSink: UsageSink }
  | {
      outcome: 'tool-calls';
      completedToolCalls: CompletedToolCall[];
      chunkText: string;
      fullTextDelta: string;
      usageSink: UsageSink;
    }
  // Phase 3 — the provider rejected the request for exceeding the context
  // window. No `error` event is emitted here so the orchestrator can
  // compact-and-retry; if the retry is disabled or already spent, the caller
  // surfaces a `context_overflow` error itself.
  | { outcome: 'overflow'; error: string }
  | { outcome: 'fatal' };

// ---------------------------------------------------------------------------
// Dependencies & context
// ---------------------------------------------------------------------------

export interface StreamStepDeps {
  llm: LLMProvider;
  tools: ToolRegistry;
  hooks: HookRegistry;
  session: SessionStore;
  observability?: AgentLoopObservability;
  requestDumpStore?: RequestDumpStore;
  sessionCosts: Map<string, number>;
  /** A1 — per-turn rollup accumulator, flushed by the turn finalizer. */
  turnUsage: TurnUsageAccumulator;
  streamingTimeoutMs: number;
  /** D7 — the same resolution context `setupTurn` used, so a mid-turn
   *  escalation re-resolves through the one resolver instead of a second rung
   *  order. */
  modelResolution: ModelResolutionContext;
}

export interface StreamStepContext {
  sessionId: string;
  sessionKey: string;
  personalityId: string;
  personality: PersonalityConfig;
  traceId: string | undefined;
  obsConfig: PersonalityObservabilityConfig | undefined;
  activeTier: ModelTierName;
  effectiveModel: string;
  modelOverride: string | undefined;
  providerEntry: import('@ethosagent/types').CompletionOptions['providerEntry'];
  /** Item 7 — `TurnSetup.serverCompaction`; cleared here when the provider
   *  reports `SERVER_COMPACTION_REJECTED_WARNING`. */
  serverCompaction?: { active: boolean };
  allowedPlugins: string[];
  allowedTools: string[] | undefined;
  filterOpts: ToolFilterOpts;
  /** reach-and-containment Part 1 — set only when on-demand tool loading is
   *  active for the turn (`TurnSetup.toolLoading`). */
  toolLoading?: ToolLoadingState;
  systemPrompt: string | undefined;
  llmMessages: Message[];
  cacheBreakpoints: number[] | undefined;
  abortSignal: AbortSignal;
  turnCount: number;
  watcherTap: WatcherTap;
  opts: {
    temperature?: number;
    topP?: number;
    maxCompletionTokens?: number;
    seed?: number;
    /** Provider-namespaced escape hatch (§7 carries topK/minP here). */
    providerOptions?: Record<string, Record<string, unknown>>;
  };
}

// ---------------------------------------------------------------------------
// Terminal-failure persistence
// ---------------------------------------------------------------------------

/**
 * Persist the partial assistant text produced before a TERMINAL stream failure
 * (stalled watchdog / provider error). Nothing retries those paths and the
 * orchestrator returns immediately on `outcome: 'fatal'`, so without this the
 * text lives only in the client's streaming buffer and vanishes as soon as the
 * next turn reloads history from the store.
 *
 * Text only — any tool calls still in flight never ran and never will, so their
 * `tool_use` blocks would be orphans in the replayed history. Dropping them is
 * the cheaper half of the Anthropic tool_use/tool_result contract.
 *
 * Deliberately NOT called on the recoverable `overflow` path: that one compacts
 * and retries, and needs the clean history it has always had.
 *
 * Empty (or whitespace-only) text is not persisted — an empty assistant turn is
 * noise, not context.
 */
async function persistInterruptedAssistant(
  session: SessionStore,
  sessionId: string,
  text: string,
  reason: string,
  traceId: string | undefined,
): Promise<void> {
  if (!text.trim()) return;
  // Provider error messages can be multi-KB (HTML error pages, JSON dumps) and
  // this marker replays into the next turn's context — keep it a label, not a
  // payload. The full message still reaches the client on the `error` event.
  const label = reason.length > 200 ? `${reason.slice(0, 200)}…` : reason;
  await session.appendMessage({
    sessionId,
    role: 'assistant',
    content: `${text}\n\n[interrupted — ${label}]`,
    traceId,
  });
}

// ---------------------------------------------------------------------------
// streamStep — one LLM streaming call
// ---------------------------------------------------------------------------

export async function* streamStep(
  deps: StreamStepDeps,
  ctx: StreamStepContext,
  pendingTierEscalation: { value?: string },
): AsyncGenerator<AgentEvent, StreamStepResult> {
  // Compute tool definitions once for hooks, LLM call, and dump store — so
  // observability measures exactly what was sent. With on-demand loading
  // active (C3) that is pinned + `tool_search` + loaded; otherwise unchanged.
  const toolDefs = ctx.toolLoading
    ? composeDefinitions(
        ctx.toolLoading.universe,
        ctx.toolLoading.plan,
        ctx.toolLoading.searchDefinition,
      )
    : deps.tools.toDefinitions(ctx.allowedTools, ctx.filterOpts);

  // Context-fit preflight, before the turn's first LLM call: when the static
  // prefix plus the user's message cannot fit the usable window, fail the turn
  // loudly instead of sending a request (`currentTurnFitError`). Later calls
  // carry this turn's tool results, which the overflow path owns.
  if (ctx.turnCount === 0) {
    const fitError = currentTurnFitError(
      {
        llm: deps.llm,
        ...(ctx.opts.maxCompletionTokens !== undefined
          ? { reservedOutputTokens: ctx.opts.maxCompletionTokens }
          : {}),
      },
      {
        systemPrompt: ctx.systemPrompt ?? '',
        toolSchemas: JSON.stringify(toolDefs),
        currentTurn: ctx.llmMessages.slice(currentTurnStart(ctx.llmMessages)),
      },
    );
    if (fitError) {
      deps.observability?.recordCompaction({
        ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
        severity: 'error',
        code: 'context_window_too_small',
        cause: fitError,
      });
      deps.observability?.endTrace(ctx.traceId ?? '', 'error');
      deps.observability?.flush();
      yield { type: 'error', error: fitError, code: 'context_window_too_small' };
      return { outcome: 'fatal' };
    }
  }
  const requestId = randomUUID();
  const includeContent = ctx.obsConfig?.storeLlmPayloads === 'full';

  // Fire before_llm_call — content only included when personality opts in
  await deps.hooks.fireVoid(
    'before_llm_call',
    {
      sessionId: ctx.sessionId,
      model: deps.llm.model,
      turnNumber: ctx.turnCount,
      requestId,
      ...(includeContent
        ? { system: ctx.systemPrompt, tools: toolDefs, messages: ctx.llmMessages }
        : {}),
    },
    ctx.allowedPlugins,
  );

  // Stream LLM response
  const pendingToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    partialJson: string;
    args?: unknown;
    parseError?: string;
    repair?: { outcome: 'repaired' | 'failed' };
  }> = [];
  let chunkText = '';
  let fullTextDelta = '';
  // Item 7 — server-side compaction blocks, persisted ahead of the reply.
  const compactions: CompactionEnvelope[] = [];

  // Streaming watchdog: cancel the stream if no chunk arrives within the
  // per-personality window. Reset every chunk so slow-but-progressing
  // reasoning is unaffected. See IMPROVEMENT.md P1-2 / OpenClaw #68596.
  const watchdogMs = ctx.personality.streamingTimeoutMs ?? deps.streamingTimeoutMs;
  const watchdogController = new AbortController();
  const combinedSignal = AbortSignal.any([ctx.abortSignal, watchdogController.signal]);
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => watchdogController.abort(), watchdogMs);
  };
  const disarmWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = undefined;
  };

  // Consume one-shot tier escalation from think_deeper tool result (run-local).
  //
  // D8/V10 — no `typeof ctx.personality.model === 'object'` gate: a personality
  // declaring a plain string (or a role, or nothing at all) escalates too. The
  // requested ROLE is what changes; which model answers it is the resolver's
  // business.
  let iterModelOverride = ctx.modelOverride;
  let iterProviderEntry = ctx.providerEntry;
  if (pendingTierEscalation.value) {
    const tier = pendingTierEscalation.value as ModelTierName;
    pendingTierEscalation.value = undefined;
    const escalated = resolveTurnModel({
      personality: ctx.personality,
      role: tier,
      ctx: deps.modelResolution,
      llmName: deps.llm.name,
      llmModel: deps.llm.model,
    });
    // A mid-turn refusal would abandon a turn that is already streaming and has
    // already been billed for its first iteration, so an unresolvable
    // escalation keeps the model the turn started on. The refusal belongs at
    // turn setup, where nothing has run yet (D6).
    // The same entry scoping turn setup applies (`routeTurnModel`); an
    // escalation to an entry this loop cannot reach keeps the turn's model.
    const route = escalated.ok
      ? routeTurnModel(deps.llm, escalated, deps.modelResolution)
      : undefined;
    if (route?.ok) {
      iterModelOverride = route.modelOverride;
      iterProviderEntry = route.providerEntry;
      deps.observability?.recordTierEscalation({
        traceId: ctx.traceId ?? '',
        from: ctx.activeTier,
        to: tier,
        reason: 'tool_escalation',
        personalityId: ctx.personality.id,
      });
    }
  }

  const llmSpanId = deps.observability?.startSpan({
    traceId: ctx.traceId ?? '',
    kind: 'llm_call',
    name: iterModelOverride ?? deps.llm.model ?? 'unknown',
  });
  let llmInputTokens = 0;
  let llmOutputTokens = 0;
  let llmCacheReadTokens = 0;
  let llmCacheCreationTokens = 0;
  let llmEstimatedCostUsd = 0;
  let llmRequestTokens: { system: number; tools: number; messages: number } | undefined;
  let llmFinishReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | undefined;
  // B2 — the provider's server-assigned id for this call, when it reports one.
  let providerRequestId: string | undefined;
  // Gap 3 — why `llmEstimatedCostUsd` is what it is, for the
  // `ethos_llm_unpriced_calls_total` counter (P2-counters). Not reported by
  // every transport yet, hence optional.
  let llmCostBasis: 'priced' | 'local' | 'unknown' | undefined;
  const llmStartTs = Date.now();

  try {
    armWatchdog();
    const stream = deps.llm.complete(ctx.llmMessages, toolDefs, {
      system: ctx.systemPrompt,
      cacheSystemPrompt: true,
      abortSignal: combinedSignal,
      // B2 — the client-minted id above goes outward where the provider
      // supports it (openai-compat: `X-Client-Request-Id`), so a provider-side
      // log line can be matched back to this call. Providers without a
      // client-id convention ignore it.
      requestId,
      ...(iterModelOverride ? { modelOverride: iterModelOverride } : {}),
      ...(iterProviderEntry ? { providerEntry: iterProviderEntry } : {}),
      ...(ctx.cacheBreakpoints ? { cacheBreakpoints: ctx.cacheBreakpoints } : {}),
      ...(ctx.opts.temperature !== undefined ? { temperature: ctx.opts.temperature } : {}),
      ...(ctx.opts.topP !== undefined ? { topP: ctx.opts.topP } : {}),
      ...(ctx.opts.maxCompletionTokens !== undefined
        ? { maxTokens: ctx.opts.maxCompletionTokens }
        : {}),
      ...(ctx.opts.seed !== undefined ? { seed: ctx.opts.seed } : {}),
      ...(ctx.opts.providerOptions ? { providerOptions: ctx.opts.providerOptions } : {}),
    });

    for await (const chunk of stream) {
      if (ctx.abortSignal.aborted) break;
      if (watchdogController.signal.aborted) break;
      armWatchdog();
      if (chunk.type === 'done') llmFinishReason = chunk.finishReason;
      if (chunk.type === 'compaction') compactions.push(chunk);
      if (chunk.type === 'warning' && chunk.message === SERVER_COMPACTION_REJECTED_WARNING) {
        // D32 failure mode — the API refused the edit and the provider retried
        // without it, so the local compactions left in this turn run.
        if (ctx.serverCompaction) ctx.serverCompaction.active = false;
        deps.observability?.recordCompaction({
          ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
          severity: 'warn',
          code: 'llm.server_compaction_rejected',
          cause: chunk.message,
        });
      }
      if (chunk.type === 'usage') {
        if (chunk.providerRequestId) providerRequestId = chunk.providerRequestId;
        if (chunk.costBasis) llmCostBasis = chunk.costBasis;
        llmCacheReadTokens += chunk.usage.cacheReadTokens;
        llmCacheCreationTokens += chunk.usage.cacheCreationTokens;
        llmEstimatedCostUsd += chunk.usage.estimatedCostUsd;
        if (chunk.usage.requestTokens) llmRequestTokens = chunk.usage.requestTokens;
      }
      for (const event of handleChunk(chunk, pendingToolCalls, (t) => {
        chunkText += t;
        fullTextDelta += t;
      })) {
        if (event.type === 'usage') {
          deps.sessionCosts.set(
            ctx.sessionKey,
            (deps.sessionCosts.get(ctx.sessionKey) ?? 0) + event.estimatedCostUsd,
          );
          llmInputTokens += event.inputTokens;
          llmOutputTokens += event.outputTokens;
          ctx.watcherTap.observe({
            type: 'usage',
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
          });
        }
        yield event;
      }
    }
    disarmWatchdog();
    // Phase 0 — persist the per-slice {system, tools, messages} breakdown and
    // cache stats onto the llm_call span so the context anatomy is attributable
    // to named sections. Best-effort: attrs merge into the span at close.
    deps.observability?.endSpan(llmSpanId ?? '', 'ok', {
      inputTokens: llmInputTokens,
      outputTokens: llmOutputTokens,
      cacheReadTokens: llmCacheReadTokens,
      cacheCreationTokens: llmCacheCreationTokens,
      // A2 — the span used to carry tokens but no money, so every cost
      // aggregate over `llm_call` spans read 0. This is the provider's own
      // reported cost (already summed off the usage chunks above), not a
      // re-derivation: core must not depend on @ethosagent/pricing.
      estimatedCostUsd: llmEstimatedCostUsd,
      // B2 — the two request ids, kept apart on purpose. `clientRequestId` is
      // ours (minted above, sent outbound); `providerRequestId` is the
      // server's, and it is the one a provider support ticket asks for.
      clientRequestId: requestId,
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(llmRequestTokens ? { requestTokens: llmRequestTokens } : {}),
      // Gap 2/3 (P2-counters) — `provider` and `costBasis` on the span so
      // Prometheus counters can be derived from spans alone, no re-derivation
      // through @ethosagent/pricing at read time.
      provider: deps.llm.name,
      ...(llmCostBasis ? { costBasis: llmCostBasis } : {}),
    });

    if (watchdogController.signal.aborted && !ctx.abortSignal.aborted) {
      deps.observability?.endTrace(ctx.traceId ?? '', 'error');
      deps.observability?.flush();
      // Persist before yielding — a consumer that stops iterating on the error
      // event closes the generator, and nothing after the yield would run.
      await persistInterruptedAssistant(
        deps.session,
        ctx.sessionId,
        chunkText,
        `LLM stream stalled after ${watchdogMs}ms`,
        ctx.traceId,
      );
      yield {
        type: 'error',
        error: `LLM stream stalled — no chunk for ${watchdogMs}ms`,
        code: 'streaming_timeout',
      };
      return { outcome: 'fatal' };
    }
  } catch (err) {
    disarmWatchdog();
    // B2 — a failed call is exactly the one an operator quotes in a support
    // ticket, so the ids go on the error span too. The usage/cost accumulator
    // locals are already populated from whatever chunks arrived before the
    // stream errored (Fix 4) — mirror the success-path attrs below so a
    // failed call after partial streaming doesn't lose its real token/cost
    // counts or get tagged `provider="unknown"` in the Prometheus counters.
    deps.observability?.endSpan(llmSpanId ?? '', 'error', {
      inputTokens: llmInputTokens,
      outputTokens: llmOutputTokens,
      cacheReadTokens: llmCacheReadTokens,
      cacheCreationTokens: llmCacheCreationTokens,
      estimatedCostUsd: llmEstimatedCostUsd,
      clientRequestId: requestId,
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(llmRequestTokens ? { requestTokens: llmRequestTokens } : {}),
      provider: deps.llm.name,
      ...(llmCostBasis ? { costBasis: llmCostBasis } : {}),
    });
    if (watchdogController.signal.aborted && !ctx.abortSignal.aborted) {
      deps.observability?.endTrace(ctx.traceId ?? '', 'error');
      deps.observability?.flush();
      await persistInterruptedAssistant(
        deps.session,
        ctx.sessionId,
        chunkText,
        `LLM stream stalled after ${watchdogMs}ms`,
        ctx.traceId,
      );
      yield {
        type: 'error',
        error: `LLM stream stalled — no chunk for ${watchdogMs}ms`,
        code: 'streaming_timeout',
      };
      return { outcome: 'fatal' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    // Phase 3 — a context-overflow rejection is recoverable: hand it back to the
    // orchestrator (no `error` event) so it can compact-and-retry. The assistant
    // message is deliberately NOT persisted on this path (unlike the terminal
    // failures above), so the retry starts from a clean history.
    if (isContextOverflowError(err)) {
      deps.observability?.recordCompaction({
        severity: 'warn',
        code: 'context_overflow_retry',
        cause: msg,
      });
      return { outcome: 'overflow', error: msg };
    }
    deps.observability?.endTrace(ctx.traceId ?? '', 'error');
    deps.observability?.flush();
    await persistInterruptedAssistant(deps.session, ctx.sessionId, chunkText, msg, ctx.traceId);
    yield { type: 'error', error: msg, code: 'llm_error' };
    return { outcome: 'fatal' };
  }

  const usageSink: UsageSink = { llmInputTokens, llmOutputTokens };

  // Record one observability event per tool-call repair attempt (§4). Only
  // fires when a strict parse failed and the repair pass ran — feeds the §9
  // per-model repair-rate metric.
  for (const tc of pendingToolCalls) {
    if (tc.repair) {
      deps.observability?.recordToolRepair?.({
        traceId: ctx.traceId,
        toolName: tc.toolName,
        outcome: tc.repair.outcome,
      });
    }
  }

  // Determine which tool calls completed parsing. Calls with a parse error are
  // kept — they still need a matching tool_result (rejected in tool-processing)
  // to satisfy the tool_use/tool_result contract; they never execute.
  const completedToolCalls = pendingToolCalls.filter(
    (tc): tc is typeof tc & { args: unknown } =>
      tc.args !== undefined || tc.parseError !== undefined,
  );

  // Item 7 (D31) — a server compaction block precedes the reply it came with,
  // and the API drops everything before it on the next request. Persisted as
  // its own structurally-marked assistant row (no SessionStore change) and
  // replayed in this turn's later iterations as an in-memory envelope, which
  // `toAnthropicMessages` (extensions/llm-anthropic) turns back into a block.
  for (const c of compactions) {
    // The ONE writer of a compaction row: structural marker + payload out of
    // `content` (`compactionStoredRow`, packages/types/src/llm.ts).
    await deps.session.appendMessage({
      sessionId: ctx.sessionId,
      role: 'assistant',
      ...compactionStoredRow(c),
      traceId: ctx.traceId,
    });
    ctx.llmMessages.push({ role: 'assistant', content: encodeCompactionEnvelope(c) });
    deps.observability?.recordCompaction({
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      code: 'llm.server_compacted',
      cause: c.content === null ? 'no summary (no-op block)' : `${c.content.length}-char summary`,
    });
  }

  // Persist assistant message — include tool_use references so history is LLM-replayable
  // Note: turnCount + 1 matches the original code where turnCount was already incremented
  await deps.session.appendMessage({
    sessionId: ctx.sessionId,
    role: 'assistant',
    content: chunkText,
    ...(completedToolCalls.length > 0 && {
      toolCalls: completedToolCalls.map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        // Malformed args are recorded as `{}` in the tool_use history block;
        // the call is rejected (not executed) in tool-processing.
        input: tc.args ?? {},
      })),
    }),
    // Phase 0 — fold this turn's actual usage into the same message-persist
    // transaction (columns already exist, previously always NULL). The gate's
    // actuals-first signal (Phase 1c) reads back the most recent assistant
    // message's `inputTokens`.
    usage: {
      inputTokens: llmInputTokens,
      outputTokens: llmOutputTokens,
      cacheReadTokens: llmCacheReadTokens,
      cacheCreationTokens: llmCacheCreationTokens,
      estimatedCostUsd: llmEstimatedCostUsd,
      ...(llmRequestTokens ? { requestTokens: llmRequestTokens } : {}),
    },
    // A3 — the turn's observability trace id, so this row joins to the trace
    // and its `llm_call` span in `observability.db`.
    traceId: ctx.traceId,
  });

  // A1 — mirror the row just written into the turn's rollup accumulator. Kept
  // adjacent to the append so the session's cached usage columns can only ever
  // reflect message rows that actually landed (analytics decision 9).
  deps.turnUsage.inputTokens += llmInputTokens;
  deps.turnUsage.outputTokens += llmOutputTokens;
  deps.turnUsage.cacheReadTokens += llmCacheReadTokens;
  deps.turnUsage.cacheCreationTokens += llmCacheCreationTokens;
  deps.turnUsage.estimatedCostUsd += llmEstimatedCostUsd;

  // Fire after_llm_call — content gated by personality observability config
  const llmDurationMs = Date.now() - llmStartTs;
  await deps.hooks.fireVoid(
    'after_llm_call',
    {
      sessionId: ctx.sessionId,
      text: chunkText,
      usage: {
        inputTokens: llmInputTokens,
        outputTokens: llmOutputTokens,
        ...(llmCacheReadTokens ? { cacheReadTokens: llmCacheReadTokens } : {}),
        ...(llmCacheCreationTokens ? { cacheCreationTokens: llmCacheCreationTokens } : {}),
        ...(llmEstimatedCostUsd ? { estimatedCostUsd: llmEstimatedCostUsd } : {}),
        ...(llmRequestTokens ? { requestTokens: llmRequestTokens } : {}),
      },
      requestId,
      finishReason: llmFinishReason,
      durationMs: llmDurationMs,
      ...(includeContent
        ? { system: ctx.systemPrompt, tools: toolDefs, messages: ctx.llmMessages }
        : {}),
    },
    ctx.allowedPlugins,
  );

  // Append to request dump store if wired (awaited for reliability).
  // Content fields only included when personality observability opts in.
  // turnNumber uses turnCount + 1 to match the original post-increment behavior.
  if (deps.requestDumpStore) {
    await deps.requestDumpStore.append({
      // B2 — `requestId` is the client-minted outbound id; `providerRequestId`
      // is the server-assigned one. Same pair as the `llm_call` span attrs.
      requestId,
      ...(providerRequestId ? { providerRequestId } : {}),
      timestamp: new Date().toISOString(),
      sessionId: ctx.sessionId,
      personalityId: ctx.personality.id,
      turnNumber: ctx.turnCount + 1,
      model: iterModelOverride ?? deps.llm.model,
      durationMs: llmDurationMs,
      requestTokens: llmRequestTokens,
      responseTokens: llmOutputTokens || undefined,
      cacheReadTokens: llmCacheReadTokens || undefined,
      cacheCreationTokens: llmCacheCreationTokens || undefined,
      estimatedCostUsd: llmEstimatedCostUsd || undefined,
      finishReason: llmFinishReason,
      ...(includeContent
        ? {
            system: ctx.systemPrompt,
            tools: toolDefs,
            messages: ctx.llmMessages,
            responseText: chunkText,
          }
        : {}),
    });
  }

  // Push assistant message with proper content blocks for next iteration
  if (completedToolCalls.length > 0) {
    const assistantContent: MessageContent[] = [];
    // Blank text is not a block a provider accepts (see EMPTY_ASSISTANT_TEXT).
    if (chunkText.trim()) assistantContent.push({ type: 'text', text: chunkText });
    for (const tc of completedToolCalls) {
      assistantContent.push({
        type: 'tool_use',
        id: tc.toolCallId,
        name: tc.toolName,
        input: tc.args ?? {},
      });
    }
    ctx.llmMessages.push({ role: 'assistant', content: assistantContent });
    return { outcome: 'tool-calls', completedToolCalls, chunkText, fullTextDelta, usageSink };
  }

  ctx.llmMessages.push({ role: 'assistant', content: chunkText });
  return { outcome: 'text-end', chunkText, fullTextDelta, usageSink };
}
