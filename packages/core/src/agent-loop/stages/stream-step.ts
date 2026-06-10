import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  HookRegistry,
  LLMProvider,
  Message,
  MessageContent,
  ModelTierName,
  PersonalityConfig,
  PersonalityObservabilityConfig,
  RequestDumpStore,
  SessionStore,
  ToolFilterOpts,
  ToolRegistry,
} from '@ethosagent/types';
import type { AgentLoopObservability } from '../../observability/agent-loop-observability';
import { handleChunk } from '../chunk-handler';
import type { WatcherTap } from '../turn-context';
import { resolveModelWithTier } from '../turn-context';

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
  streamingTimeoutMs: number;
  modelRouting: Record<string, string>;
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
  allowedPlugins: string[];
  allowedTools: string[] | undefined;
  filterOpts: ToolFilterOpts;
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
  };
}

// ---------------------------------------------------------------------------
// streamStep — one LLM streaming call
// ---------------------------------------------------------------------------

export async function* streamStep(
  deps: StreamStepDeps,
  ctx: StreamStepContext,
  pendingTierEscalation: { value?: string },
): AsyncGenerator<AgentEvent, StreamStepResult> {
  // Compute tool definitions once for hooks, LLM call, and dump store.
  const toolDefs = deps.tools.toDefinitions(ctx.allowedTools, ctx.filterOpts);
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
  }> = [];
  let chunkText = '';
  let fullTextDelta = '';

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
  let iterModelOverride = ctx.modelOverride;
  if (pendingTierEscalation.value && typeof ctx.personality.model === 'object') {
    const tier = pendingTierEscalation.value as ModelTierName;
    pendingTierEscalation.value = undefined;
    const { model: tierModel } = resolveModelWithTier(
      ctx.personality,
      tier,
      deps.modelRouting,
      deps.llm.name,
      deps.llm.model,
    );
    iterModelOverride = tierModel !== deps.llm.model ? tierModel : undefined;
    deps.observability?.recordTierEscalation({
      traceId: ctx.traceId ?? '',
      from: ctx.activeTier,
      to: tier,
      reason: 'tool_escalation',
      personalityId: ctx.personality.id,
    });
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
  const llmStartTs = Date.now();

  try {
    armWatchdog();
    const stream = deps.llm.complete(ctx.llmMessages, toolDefs, {
      system: ctx.systemPrompt,
      cacheSystemPrompt: true,
      abortSignal: combinedSignal,
      ...(iterModelOverride ? { modelOverride: iterModelOverride } : {}),
      ...(ctx.cacheBreakpoints ? { cacheBreakpoints: ctx.cacheBreakpoints } : {}),
      ...(ctx.opts.temperature !== undefined ? { temperature: ctx.opts.temperature } : {}),
      ...(ctx.opts.topP !== undefined ? { topP: ctx.opts.topP } : {}),
      ...(ctx.opts.maxCompletionTokens !== undefined
        ? { maxTokens: ctx.opts.maxCompletionTokens }
        : {}),
      ...(ctx.opts.seed !== undefined ? { seed: ctx.opts.seed } : {}),
    });

    for await (const chunk of stream) {
      if (ctx.abortSignal.aborted) break;
      if (watchdogController.signal.aborted) break;
      armWatchdog();
      if (chunk.type === 'done') llmFinishReason = chunk.finishReason;
      if (chunk.type === 'usage') {
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
    deps.observability?.endSpan(llmSpanId ?? '', 'ok', {
      inputTokens: llmInputTokens,
      outputTokens: llmOutputTokens,
    });

    if (watchdogController.signal.aborted && !ctx.abortSignal.aborted) {
      deps.observability?.endTrace(ctx.traceId ?? '', 'error');
      deps.observability?.flush();
      yield {
        type: 'error',
        error: `LLM stream stalled — no chunk for ${watchdogMs}ms`,
        code: 'streaming_timeout',
      };
      return { outcome: 'fatal' };
    }
  } catch (err) {
    disarmWatchdog();
    deps.observability?.endSpan(llmSpanId ?? '', 'error');
    if (watchdogController.signal.aborted && !ctx.abortSignal.aborted) {
      deps.observability?.endTrace(ctx.traceId ?? '', 'error');
      deps.observability?.flush();
      yield {
        type: 'error',
        error: `LLM stream stalled — no chunk for ${watchdogMs}ms`,
        code: 'streaming_timeout',
      };
      return { outcome: 'fatal' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    deps.observability?.endTrace(ctx.traceId ?? '', 'error');
    deps.observability?.flush();
    yield { type: 'error', error: msg, code: 'llm_error' };
    return { outcome: 'fatal' };
  }

  const usageSink: UsageSink = { llmInputTokens, llmOutputTokens };

  // Determine which tool calls completed parsing
  const completedToolCalls = pendingToolCalls.filter(
    (tc): tc is typeof tc & { args: unknown } => tc.args !== undefined,
  );

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
        input: tc.args,
      })),
    }),
  });

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
      requestId,
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
    if (chunkText) assistantContent.push({ type: 'text', text: chunkText });
    for (const tc of completedToolCalls) {
      assistantContent.push({
        type: 'tool_use',
        id: tc.toolCallId,
        name: tc.toolName,
        input: tc.args,
      });
    }
    ctx.llmMessages.push({ role: 'assistant', content: assistantContent });
    return { outcome: 'tool-calls', completedToolCalls, chunkText, fullTextDelta, usageSink };
  }

  ctx.llmMessages.push({ role: 'assistant', content: chunkText });
  return { outcome: 'text-end', chunkText, fullTextDelta, usageSink };
}
