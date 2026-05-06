import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DOWNGRADE_REJECTION_MESSAGE,
  INJECTION_DEFENSE_PRELUDE,
  type InjectionClassifier,
  type InjectionVerdict,
  resolveDowngradedTools,
  shortPatternCheck,
  wrapUntrusted,
} from '@ethosagent/safety-injection';
import { ScopedStorage } from '@ethosagent/storage-fs';
import type {
  CompletionChunk,
  ContextInjector,
  HookRegistry,
  LLMProvider,
  MemoryProvider,
  Message,
  MessageContent,
  ObservabilityWriter,
  PersonalityConfig,
  PersonalityRegistry,
  PromptContext,
  SessionStore,
  Storage,
  StoredMessage,
  ToolFilterOpts,
  ToolRegistry,
  ToolResult,
} from '@ethosagent/types';

import { InMemorySessionStore } from './defaults/in-memory-session';
import { NoopMemoryProvider } from './defaults/noop-memory';
import { DefaultPersonalityRegistry } from './defaults/noop-personality';
import { DefaultHookRegistry } from './hook-registry';
import { DefaultToolRegistry } from './tool-registry';

// ---------------------------------------------------------------------------
// Agent events emitted by run()
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  // Phase 30.2 — `audience` gates whether channel adapters / chat.ts surface
  // this event to the user. Default is `'internal'`; tools opt in to `'user'`
  // per event. Framework-emitted budget warnings are `'user'` (see step 7).
  | {
      type: 'tool_progress';
      toolName: string;
      message: string;
      percent?: number;
      audience: 'internal' | 'user';
    }
  | {
      type: 'tool_end';
      toolCallId: string;
      toolName: string;
      ok: boolean;
      durationMs: number;
      // Phase 30.2 — same boundary applies to tool_end success rendering.
      // Failures (`ok: false`) ignore the field and always render.
      audience?: 'internal' | 'user';
      /**
       * Tool output body — the success value when `ok`, or the error
       * message when `ok: false`. Optional so consumers that only care
       * about the status (CLI ASCII chips, telemetry) can ignore it.
       * The web chip surfaces this on expand-on-click without a
       * follow-up history fetch.
       */
      result?: string;
    }
  | { type: 'usage'; inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  | { type: 'error'; error: string; code: string }
  | { type: 'done'; text: string; turnCount: number }
  // Emitted once after context injectors run; carries any metadata they wrote to PromptContext.meta.
  | { type: 'context_meta'; data: Record<string, unknown> }
  /**
   * Emitted once at the very start of each turn, before any LLM call.
   * Carries the resolved provider/model and the routing source so consumers
   * (TUI status bar, CLI verbose mode, telemetry) can show the effective model.
   * `source` reflects which routing rule selected the model (see model_update.md).
   */
  | {
      type: 'run_start';
      provider: string;
      model: string;
      source: 'team-coordinator' | 'team-personality' | 'personality' | 'global';
    };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  llm: LLMProvider;
  tools?: ToolRegistry;
  personalities?: PersonalityRegistry;
  memory?: MemoryProvider;
  session?: SessionStore;
  hooks?: HookRegistry;
  injectors?: ContextInjector[];
  /**
   * Maps each plugin-registered injector to its plugin id so AgentLoop can
   * gate injectors by personality. Built-in injectors are absent (always fire).
   * Populated by PluginApiImpl.registerInjector(); passed through from wiring.
   */
  injectorPluginIds?: Map<ContextInjector, string>;
  /**
   * Base Storage instance handed to tools via `ToolContext.storage` after
   * being decorated with a ScopedStorage that enforces the active
   * personality's `fs_reach` allowlist. When unset, ToolContext.storage is
   * left undefined and tools fall back to unrestricted node:fs (legacy
   * behavior — existing CLI/TUI tests don't need a storage instance).
   */
  storage?: Storage;
  /**
   * Absolute path to ~/.ethos/ used for `${ETHOS_HOME}` substitution in
   * `fs_reach` paths. Defaults to `${HOME}/.ethos`. Required only when
   * `storage` is set.
   */
  dataDir?: string;
  /**
   * Optional observability writer. When provided, AgentLoop records traces,
   * spans, and events for LLM calls, tool calls, and errors. When absent,
   * behaviour is identical to before — no observability writes occur.
   */
  observability?: ObservabilityWriter;
  /**
   * Ch.3c — Tier-2 LLM injection classifier. When provided, AgentLoop calls
   * it after wrapping any `outputIsUntrusted` tool result whose Tier-1
   * pattern check fired, whose content is > 500 chars, or when the active
   * personality's `safety.injectionDefense.classifier.alwaysCallLLM` is set.
   * When unset, only Tier-1 (regex) classification runs.
   */
  injectionClassifier?: InjectionClassifier;
  /**
   * Ch.6a — In-process watcher. When provided, AgentLoop forwards every
   * tool_start / tool_end / usage event into watcher.observe() and acts
   * on non-`allow` decisions:
   *   - `terminate` → yield an `error` event and end the turn
   *   - `pause`     → yield a user-visible `tool_progress` chip and end
   *                    the turn (the user's next message resumes; the
   *                    watcher's state is fresh per run via resetTurn())
   *   - `force_approval` → set a per-iteration flag that promotes the
   *                    next tool to requiresApproval (TODO — needs the
   *                    approval-hook plumbing; for v1 we treat it as
   *                    `pause` to fail safe)
   * `allow` is the no-op path. Watcher decisions are recorded as
   * `audit.watcher` events on the optional ObservabilityWriter.
   */
  watcher?: import('@ethosagent/safety-watcher').Watcher;
  // Maps personality ID → model ID. Resolution: modelRouting[id] → personality.model → llm.model
  modelRouting?: Record<string, string>;
  options?: {
    maxIterations?: number;
    historyLimit?: number;
    platform?: string;
    workingDir?: string;
    resultBudgetChars?: number;
    /**
     * Hard cap on total tool calls per user turn (across all LLM iterations).
     * Defaults to 20. Trips a `tool_progress` warning and exits cleanly.
     * See plan/IMPROVEMENT.md P1-3.
     */
    maxToolCallsPerTurn?: number;
    /**
     * Hard cap on the number of times the same tool name can be invoked in a
     * single turn. Catches the "infinite loop on a single tool" failure mode
     * (e.g. tts loop reported as OpenClaw #67744). Defaults to 5.
     */
    maxIdenticalToolCalls?: number;
    /**
     * Default streaming watchdog in milliseconds. If no chunk arrives from the
     * LLM within this window, the agent aborts the stream and emits an error.
     * Reset on every chunk. Personalities can override via
     * `personality.streamingTimeoutMs`. Defaults to 120000 (2 minutes).
     */
    streamingTimeoutMs?: number;
  };
}

export interface RunOptions {
  sessionKey?: string;
  personalityId?: string;
  abortSignal?: AbortSignal;
  /**
   * Identifier surfaced to tools as `ToolContext.agentId`. Delegation tools
   * use this to thread spawn depth (`depth:N`) into child loops so
   * `MAX_SPAWN_DEPTH` can be enforced across recursive sub-agent calls.
   */
  agentId?: string;
}

// ---------------------------------------------------------------------------
// AgentLoop
// ---------------------------------------------------------------------------

export class AgentLoop {
  private readonly llm: LLMProvider;
  private readonly tools: ToolRegistry;
  private readonly personalities: PersonalityRegistry;
  private readonly memory: MemoryProvider;
  private readonly session: SessionStore;
  /** Public so surfaces (web, ACP) can register late-binding hooks they own
   *  without re-running the whole wiring factory. The CLI/TUI register hooks
   *  before construction; web registers an approval hook after createAgentLoop
   *  returns. */
  readonly hooks: HookRegistry;
  private readonly injectors: ContextInjector[];
  private readonly injectorPluginIds: Map<ContextInjector, string>;
  private readonly maxIterations: number;
  private readonly historyLimit: number;
  private readonly platform: string;
  private readonly workingDir: string;
  private readonly resultBudgetChars: number;
  private readonly maxToolCallsPerTurn: number;
  private readonly maxIdenticalToolCalls: number;
  private readonly streamingTimeoutMs: number;
  private readonly modelRouting: Record<string, string>;
  private readonly storage?: Storage;
  private readonly dataDir?: string;
  private readonly observability?: ObservabilityWriter;
  private readonly injectionClassifier?: InjectionClassifier;
  private readonly watcher?: import('@ethosagent/safety-watcher').Watcher;
  /** Per-session accumulated spend in USD. Keyed by sessionKey. Reset via resetSessionCost(). */
  private readonly sessionCosts = new Map<string, number>();

  constructor(config: AgentLoopConfig) {
    this.llm = config.llm;
    this.tools = config.tools ?? new DefaultToolRegistry();
    this.personalities = config.personalities ?? new DefaultPersonalityRegistry();
    this.memory = config.memory ?? new NoopMemoryProvider();
    this.session = config.session ?? new InMemorySessionStore();
    this.hooks = config.hooks ?? new DefaultHookRegistry();
    this.injectors = (config.injectors ?? []).sort((a, b) => b.priority - a.priority);
    this.injectorPluginIds = config.injectorPluginIds ?? new Map();
    this.maxIterations = config.options?.maxIterations ?? 50;
    this.historyLimit = config.options?.historyLimit ?? 200;
    this.platform = config.options?.platform ?? 'cli';
    this.workingDir = config.options?.workingDir ?? process.cwd();
    this.resultBudgetChars = config.options?.resultBudgetChars ?? 80_000;
    this.maxToolCallsPerTurn = config.options?.maxToolCallsPerTurn ?? 20;
    this.maxIdenticalToolCalls = config.options?.maxIdenticalToolCalls ?? 5;
    this.streamingTimeoutMs = config.options?.streamingTimeoutMs ?? 120_000;
    this.modelRouting = config.modelRouting ?? {};
    if (config.storage) this.storage = config.storage;
    if (config.dataDir) this.dataDir = config.dataDir;
    if (config.observability) this.observability = config.observability;
    if (config.injectionClassifier) this.injectionClassifier = config.injectionClassifier;
    if (config.watcher) this.watcher = config.watcher;
  }

  /** Returns all available tools for inventory display (e.g. TUI splash screen). */
  getAvailableTools(): import('@ethosagent/types').Tool[] {
    return this.tools.getAvailable();
  }

  /** Returns all registered personalities for inventory display. */
  getPersonalityIds(): string[] {
    return this.personalities.list().map((p) => p.id);
  }

  /** Returns the budget cap for the given personality (undefined = no cap). */
  getPersonalityBudgetCap(personalityId?: string): number | undefined {
    const p =
      (personalityId ? this.personalities.get(personalityId) : null) ??
      this.personalities.getDefault();
    return p.budgetCapUsd;
  }

  /** Returns accumulated session spend in USD (0 if no spend recorded yet). */
  getSessionCost(sessionKey: string): number {
    return this.sessionCosts.get(sessionKey) ?? 0;
  }

  /** Resets the session spend counter — call after /new or /personality switch. */
  resetSessionCost(sessionKey: string): void {
    this.sessionCosts.delete(sessionKey);
  }

  async *run(text: string, opts: RunOptions = {}): AsyncGenerator<AgentEvent> {
    const abortSignal = opts.abortSignal ?? new AbortController().signal;
    const sessionKey = opts.sessionKey ?? `${this.platform}:default`;

    // Step 1: Resolve or create session
    const ethosSession =
      (await this.session.getSessionByKey(sessionKey)) ??
      (await this.session.createSession({
        key: sessionKey,
        platform: this.platform,
        model: this.llm.model,
        provider: this.llm.name,
        personalityId: opts.personalityId,
        workingDir: this.workingDir,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0,
          apiCallCount: 0,
          compactionCount: 0,
        },
      }));

    const sessionId = ethosSession.id;
    const personality =
      (opts.personalityId ? this.personalities.get(opts.personalityId) : null) ??
      this.personalities.getDefault();

    const obsConfig = personality?.safety?.observability;

    const traceId = this.observability?.startTrace({
      sessionId,
      kind: 'turn',
      personalityId: personality?.id,
      obsConfig,
    });

    // Budget cap check — refuse before any LLM work when the session has already
    // exceeded the personality's per-session spending limit.
    const currentSpend = this.sessionCosts.get(sessionKey) ?? 0;
    if (personality.budgetCapUsd != null && currentSpend >= personality.budgetCapUsd) {
      if (traceId) this.observability?.endTrace(traceId, 'error');
      this.observability?.flush();
      yield {
        type: 'error',
        error: `Budget cap of $${personality.budgetCapUsd.toFixed(2)} exceeded for this session ($${currentSpend.toFixed(4)} spent). Use /budget reset to start a new budget window.`,
        code: 'BUDGET_EXCEEDED',
      };
      yield { type: 'done', text: '', turnCount: 0 };
      return;
    }

    // Resolve effective model: explicit per-personality routing > LLM base model.
    // personality.model is intentionally skipped — those IDs are Anthropic-specific
    // and break non-Anthropic providers (OpenRouter, Gemini, Ollama, etc.).
    // Configure overrides via modelRouting in ~/.ethos/config.yaml instead.
    const personalityOverride = this.modelRouting[personality.id];
    const effectiveModel = personalityOverride ?? this.llm.model;
    const modelOverride = effectiveModel !== this.llm.model ? effectiveModel : undefined;

    // Phase 5: emit run_start trace so consumers (TUI, CLI verbose, telemetry)
    // can surface the resolved provider/model and routing source.
    yield {
      type: 'run_start',
      provider: this.llm.name,
      model: effectiveModel,
      source: personalityOverride ? 'personality' : 'global',
    };

    // Allowed tool names for this personality (undefined = no restriction)
    const allowedTools = personality.toolset?.length ? personality.toolset : undefined;
    // Per-personality plugin + MCP gate (default-deny: missing field = no access)
    const allowedPlugins = personality.plugins ?? [];
    const filterOpts: ToolFilterOpts = {
      allowedMcpServers: personality.mcp_servers ?? [],
      allowedPlugins,
    };

    // Step 2: Fire session_start hooks
    await this.hooks.fireVoid(
      'session_start',
      {
        sessionId,
        sessionKey,
        platform: this.platform,
        personalityId: personality.id,
      },
      allowedPlugins,
    );

    // Step 3: Persist the user message.
    //
    // Subagent task contract: the delegated task always lives in the child's
    // first user message (this `text`). It is NEVER copied into the system
    // prompt, NEVER injected via memory, and NEVER duplicated across both.
    // The regression test in
    // `extensions/tools-delegation/src/__tests__/task-contract.test.ts`
    // captures every `LLMProvider.complete()` request and asserts the marker
    // never appears in `opts.system` and appears exactly once across all
    // user-role messages.
    await this.session.appendMessage({
      sessionId,
      role: 'user',
      content: text,
    });

    // Step 4: Load history (trimmed to most-recent limit)
    const allMessages = await this.session.getMessages(sessionId, { limit: this.historyLimit });
    const history = allMessages.filter((m) => m.role !== 'system');

    // Step 5: Prefetch memory
    const memCtx = await this.memory.prefetch({
      sessionId,
      sessionKey,
      platform: this.platform,
      workingDir: this.workingDir,
      personalityId: personality.id,
      memoryScope: personality.memoryScope,
      query: text,
    });

    // Step 6: Build system prompt from injectors
    const promptCtx: PromptContext = {
      sessionId,
      sessionKey,
      platform: this.platform,
      model: this.llm.model,
      history,
      workingDir: this.workingDir,
      isDm: true,
      turnNumber: allMessages.length,
      personalityId: personality.id,
    };

    const systemParts: string[] = [];

    // Ch.3a — prepend the injection-defense prelude so the model knows how to
    // read `<untrusted>` blocks before any personality content sets the tone.
    const injectionDefenseEnabled = personality.safety?.injectionDefense?.enabled !== false;
    if (injectionDefenseEnabled) {
      systemParts.push(INJECTION_DEFENSE_PRELUDE);
    }

    // ETHOS.md / personality identity — routes through Storage so ScopedStorage
    // and InMemoryStorage fixtures work correctly. Only runs when storage is
    // wired (production always provides it; tests without a real ethosFile skip).
    if (personality.ethosFile && this.storage) {
      const identity = await this.storage.read(personality.ethosFile);
      if (identity) systemParts.push(identity.trim());
    }

    // Context injectors sorted by priority (already sorted in constructor)
    for (const injector of this.injectors) {
      // Plugin-registered injectors only fire when the plugin is permitted.
      const injPluginId = this.injectorPluginIds.get(injector);
      if (injPluginId !== undefined && !allowedPlugins.includes(injPluginId)) continue;
      if (injector.shouldInject && !injector.shouldInject(promptCtx)) continue;
      const result = await injector.inject(promptCtx);
      if (result) {
        if (result.position === 'prepend') {
          systemParts.unshift(result.content);
        } else {
          systemParts.push(result.content);
        }
      }
    }

    // Emit injector metadata (e.g. skill_files_used) so eval harness can capture it.
    if (promptCtx.meta && Object.keys(promptCtx.meta).length > 0) {
      yield { type: 'context_meta', data: promptCtx.meta };
    }

    // Memory injected last, as context about the user
    if (memCtx) {
      systemParts.push(`## Memory\n\n${memCtx.content}`);
    }

    // Step 7: Before-prompt-build modifying hooks (plugins can prepend/append/override)
    const buildResult = await this.hooks.fireModifying(
      'before_prompt_build',
      {
        sessionId,
        personalityId: personality.id,
        history,
      },
      allowedPlugins,
    );

    if (buildResult.overrideSystem) {
      systemParts.length = 0;
      systemParts.push(buildResult.overrideSystem);
    } else {
      if (buildResult.prependSystem) systemParts.unshift(buildResult.prependSystem);
      if (buildResult.appendSystem) systemParts.push(buildResult.appendSystem);
    }

    const systemPrompt = systemParts.join('\n\n').trim() || undefined;

    // Step 8: Agentic loop — LLM call → tool use → LLM call → ...
    const llmMessages = this.toLLMMessages(history);
    let fullText = '';
    let turnCount = 0;

    // Tool-call budget tracking — prevents runaway loops (see IMPROVEMENT.md P1-3).
    // Counted across all iterations within a single user turn.
    let totalToolCalls = 0;
    const toolNameCounts = new Map<string, number>();

    // Ch.3d — post-untrusted-read downgrade. After any `outputIsUntrusted`
    // tool returns, dangerous tools are blocked for the next N iterations.
    // Counter resets at the start of each `run()` (a fresh user message),
    // matching the chapter's "counter resets when the user sends a fresh
    // message" contract.
    const dgConfig = personality.safety?.injectionDefense?.postReadDowngrade;
    const dgEnabled = injectionDefenseEnabled && dgConfig?.enabled !== false;
    const dgTurns = dgConfig?.turns ?? 2;
    const dgTools = resolveDowngradedTools(dgConfig?.tools);
    let dgRemaining = 0;

    // Ch.6a — reset the watcher's per-turn counters on every fresh run().
    // Cross-turn state (rolling tool-call rate window) intentionally
    // persists; per-turn state (output token total) resets here.
    this.watcher?.resetTurn();
    // Captures the most recent non-`allow` decision so the iteration
    // boundary check can act on terminate / pause without splitting the
    // decision logic across every yield site. Typed via a `getHalt`
    // accessor so TS doesn't narrow the value to `never` after the
    // closure assigns it inside `observe()`.
    type HaltDecision = Extract<
      import('@ethosagent/safety-watcher').WatcherDecision,
      { action: 'pause' | 'force_approval' | 'terminate' }
    >;
    let watcherHaltState: HaltDecision | null = null;
    const observe = (event: import('@ethosagent/safety-watcher').WatcherEvent): void => {
      if (!this.watcher) return;
      const d = this.watcher.observe(event);
      if (d.action !== 'allow') watcherHaltState = d;
    };
    const getHalt = (): HaltDecision | null => watcherHaltState;

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      if (abortSignal.aborted) {
        yield { type: 'error', error: 'Aborted', code: 'aborted' };
        if (traceId) {
          this.observability?.endTrace(traceId, 'aborted');
          this.observability?.flush();
        }
        return;
      }

      // Ch.6a — the watcher fired a non-allow decision since the last
      // boundary check. Pause = stop this turn cleanly with a chip the
      // user sees. Terminate = error event + return. force_approval is
      // mapped to pause for v1 until the approval-hook is wired (failing
      // safe is better than silently continuing under the watcher's
      // intent to escalate).
      const halt = getHalt();
      if (halt) {
        if (halt.action === 'terminate') {
          yield {
            type: 'error',
            error: `Watcher: ${halt.reason}`,
            code: `watcher_${halt.rule}`,
          };
          if (traceId) {
            this.observability?.endTrace(traceId, 'aborted');
            this.observability?.flush();
          }
          return;
        }
        yield {
          type: 'tool_progress',
          toolName: '_watcher',
          message: `⚠ ${halt.rule}: ${halt.reason}`,
          audience: 'user',
        };
        break;
      }

      // Budget guard: bail before the next LLM call if we've already exceeded
      // either the total tool-call budget or the per-tool repeat budget. The
      // previous iteration's tool_result is in llmMessages, so the LLM history
      // stays valid; we just refuse to call again.
      if (totalToolCalls >= this.maxToolCallsPerTurn) {
        yield {
          type: 'tool_progress',
          toolName: '_budget',
          message: `Stopped: hit ${this.maxToolCallsPerTurn}-tool-call budget for this turn`,
          audience: 'user',
        };
        break;
      }
      const overusedTool = [...toolNameCounts.entries()].find(
        ([, count]) => count >= this.maxIdenticalToolCalls,
      );
      if (overusedTool) {
        yield {
          type: 'tool_progress',
          toolName: overusedTool[0],
          message: `Stopped: ${overusedTool[0]} called ${overusedTool[1]} times in one turn (likely loop)`,
          audience: 'user',
        };
        break;
      }

      // Fire before_llm_call
      await this.hooks.fireVoid(
        'before_llm_call',
        {
          sessionId,
          model: this.llm.model,
          turnNumber: turnCount,
        },
        allowedPlugins,
      );

      // Stream LLM response
      const pendingToolCalls: Array<{
        toolCallId: string;
        toolName: string;
        partialJson: string;
        args?: unknown;
      }> = [];
      let chunkText = '';

      // Streaming watchdog: cancel the stream if no chunk arrives within the
      // per-personality window. Reset every chunk so slow-but-progressing
      // reasoning is unaffected. See IMPROVEMENT.md P1-2 / OpenClaw #68596.
      const watchdogMs = personality.streamingTimeoutMs ?? this.streamingTimeoutMs;
      const watchdogController = new AbortController();
      const combinedSignal = AbortSignal.any([abortSignal, watchdogController.signal]);
      let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
      const armWatchdog = () => {
        if (watchdogTimer) clearTimeout(watchdogTimer);
        watchdogTimer = setTimeout(() => watchdogController.abort(), watchdogMs);
      };
      const disarmWatchdog = () => {
        if (watchdogTimer) clearTimeout(watchdogTimer);
        watchdogTimer = undefined;
      };

      const llmSpanId = this.observability?.startSpan({
        traceId: traceId ?? '',
        kind: 'llm_call',
        name: this.llm.model ?? 'unknown',
      });
      let llmInputTokens = 0;
      let llmOutputTokens = 0;

      try {
        armWatchdog();
        const stream = this.llm.complete(
          llmMessages,
          this.tools.toDefinitions(allowedTools, filterOpts),
          {
            system: systemPrompt,
            cacheSystemPrompt: true,
            abortSignal: combinedSignal,
            ...(modelOverride ? { modelOverride } : {}),
          },
        );

        for await (const chunk of stream) {
          if (abortSignal.aborted) break;
          if (watchdogController.signal.aborted) break;
          armWatchdog();
          for (const event of this.handleChunk(chunk, pendingToolCalls, (t) => {
            chunkText += t;
            fullText += t;
          })) {
            if (event.type === 'usage') {
              this.sessionCosts.set(
                sessionKey,
                (this.sessionCosts.get(sessionKey) ?? 0) + event.estimatedCostUsd,
              );
              llmInputTokens += event.inputTokens;
              llmOutputTokens += event.outputTokens;
              observe({
                type: 'usage',
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
              });
            }
            yield event;
          }
        }
        disarmWatchdog();
        this.observability?.endSpan(llmSpanId ?? '', 'ok', {
          inputTokens: llmInputTokens,
          outputTokens: llmOutputTokens,
        });

        if (watchdogController.signal.aborted && !abortSignal.aborted) {
          this.observability?.endTrace(traceId ?? '', 'error');
          this.observability?.flush();
          yield {
            type: 'error',
            error: `LLM stream stalled — no chunk for ${watchdogMs}ms`,
            code: 'streaming_timeout',
          };
          return;
        }
      } catch (err) {
        disarmWatchdog();
        this.observability?.endSpan(llmSpanId ?? '', 'error');
        if (watchdogController.signal.aborted && !abortSignal.aborted) {
          this.observability?.endTrace(traceId ?? '', 'error');
          this.observability?.flush();
          yield {
            type: 'error',
            error: `LLM stream stalled — no chunk for ${watchdogMs}ms`,
            code: 'streaming_timeout',
          };
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.observability?.endTrace(traceId ?? '', 'error');
        this.observability?.flush();
        yield { type: 'error', error: msg, code: 'llm_error' };
        return;
      }

      turnCount++;

      // Determine which tool calls completed parsing
      const completedToolCalls = pendingToolCalls.filter((tc) => tc.args !== undefined);

      // Update budget counters — these gate the NEXT iteration's LLM call.
      totalToolCalls += completedToolCalls.length;
      for (const tc of completedToolCalls) {
        toolNameCounts.set(tc.toolName, (toolNameCounts.get(tc.toolName) ?? 0) + 1);
      }

      // Persist assistant message — include tool_use references so history is LLM-replayable
      await this.session.appendMessage({
        sessionId,
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

      // Fire after_llm_call
      await this.hooks.fireVoid(
        'after_llm_call',
        {
          sessionId,
          text: chunkText,
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        allowedPlugins,
      );

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
        llmMessages.push({ role: 'assistant', content: assistantContent });
      } else {
        llmMessages.push({ role: 'assistant', content: chunkText });
        break;
      }

      // Step 9: Pre-flight hooks → execute non-rejected tools → collect all results

      // Phase 30.2 — tools call ctx.emit() during execution; AsyncGenerator can't
      // yield from a sync callback, so we buffer per-batch then drain after
      // executeParallel resolves. Order is preserved (insertion = call order).
      const progressBuffer: Array<{
        toolName: string;
        message: string;
        percent?: number;
        audience: 'internal' | 'user';
      }> = [];

      const scopedStorage = this.buildScopedStorage(personality);

      const toolCtxBase = {
        sessionId,
        sessionKey,
        platform: this.platform,
        workingDir: this.workingDir,
        agentId: opts.agentId,
        personalityId: personality.id,
        memoryScope: personality.memoryScope,
        currentTurn: turnCount,
        messageCount: allMessages.length + turnCount,
        abortSignal,
        emit: (event: {
          type: 'progress';
          toolName: string;
          message: string;
          percent?: number;
          audience?: 'internal' | 'user';
        }) => {
          progressBuffer.push({
            toolName: event.toolName,
            message: event.message,
            ...(event.percent !== undefined && { percent: event.percent }),
            audience: event.audience ?? 'internal',
          });
        },
        resultBudgetChars: this.resultBudgetChars,
        ...(scopedStorage ? { storage: scopedStorage } : {}),
        ...(personality.safety?.network ? { networkPolicy: personality.safety.network } : {}),
      };

      // Run before_tool_call hooks; build exec list with effective args
      // Rejected tools get tool_end ok:false + an error tool_result sent back to LLM
      type Prepped = { toolCallId: string; name: string; args: unknown; rejected?: string };
      const prepped: Prepped[] = [];
      const spanIds = new Map<string, string>();

      for (const tc of completedToolCalls) {
        // Ch.3d — refuse downgraded tools while the post-untrusted-read
        // counter is positive. The user's next message clears the counter
        // (run() is invoked fresh; dgRemaining resets to 0).
        if (dgEnabled && dgRemaining > 0 && dgTools.has(tc.toolName)) {
          this.observability?.recordEvent({
            traceId,
            category: 'audit.block',
            severity: 'warn',
            code: 'tool_downgraded_post_untrusted_read',
            cause: tc.toolName,
          });
          observe({ type: 'tool_end', toolName: tc.toolName, ok: false });
          yield {
            type: 'tool_end',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            ok: false,
            durationMs: 0,
            result: DOWNGRADE_REJECTION_MESSAGE,
          };
          prepped.push({
            toolCallId: tc.toolCallId,
            name: tc.toolName,
            args: tc.args,
            rejected: DOWNGRADE_REJECTION_MESSAGE,
          });
          continue;
        }

        const beforeResult = await this.hooks.fireModifying(
          'before_tool_call',
          {
            sessionId,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
          },
          allowedPlugins,
        );

        if (beforeResult.error) {
          this.observability?.recordEvent({
            traceId,
            category: 'audit.block',
            severity: 'warn',
            code: 'tool_blocked',
            cause: beforeResult.error,
          });
          observe({ type: 'tool_end', toolName: tc.toolName, ok: false });
          yield {
            type: 'tool_end',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            ok: false,
            durationMs: 0,
            result: beforeResult.error,
          };
          prepped.push({
            toolCallId: tc.toolCallId,
            name: tc.toolName,
            args: tc.args,
            rejected: beforeResult.error,
          });
          continue;
        }

        const effectiveArgs = beforeResult.args ?? tc.args;
        const spanId = this.observability?.startSpan({
          traceId: traceId ?? '',
          kind: 'tool_call',
          name: tc.toolName,
          attrs: { args: JSON.stringify(effectiveArgs).slice(0, 4096) },
          obsConfig,
        });
        spanIds.set(tc.toolCallId, spanId ?? '');
        observe({ type: 'tool_start', toolName: tc.toolName, args: effectiveArgs });
        yield {
          type: 'tool_start',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: effectiveArgs,
        };
        prepped.push({ toolCallId: tc.toolCallId, name: tc.toolName, args: effectiveArgs });
      }

      // Execute only non-rejected tools; results keyed by toolCallId
      const execInputs = prepped
        .filter((p) => p.rejected === undefined)
        .map((p) => ({ toolCallId: p.toolCallId, name: p.name, args: p.args }));

      const startedAt = Date.now();
      const execResults =
        execInputs.length > 0
          ? await this.tools.executeParallel(execInputs, toolCtxBase, allowedTools, filterOpts)
          : [];
      const execResultMap = new Map(execResults.map((r) => [r.toolCallId, r]));

      // Drain any progress events tools emitted during execution. Order is
      // call-order (across the parallel batch) — close enough for users; the
      // exact interleaving doesn't matter when ctx.emit is best-effort.
      for (const ev of progressBuffer) {
        yield { type: 'tool_progress', ...ev };
      }
      progressBuffer.length = 0;

      // Persist results + emit tool_end + build tool_result content blocks (original order)
      const toolResultContent: MessageContent[] = [];
      // Ch.3d — set when any tool we ran this iteration was outputIsUntrusted.
      // Decremented at the *top* of the next iteration, so a downgraded tool in
      // the same iteration also catches against the counter we set below.
      let untrustedReadThisIteration = false;

      for (const p of prepped) {
        const durationMs = Date.now() - startedAt;
        let result: ToolResult;
        // Ch.3a — `result` carries the original raw value for tool_end events
        // and after_tool_call hooks (the user-visible chip and audit trail
        // see what the tool actually returned). `llmContent` is the LLM-
        // facing string — possibly wrapped in `<untrusted>…</untrusted>` —
        // and is what gets persisted to history so toLLMMessages() replays
        // the exact bytes the model saw on the prior turn.
        let llmContent: string;

        if (p.rejected !== undefined) {
          result = { ok: false, error: p.rejected, code: 'execution_failed' };
          llmContent = p.rejected;
          // tool_end already emitted above; no after_tool_call hook for blocked tools
        } else {
          const execResult = execResultMap.get(p.toolCallId);
          result = execResult?.result ?? {
            ok: false,
            error: 'Tool result missing',
            code: 'execution_failed',
          };
          const sid = spanIds.get(p.toolCallId);
          if (sid) {
            this.observability?.endSpan(sid, result.ok ? 'ok' : 'error', {
              result_size_bytes: result.ok ? result.value.length : undefined,
              durationMs,
            });
          }
          observe({ type: 'tool_end', toolName: p.name, ok: result.ok });
          yield {
            type: 'tool_end',
            toolCallId: p.toolCallId,
            toolName: p.name,
            ok: result.ok,
            durationMs,
            result: result.ok ? result.value : result.error,
          };
          // Aggregate tool-incurred costs (e.g. image generation, vision LLM calls)
          // into the session budget so /usage and budgetCapUsd see them.
          if (result.ok && result.cost_usd) {
            this.sessionCosts.set(
              sessionKey,
              (this.sessionCosts.get(sessionKey) ?? 0) + result.cost_usd,
            );
            yield {
              type: 'usage',
              inputTokens: 0,
              outputTokens: 0,
              estimatedCostUsd: result.cost_usd,
            };
          }
          await this.hooks.fireVoid(
            'after_tool_call',
            {
              sessionId,
              toolName: p.name,
              result,
              durationMs,
            },
            allowedPlugins,
          );

          llmContent = result.ok ? result.value : result.error;

          // Ch.3a + 3c — provenance wrap + Tier-1 pattern check + optional
          // Tier-2 LLM classifier. Only applies on success; errors are
          // framework-authored and skip wrapping.
          if (injectionDefenseEnabled && result.ok) {
            const tool = this.tools.get(p.name);
            if (tool?.outputIsUntrusted) {
              const verdict = await this.handleUntrustedResult(
                p.name,
                p.args,
                result.value,
                personality,
                traceId,
              );
              llmContent = verdict.wrappedContent;
              if (verdict.containsInstructions) {
                this.observability?.recordEvent({
                  traceId,
                  category: 'audit.block',
                  severity: 'warn',
                  code: 'injection_detected',
                  cause: verdict.reason ?? 'pattern-hit',
                });
                yield {
                  type: 'tool_progress',
                  toolName: p.name,
                  message: `⚠ external content may contain instructions${verdict.reason ? ` (${verdict.reason})` : ''}`,
                  audience: 'user',
                };
              }
              untrustedReadThisIteration = true;
            }
          }
        }

        // Persist every result (rejected or not) so history matches what LLM sees
        await this.session.appendMessage({
          sessionId,
          role: 'tool_result',
          content: llmContent,
          toolCallId: p.toolCallId,
          toolName: p.name,
        });

        toolResultContent.push({
          type: 'tool_result',
          tool_use_id: p.toolCallId,
          content: llmContent,
          is_error: !result.ok,
        });
      }

      // Ch.3d — decrement the prior iteration's counter, then arm a fresh
      // window if we just read untrusted content. The decrement-then-set
      // order means an untrusted read in iteration N protects iterations
      // N+1 .. N+turns.
      if (dgRemaining > 0) dgRemaining--;
      if (dgEnabled && untrustedReadThisIteration) {
        dgRemaining = dgTurns;
      }

      // Feed all tool results back to LLM as a single user message with content blocks
      llmMessages.push({ role: 'user', content: toolResultContent });
    }

    // Step 10: Memory writes flow through the `memory_save` tool during the
    // turn (see extensions/tools-memory). The agent-loop itself produces no
    // updates, so there's nothing to sync here.

    // Step 11: Update usage
    await this.session.updateUsage(sessionId, { apiCallCount: turnCount });

    // Step 12: Fire agent_done
    await this.hooks.fireVoid(
      'agent_done',
      { sessionId, text: fullText, turnCount },
      allowedPlugins,
    );

    if (traceId) this.observability?.endTrace(traceId, 'ok');
    this.observability?.flush();

    yield { type: 'done', text: fullText, turnCount };
  }

  private *handleChunk(
    chunk: CompletionChunk,
    pendingToolCalls: Array<{
      toolCallId: string;
      toolName: string;
      partialJson: string;
      args?: unknown;
    }>,
    onText: (t: string) => void,
  ): Generator<AgentEvent> {
    switch (chunk.type) {
      case 'text_delta':
        onText(chunk.text);
        yield { type: 'text_delta', text: chunk.text };
        break;

      case 'thinking_delta':
        yield { type: 'thinking_delta', thinking: chunk.thinking };
        break;

      case 'tool_use_start':
        pendingToolCalls.push({
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          partialJson: '',
        });
        break;

      case 'tool_use_delta': {
        const tc = pendingToolCalls.find((t) => t.toolCallId === chunk.toolCallId);
        if (tc) tc.partialJson += chunk.partialJson;
        break;
      }

      case 'tool_use_end': {
        const tc = pendingToolCalls.find((t) => t.toolCallId === chunk.toolCallId);
        if (tc) {
          try {
            tc.args = JSON.parse(chunk.inputJson || tc.partialJson);
          } catch {
            tc.args = {};
          }
        }
        break;
      }

      case 'usage':
        yield {
          type: 'usage',
          inputTokens: chunk.usage.inputTokens,
          outputTokens: chunk.usage.outputTokens,
          estimatedCostUsd: chunk.usage.estimatedCostUsd,
        };
        break;

      case 'done':
        // finishReason available here for future context-compaction (Phase 3)
        break;
    }
  }

  // Reconstruct LLM-ready messages from stored history.
  // Assistant messages with tool calls produce proper tool_use content blocks.
  // Consecutive tool_result rows are grouped into a single user message.
  private toLLMMessages(stored: StoredMessage[]): Message[] {
    const messages: Message[] = [];

    for (const msg of stored) {
      if (msg.role === 'system') continue;

      if (msg.role === 'user') {
        messages.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const content: MessageContent[] = [];
          if (msg.content) content.push({ type: 'text', text: msg.content });
          for (const tc of msg.toolCalls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
          }
          messages.push({ role: 'assistant', content });
        } else {
          messages.push({ role: 'assistant', content: msg.content });
        }
      } else if (msg.role === 'tool_result') {
        const resultBlock: MessageContent = {
          type: 'tool_result',
          tool_use_id: msg.toolCallId ?? '',
          content: msg.content,
          is_error: false,
        };
        const last = messages[messages.length - 1];
        // Append to existing tool_result user message, or start a new one
        if (last?.role === 'user' && Array.isArray(last.content)) {
          (last.content as MessageContent[]).push(resultBlock);
        } else {
          messages.push({ role: 'user', content: [resultBlock] });
        }
      }
    }

    return messages;
  }

  // ---------------------------------------------------------------------------
  // Per-turn ScopedStorage construction (Phase 4 — fs_reach enforcement).
  //
  // When the AgentLoop was wired with `storage` + `dataDir`, build a
  // ScopedStorage decorated with the active personality's `fs_reach`
  // allowlist for this turn. Substitutions (${ETHOS_HOME} / ${self} /
  // ${CWD}) are resolved here so the underlying storage-fs class stays
  // pristine. When `fs_reach` is unset, fall back to a sensible default:
  //   read:  [<ethosHome>/personalities/<self>/, <ethosHome>/skills/, <cwd>]
  //   write: [<ethosHome>/personalities/<self>/, <cwd>]
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Ch.3a + 3c — provenance wrap + injection classification
  // ---------------------------------------------------------------------------
  //
  // Returns the wrapped content (always — wrap is the floor) plus whether
  // any defense layer flagged the payload. Tier-1 is always evaluated;
  // Tier-2 (LLM classifier) fires when Tier-1 hit, content is > 500 chars,
  // or `injectionDefense.classifier.alwaysCallLLM` is true.
  private async handleUntrustedResult(
    toolName: string,
    args: unknown,
    rawValue: string,
    personality: PersonalityConfig,
    traceId: string | undefined,
  ): Promise<{
    wrappedContent: string;
    containsInstructions: boolean;
    reason?: string;
  }> {
    const source = describeSource(toolName, args);
    const wrapped = wrapUntrusted({
      content: rawValue,
      toolName,
      ...(source ? { source } : {}),
    });
    const tier1 = shortPatternCheck(rawValue);
    const tier1Hit = tier1.containsInstructions || wrapped.strippedTokens > 0;

    const classifierConfig = personality.safety?.injectionDefense?.classifier;
    const shouldCallLLM =
      this.injectionClassifier !== undefined &&
      (classifierConfig?.alwaysCallLLM === true || tier1Hit || rawValue.length > 500);

    let verdict: InjectionVerdict | null = null;
    if (shouldCallLLM && this.injectionClassifier) {
      try {
        verdict = await this.injectionClassifier({ content: rawValue });
      } catch (err) {
        // Tier-2 failure must not silently disappear — record it so an
        // operator can see when a configured safety control is offline.
        // We continue with Tier-1 only (fail-open by design: blocking the
        // turn on classifier outage would brick every tool call).
        this.observability?.recordEvent({
          traceId,
          category: 'audit.block',
          severity: 'warn',
          code: 'injection_classifier_failed',
          cause: err instanceof Error ? err.message : String(err),
        });
        verdict = null;
      }
    }

    const containsInstructions = tier1Hit || (verdict?.containsInstructions ?? false);
    const reason = tier1Hit
      ? wrapped.strippedTokens > 0
        ? `stripped ${wrapped.strippedTokens} template token${wrapped.strippedTokens === 1 ? '' : 's'}`
        : (tier1.hits[0]?.rule ?? 'pattern-hit')
      : verdict?.reason;

    return {
      wrappedContent: wrapped.content,
      containsInstructions,
      ...(reason ? { reason } : {}),
    };
  }

  private buildScopedStorage(personality: PersonalityConfig): Storage | undefined {
    if (!this.storage) return undefined;

    const ethosHome = this.dataDir ?? join(homedir(), '.ethos');
    const cwd = this.workingDir;
    const self = personality.id;
    const ownDir = `${join(ethosHome, 'personalities', self)}/`;

    const fsReach = personality.fs_reach;
    const readPrefixes =
      fsReach?.read && fsReach.read.length > 0
        ? fsReach.read.map((p) => substitute(p, { ethosHome, self, cwd }))
        : [ownDir, `${join(ethosHome, 'skills')}/`, cwd];
    const writePrefixes =
      fsReach?.write && fsReach.write.length > 0
        ? fsReach.write.map((p) => substitute(p, { ethosHome, self, cwd }))
        : [ownDir, cwd];

    return new ScopedStorage(this.storage, {
      read: readPrefixes,
      write: writePrefixes,
      alwaysDeny: defaultAlwaysDeny(),
    });
  }
}

// Ch.5 — universal always-deny floor. These prefixes are non-overridable —
// even a personality config that explicitly allows `~/` cannot read them.
// Lives in code, not config; user can extend via runtime API but cannot
// remove. The list mirrors the plan's deny floor: SSH keys, AWS / GPG /
// netrc credentials, shell history, system auth files, macOS keychains.
function defaultAlwaysDeny(): string[] {
  const home = homedir();
  return [
    `${home}/.ssh`,
    `${home}/.aws/credentials`,
    `${home}/.aws/config`,
    `${home}/.gnupg`,
    `${home}/.netrc`,
    `${home}/.bash_history`,
    `${home}/.zsh_history`,
    `${home}/.psql_history`,
    `${home}/.mysql_history`,
    `${home}/.npmrc`,
    `${home}/Library/Keychains`,
    '/etc/passwd',
    '/etc/shadow',
    '/etc/sudoers',
    '/etc/sudoers.d',
    '/root',
    '/boot',
    '/sys',
    '/proc/sys',
  ];
}

function substitute(
  template: string,
  vars: { ethosHome: string; self: string; cwd: string },
): string {
  return template
    .replace(/\$\{ETHOS_HOME\}/g, vars.ethosHome)
    .replace(/\$\{self\}/g, vars.self)
    .replace(/\$\{CWD\}/g, vars.cwd);
}

// Best-effort origin label for `<untrusted source="…">`. Picks from common
// argument shapes: `path` (file tools), `url` (web tools), `command`
// (terminal). Returns undefined when nothing recognizable is on the args
// — wrapUntrusted will fall back to "unknown".
function describeSource(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  if (typeof a.path === 'string') return `${toolName === 'read_file' ? 'file:' : ''}${a.path}`;
  if (typeof a.url === 'string') return a.url;
  if (typeof a.command === 'string') return `cmd:${a.command}`;
  if (typeof a.query === 'string') return `query:${a.query}`;
  return undefined;
}
