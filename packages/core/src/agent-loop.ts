import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DOWNGRADE_REJECTION_MESSAGE,
  INJECTION_DEFENSE_PRELUDE,
  type InjectionClassifier,
  type InjectionVerdict,
  resolveDowngradedTools,
  sanitize,
  shortPatternCheck,
  wrapUntrusted,
} from '@ethosagent/safety-injection';
import { redactString } from '@ethosagent/safety-redact';
import { defaultAlwaysDeny, ScopedStorage } from '@ethosagent/storage-fs';
import type {
  CompletionChunk,
  ContextEngineRegistry,
  ContextInjector,
  HookRegistry,
  LLMProvider,
  MemoryContext,
  MemoryProvider,
  Message,
  MessageContent,
  PersonalityConfig,
  PersonalityRegistry,
  PromptContext,
  RequestDumpStore,
  SessionStore,
  SteerSink,
  Storage,
  StoredMessage,
  ToolFilterOpts,
  ToolRegistry,
  ToolResult,
} from '@ethosagent/types';
import { buildAttachmentAnnotation } from './attachment-annotation';
import type { ClarifyBridge } from './clarify/clarify-bridge';
import { DefaultContextEngineRegistry } from './context-engines/registry';
import { estimateMessagesTokens, estimateTokens } from './context-engines/token-estimator';
import { InMemorySessionStore } from './defaults/in-memory-session';
import { NoopMemoryProvider } from './defaults/noop-memory';
import { DefaultPersonalityRegistry } from './defaults/noop-personality';
import { redactArgs } from './dry-run';
import { DefaultHookRegistry } from './hook-registry';
import type { AgentLoopObservability } from './observability/agent-loop-observability';
import { DefaultToolRegistry } from './tool-registry';

// ---------------------------------------------------------------------------
// Agent events emitted by run()
//
// AgentEvent is a forward-compatible discriminated union. New event `type`
// values may be added in any release. **Consumers MUST treat unknown event
// types as a no-op, not throw.** A `switch (event.type)` with no `default`
// case is a forward-compat bug — it will silently break the moment a new
// variant ships. Use `isKnownAgentEvent(event)` if you want an opt-in
// warning during development that a new event type appeared.
//
// Known event types live in `KNOWN_AGENT_EVENT_TYPES` below. Keep it in
// sync when adding a new variant — the `isKnownAgentEvent` helper reads
// from it, and downstream tools (the CLI verbose mode, telemetry filters)
// can iterate it.
// ---------------------------------------------------------------------------

export const KNOWN_AGENT_EVENT_TYPES = [
  'text_delta',
  'thinking_delta',
  'tool_start',
  'tool_progress',
  'tool_end',
  'usage',
  'error',
  'done',
  'context_meta',
  'run_start',
  'dry_run_summary',
] as const;

export type KnownAgentEventType = (typeof KNOWN_AGENT_EVENT_TYPES)[number];

/**
 * Returns true when the event's `type` is one a current consumer knows
 * about. Useful for development-mode warnings:
 *
 *     for await (const event of loop.run(...)) {
 *       if (!isKnownAgentEvent(event)) {
 *         console.warn('Unknown AgentEvent type:', event.type);
 *         continue;
 *       }
 *       switch (event.type) { ... }
 *     }
 *
 * Production code should silently skip unknown events; this helper is for
 * test runs and dev surfaces that want to alert on newly-added variants.
 */
export function isKnownAgentEvent(event: { type: string }): event is AgentEvent {
  return (KNOWN_AGENT_EVENT_TYPES as readonly string[]).includes(event.type);
}

export interface DryRunToolPlan {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

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
      audience: 'internal' | 'user' | 'dashboard';
    }
  | {
      type: 'tool_end';
      toolCallId: string;
      toolName: string;
      ok: boolean;
      durationMs: number;
      // Phase 30.2 — same boundary applies to tool_end success rendering.
      // Failures (`ok: false`) ignore the field and always render.
      audience?: 'internal' | 'user' | 'dashboard';
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
    }
  | {
      type: 'dry_run_summary';
      plan: DryRunToolPlan[];
      capped: number;
    };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  llm: LLMProvider;
  tools?: ToolRegistry;
  personalities?: PersonalityRegistry;
  memory?: MemoryProvider;
  /**
   * Phase 3 — team id. When set, AgentLoop stamps `teamId` on every
   * `ToolContext` so team memory tools can route to the correct team scope.
   * Absent when running solo.
   */
  teamId?: string;
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
   * Optional observability adapter. When provided, AgentLoop records traces,
   * spans, and events for LLM calls, tool calls, and errors via typed
   * domain helpers. When absent, behaviour is identical to before — no
   * observability writes occur.
   */
  observability?: AgentLoopObservability;
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
  /**
   * Per-personality memory provider registry. Maps provider names ('markdown',
   * 'vector', plugin-registered names) to factory functions. When a personality
   * declares `memory.provider`, AgentLoop resolves from this map.
   */
  memoryProviders?: Map<
    string,
    (options?: Record<string, unknown>) => MemoryProvider | Promise<MemoryProvider>
  >;
  /**
   * E4 — Pluggable context-engine registry. When unset, AgentLoop builds
   * a `DefaultContextEngineRegistry` (drop_oldest + semantic_summary
   * placeholder + reference_preserving). Each personality picks an engine
   * via `personality.context_engine`; unknown names fall back to
   * `drop_oldest` with a one-line warning.
   */
  contextEngines?: ContextEngineRegistry;
  /**
   * Bridge for the `clarify` tool — the agent asks the user a structured
   * question mid-turn and waits. Optional: when unset, the `clarify` tool
   * reports `CLARIFY_NO_SURFACE` and the agent falls back to plain prose.
   */
  clarifyBridge?: ClarifyBridge;
  /**
   * Per-personality MCP tool policy loaded from mcp.yaml. NOT part of
   * PersonalityConfig (frozen schema). Passed through from wiring so
   * AgentLoop can build per-tool MCP allowlists in filterOpts.
   */
  mcpPolicy?: import('@ethosagent/types').McpPolicy;
  /**
   * Optional request dump store. When provided, AgentLoop appends a full
   * record of each LLM request/response for offline analysis and debugging.
   */
  requestDumpStore?: RequestDumpStore;
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
  /** Sampling temperature forwarded to the LLM provider. */
  temperature?: number;
  /** Top-P (nucleus sampling) forwarded to the LLM provider. */
  topP?: number;
  /** Maps to CompletionOptions.maxTokens — separate name to avoid collision with AgentLoop's own maxTokens semantics. */
  maxCompletionTokens?: number;
  /** RNG seed forwarded to providers that support it (e.g. OpenAI-compat). */
  seed?: number;
  /**
   * Identifier surfaced to tools as `ToolContext.agentId`. Delegation tools
   * use this to thread spawn depth (`depth:N`) into child loops so
   * `MAX_SPAWN_DEPTH` can be enforced across recursive sub-agent calls.
   */
  agentId?: string;
  /**
   * FW-9 — `steer` busy-input mode. Surfaces (CLI REPL) push user-typed text
   * here while the agent is mid-turn. AgentLoop drains the sink at the
   * iteration seam (after tool_results land, before the next LLM call) and
   * folds each entry in as a `[USER STEER]: <text>` text block on the user
   * message carrying the tool_results.
   *
   * Pre-first-iteration (no tool_results yet) and idle (no run in flight)
   * steering falls back to `queue` at the surface, never reaching AgentLoop.
   */
  steerSink?: SteerSink;
  /** Per-turn inbound attachments from the user message. Persisted as an
   *  `<attachments>` annotation prepended to the user text. Threaded to the
   *  capability resolver via `ToolRegistry.setTurnAttachments()`. */
  attachments?: import('@ethosagent/types').Attachment[];
  /**
   * Override model tier for this run only (from /tier command).
   * Consumed once; does not persist across runs.
   */
  tierOverride?: import('@ethosagent/types').ModelTierName;
  /** Opaque user id (from IdentityMap). When present, USER.md is read from `user:<userId>` scope. */
  userId?: string;
  dryRun?: boolean;
  dryRunMaxToolCalls?: number;
  /**
   * Override the personality's toolset for this run. Used by cron to exclude
   * the `cron` tool from cron-spawned sessions (recursion guard).
   */
  toolsetOverride?: string[];
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
  private readonly memoryProviders: Map<
    string,
    (options?: Record<string, unknown>) => MemoryProvider | Promise<MemoryProvider>
  >;
  private readonly storage?: Storage;
  private readonly dataDir?: string;
  private readonly observability?: AgentLoopObservability;
  private readonly injectionClassifier?: InjectionClassifier;
  private readonly watcher?: import('@ethosagent/safety-watcher').Watcher;
  private readonly contextEngines: ContextEngineRegistry;
  /** Bridge for the `clarify` tool; undefined when no interactive surface is wired. */
  readonly clarifyBridge?: ClarifyBridge;
  /** Optional request dump store for full LLM request/response recording. */
  private readonly requestDumpStore?: import('@ethosagent/types').RequestDumpStore;
  /** Phase 3 — team id stamped onto ToolContext when loop runs inside a team. */
  private readonly teamId?: string;
  /** Per-personality MCP tool policy from mcp.yaml (NOT on PersonalityConfig). */
  private readonly mcpPolicy?: import('@ethosagent/types').McpPolicy;
  /** Per-session accumulated spend in USD. Keyed by sessionKey. Reset via resetSessionCost(). */
  private readonly sessionCosts = new Map<string, number>();
  /** FW-28 — per-session mtime registry. Keyed by sessionKey → (absPath → record). */
  private readonly sessionReadMtimes = new Map<
    string,
    Map<string, { mtimeMs: number; readAtTurn: number }>
  >();

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
    this.memoryProviders = config.memoryProviders ?? new Map();
    if (config.storage) this.storage = config.storage;
    if (config.dataDir) this.dataDir = config.dataDir;
    if (config.observability) this.observability = config.observability;
    if (config.teamId) this.teamId = config.teamId;
    if (config.injectionClassifier) this.injectionClassifier = config.injectionClassifier;
    if (config.watcher) this.watcher = config.watcher;
    if (config.clarifyBridge) this.clarifyBridge = config.clarifyBridge;
    if (config.requestDumpStore) this.requestDumpStore = config.requestDumpStore;
    if (config.mcpPolicy) this.mcpPolicy = config.mcpPolicy;
    this.contextEngines = config.contextEngines ?? new DefaultContextEngineRegistry();
  }

  /**
   * Resolve a pending clarify request — called by an interactive surface when
   * the user answers or cancels. No-op when no clarify bridge is wired or the
   * request id is unknown (already resolved / timed out).
   */
  async respondToClarify(response: import('@ethosagent/types').ClarifyResponse): Promise<void> {
    await this.clarifyBridge?.respond(response);
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

  /**
   * Resolve the effective model for an LLM call, respecting tier config.
   * Returns the model string to pass as modelOverride, and the tier name used.
   */
  private resolveModelWithTier(
    personality: PersonalityConfig,
    tier: import('@ethosagent/types').ModelTierName,
  ): { model: string; source: 'personality' | 'global' } {
    const personalityOverride = this.modelRouting[personality.id];
    if (personalityOverride) return { model: personalityOverride, source: 'personality' };

    // Only use tier config when the personality declares a provider that matches
    // the active LLM. This prevents Anthropic-specific model IDs from being
    // injected into OpenRouter/Ollama/Gemini providers. Without a matching
    // provider declaration, fall through to the global model.
    const modelConfig = personality.model;
    if (modelConfig && typeof modelConfig === 'object' && personality.provider === this.llm.name) {
      const tierModel = modelConfig[tier] ?? modelConfig.default;
      if (tierModel) return { model: tierModel, source: 'personality' };
    }

    return { model: this.llm.model, source: 'global' };
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

    const traceId = this.observability?.startTurnTrace({
      sessionId,
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

    // Q2 — advance the per-session turn counter. `turnNumber` drives the
    // anti-thrashing compaction cooldown; `lastCompactionTurn` is the turn the
    // previous compaction fired (0 = never).
    const { turnNumber, lastCompactionTurn } = await this.session.recordTurnStart(sessionId);

    // Resolve effective model with tier support.
    // Priority: modelRouting[id] > personality tier config > llm.model.
    // User tier override (from /tier command via RunOptions) applies for this entire turn.
    const turnTierOverride = opts.tierOverride;
    if (turnTierOverride) {
      this.observability?.recordTierOverride({
        traceId: traceId ?? '',
        actor: 'user',
        tier: turnTierOverride,
        personalityId: personality.id,
      });
    }

    const activeTier = turnTierOverride ?? 'default';
    let pendingTierEscalation: 'trivial' | 'default' | 'deep' | undefined;
    const { model: effectiveModel, source: modelSource } = this.resolveModelWithTier(
      personality,
      activeTier,
    );
    const modelOverride = effectiveModel !== this.llm.model ? effectiveModel : undefined;

    // Phase 5: emit run_start trace so consumers (TUI, CLI verbose, telemetry)
    // can surface the resolved provider/model and routing source.
    yield {
      type: 'run_start',
      provider: this.llm.name,
      model: effectiveModel,
      source: modelSource,
    };

    // Allowed tool names for this personality (undefined = no restriction)
    const allowedTools = opts.toolsetOverride ?? personality.toolset ?? undefined;
    // Per-personality plugin + MCP gate (default-deny: missing field = no access)
    const allowedPlugins = personality.plugins ?? [];

    // Build per-tool MCP allowlist from mcp.yaml policy (if present).
    const mcpServers = this.mcpPolicy?.servers;
    const allowedMcpTools: Record<string, string[]> | undefined = mcpServers
      ? Object.fromEntries(
          Object.entries(mcpServers)
            .filter(([, v]) => v.tools !== undefined)
            .map(([k, v]) => {
              const tools = v.tools;
              return [k, tools ?? []];
            }),
        )
      : undefined;

    const filterOpts: ToolFilterOpts = {
      allowedMcpServers: personality.mcp_servers ?? [],
      allowedPlugins,
      ...(allowedMcpTools && Object.keys(allowedMcpTools).length > 0 ? { allowedMcpTools } : {}),
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
    //
    // Attachment annotation: prepend an <attachments> block so the LLM sees
    // which files/images the user attached. Persisted with the message so
    // replay is faithful (plan risk #10).
    const attachmentAnnotation = buildAttachmentAnnotation(opts.attachments ?? []);
    const annotatedText = attachmentAnnotation ? `${attachmentAnnotation}\n${text}` : text;

    await this.session.appendMessage({
      sessionId,
      role: 'user',
      content: annotatedText,
    });

    // Step 4: Load history (trimmed to most-recent limit)
    const allMessages = await this.session.getMessages(sessionId, { limit: this.historyLimit });
    const history = allMessages.filter((m) => m.role !== 'system');

    // Step 5: Prefetch memory.
    //
    // Per-personality memory backend: if the personality declares a `memory.provider`,
    // resolve it from the registry. Otherwise fall back to the global provider.
    const activeMemory = personality.memory?.provider
      ? ((await this.memoryProviders.get(personality.memory.provider)?.(
          personality.memory.options,
        )) ?? this.memory)
      : this.memory;

    const memScopeId = `personality:${personality.id}`;
    const memCtx: MemoryContext = {
      scopeId: memScopeId,
      sessionId,
      sessionKey,
      platform: this.platform,
      workingDir: this.workingDir,
    };
    let memSnapshot = await activeMemory.prefetch(memCtx);

    // Providers that don't support bulk prefetch (e.g. VectorMemoryProvider)
    // return null. Fall back to a semantic search on the current user text so
    // those backends still inject relevant context into the system prompt —
    // restoring the query-driven retrieval the old two-method contract did
    // internally inside prefetch().
    if (!memSnapshot && text.trim()) {
      const hits = await activeMemory.search(text, memCtx, { limit: 5 });
      if (hits.length > 0) {
        memSnapshot = { entries: hits.map((h) => ({ key: h.key, content: h.content })) };
      }
    }

    // Per-user profile prefetch
    const userScopeId = opts.userId ? `user:${opts.userId}` : undefined;
    if (userScopeId) {
      const userCtx: MemoryContext = {
        scopeId: userScopeId,
        sessionId,
        sessionKey,
        platform: this.platform,
        workingDir: this.workingDir,
      };
      const userEntry = await activeMemory.read('USER.md', userCtx);
      if (userEntry?.content.trim()) {
        const userSnapshot = {
          entries: [{ key: 'USER.md', content: userEntry.content }],
        };
        if (memSnapshot) {
          memSnapshot = { entries: [...userSnapshot.entries, ...memSnapshot.entries] };
        } else {
          memSnapshot = userSnapshot;
        }
      }
    }

    // Backstop: sanitize memory content for prompt-injection patterns before
    // injecting into the system prompt (same defense context files get).
    if (memSnapshot) {
      memSnapshot = {
        entries: memSnapshot.entries.map((e) => ({
          key: e.key,
          content: sanitize(e.content),
        })),
      };
    }

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

    // SOUL.md / personality identity — routes through Storage so ScopedStorage
    // and InMemoryStorage fixtures work correctly. Only runs when storage is
    // wired (production always provides it; tests without a real soulFile skip).
    if (personality.soulFile && this.storage) {
      const identity = await this.storage.read(personality.soulFile);
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

    // Memory injected last, as context about the user. The snapshot is a
    // list of (key, content) pairs; render USER.md as "About You" first,
    // MEMORY.md as "Memory" second, anything else as its own section.
    //
    // Hard cap on the total memory block at 20k chars — same budget the
    // old MarkdownFileMemoryProvider enforced internally. Without this,
    // a long-running session's MEMORY.md grows unbounded and silently
    // explodes the system prompt token bill.
    if (memSnapshot && memSnapshot.entries.length > 0) {
      const blocks: string[] = [];
      const orderHints: Record<string, string> = {
        'USER.md': 'About You',
        'MEMORY.md': 'Memory',
      };
      const sorted = [...memSnapshot.entries].sort((a, b) => {
        const rank = (k: string) => (k === 'USER.md' ? 0 : k === 'MEMORY.md' ? 1 : 2);
        return rank(a.key) - rank(b.key);
      });
      for (const e of sorted) {
        const heading = orderHints[e.key] ?? e.key;
        blocks.push(`## ${heading}\n\n${redactString(e.content.trim())}`);
      }
      if (blocks.length > 0) {
        let rendered = `## Memory\n\n${blocks.join('\n\n')}`;
        const MEMORY_MAX_CHARS = 20_000;
        if (rendered.length > MEMORY_MAX_CHARS) {
          // Tail-keep — newer memory lives at the end; the prelude carries
          // less per-token signal than the freshest facts.
          rendered = `[...truncated]\n\n${rendered.slice(-MEMORY_MAX_CHARS)}`;
        }
        systemParts.push(rendered);
      }
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

    if (opts.dryRun) {
      systemParts.push(
        'IMPORTANT: You are in DRY-RUN mode. Every tool call will be intercepted and return a stub ' +
          'result — no tool actually executes. Plan your tool calls as normal but do NOT retry or ' +
          'loop when you see "[dry-run]" in the result. After your first batch of tool calls, ' +
          'summarize what you would have done and stop.',
      );
    }

    const systemPrompt = systemParts.join('\n\n').trim() || undefined;

    // Step 8: Agentic loop — LLM call → tool use → LLM call → ...
    // Q1 — collapse exact-duplicate tool results before building the
    // LLM-facing history, so re-reads of the same file don't burn tokens.
    let llmMessages = this.toLLMMessages(this.dedupHistory(history));
    // E4 — pre-LLM compaction. If estimated context usage already exceeds
    // the personality's pressure threshold (80% of the model's window by
    // default), the resolved context engine compacts before we hand the
    // history to the provider.
    const compacted = await this.maybeCompact(llmMessages, systemPrompt ?? '', personality, {
      sessionId,
      sessionKey,
      turnNumber,
      lastCompactionTurn,
    });
    llmMessages = compacted.messages;
    // F2 — cache breakpoints from the compaction, forwarded to every provider
    // call this turn so the prompt cache survives the compacted prefix.
    const cacheBreakpoints = compacted.cacheBreakpoints;
    // V1 — surface a one-line in-chat compaction notice. Emitted once, before
    // any response text, via the `tool_progress` + `audience: 'user'` channel
    // the framework already uses for `_budget` / `_watcher` notices.
    if (compacted.notice) {
      const n = compacted.notice;
      const tok = n.summaryTokens > 0 ? `, ${n.summaryTokens} tok` : '';
      yield {
        type: 'tool_progress',
        toolName: '_compaction',
        message: `compressed ${n.droppedCount} earlier message(s) (${n.engineName}${tok})`,
        audience: 'user',
      };
    }
    let fullText = '';
    let turnCount = 0;

    // Tool-call budget tracking — prevents runaway loops (see IMPROVEMENT.md P1-3).
    // Counted across all iterations within a single user turn.
    let totalToolCalls = 0;
    let successfulToolCalls = 0;
    const toolNameCounts = new Map<string, number>();

    // Dry-run tracking — accumulates across all iterations of a turn.
    const dryRunCap = opts.dryRun ? (opts.dryRunMaxToolCalls ?? 5) : Infinity;
    let dryRunCallCount = 0;
    let dryRunCapped = 0;
    const dryRunPlan: DryRunToolPlan[] = [];

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

      // Compute tool definitions once for hooks, LLM call, and dump store.
      const toolDefs = this.tools.toDefinitions(allowedTools, filterOpts);
      const requestId = randomUUID();
      const includeContent = obsConfig?.storeLlmPayloads === 'full';

      // Fire before_llm_call — content only included when personality opts in
      await this.hooks.fireVoid(
        'before_llm_call',
        {
          sessionId,
          model: this.llm.model,
          turnNumber: turnCount,
          requestId,
          ...(includeContent
            ? { system: systemPrompt, tools: toolDefs, messages: llmMessages }
            : {}),
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

      // Consume one-shot tier escalation from think_deeper tool result (run-local).
      let iterModelOverride = modelOverride;
      if (pendingTierEscalation && typeof personality.model === 'object') {
        const tier = pendingTierEscalation;
        pendingTierEscalation = undefined;
        const { model: tierModel } = this.resolveModelWithTier(personality, tier);
        iterModelOverride = tierModel !== this.llm.model ? tierModel : undefined;
        this.observability?.recordTierEscalation({
          traceId: traceId ?? '',
          from: activeTier,
          to: tier,
          reason: 'tool_escalation',
          personalityId: personality.id,
        });
      }

      const llmSpanId = this.observability?.startSpan({
        traceId: traceId ?? '',
        kind: 'llm_call',
        name: iterModelOverride ?? this.llm.model ?? 'unknown',
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
        const stream = this.llm.complete(llmMessages, toolDefs, {
          system: systemPrompt,
          cacheSystemPrompt: true,
          abortSignal: combinedSignal,
          ...(iterModelOverride ? { modelOverride: iterModelOverride } : {}),
          ...(cacheBreakpoints ? { cacheBreakpoints } : {}),
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.topP !== undefined ? { topP: opts.topP } : {}),
          ...(opts.maxCompletionTokens !== undefined
            ? { maxTokens: opts.maxCompletionTokens }
            : {}),
          ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        });

        for await (const chunk of stream) {
          if (abortSignal.aborted) break;
          if (watchdogController.signal.aborted) break;
          armWatchdog();
          if (chunk.type === 'done') llmFinishReason = chunk.finishReason;
          if (chunk.type === 'usage') {
            llmCacheReadTokens += chunk.usage.cacheReadTokens;
            llmCacheCreationTokens += chunk.usage.cacheCreationTokens;
            llmEstimatedCostUsd += chunk.usage.estimatedCostUsd;
            if (chunk.usage.requestTokens) llmRequestTokens = chunk.usage.requestTokens;
          }
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

      // Fire after_llm_call — content gated by personality observability config
      const llmDurationMs = Date.now() - llmStartTs;
      await this.hooks.fireVoid(
        'after_llm_call',
        {
          sessionId,
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
            ? { system: systemPrompt, tools: toolDefs, messages: llmMessages }
            : {}),
        },
        allowedPlugins,
      );

      // Append to request dump store if wired (awaited for reliability).
      // Content fields only included when personality observability opts in.
      if (this.requestDumpStore) {
        await this.requestDumpStore.append({
          requestId,
          timestamp: new Date().toISOString(),
          sessionId,
          personalityId: personality.id,
          turnNumber: turnCount,
          model: iterModelOverride ?? this.llm.model,
          durationMs: llmDurationMs,
          requestTokens: llmRequestTokens,
          responseTokens: llmOutputTokens || undefined,
          cacheReadTokens: llmCacheReadTokens || undefined,
          cacheCreationTokens: llmCacheCreationTokens || undefined,
          estimatedCostUsd: llmEstimatedCostUsd || undefined,
          finishReason: llmFinishReason,
          ...(includeContent
            ? {
                system: systemPrompt,
                tools: toolDefs,
                messages: llmMessages,
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
        audience: 'internal' | 'user' | 'dashboard';
      }> = [];

      const scopedStorage = this.buildScopedStorage(personality);

      // FW-28 — retrieve or create the per-session mtime registry for this turn.
      let sessionMtimes = this.sessionReadMtimes.get(sessionKey);
      if (!sessionMtimes) {
        sessionMtimes = new Map();
        this.sessionReadMtimes.set(sessionKey, sessionMtimes);
      }

      const toolCtxBase = {
        sessionId,
        sessionKey,
        platform: this.platform,
        workingDir: this.workingDir,
        agentId: opts.agentId,
        personalityId: personality.id,
        memoryScopeId: memScopeId,
        ...(userScopeId ? { userScopeId } : {}),
        ...(this.teamId !== undefined && { teamId: this.teamId }),
        ...(opts.dryRun ? { dryRun: true as const } : {}),
        currentTurn: turnCount,
        messageCount: allMessages.length + turnCount,
        abortSignal,
        emit: (event: {
          type: 'progress';
          toolName: string;
          message: string;
          percent?: number;
          audience?: 'internal' | 'user' | 'dashboard';
        }) => {
          progressBuffer.push({
            toolName: event.toolName,
            message: event.message,
            ...(event.percent !== undefined && { percent: event.percent }),
            audience: event.audience ?? 'internal',
          });
        },
        resultBudgetChars: this.resultBudgetChars,
        readMtimes: sessionMtimes,
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
          this.observability?.recordSafetyBlock({
            traceId,
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
          this.observability?.recordSafetyBlock({
            traceId,
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

        // MCP reject_args policy — checked after hooks so modified args are evaluated.
        const rejectError = checkMcpRejectArgs(this.mcpPolicy, tc.toolName, effectiveArgs);
        if (rejectError) {
          this.observability?.recordSafetyBlock({
            traceId,
            code: 'tool_blocked',
            cause: rejectError,
          });
          observe({ type: 'tool_end', toolName: tc.toolName, ok: false });
          yield {
            type: 'tool_end',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            ok: false,
            durationMs: 0,
            result: rejectError,
          };
          prepped.push({
            toolCallId: tc.toolCallId,
            name: tc.toolName,
            args: effectiveArgs,
            rejected: rejectError,
          });
          continue;
        }

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

      // Ch.6a — if observe() of any tool_start in this batch produced
      // a non-allow decision, mark every still-unrejected tool as
      // rejected and skip executeParallel. The decision was emitted
      // BEFORE the tool ran; we must not let it run anyway. This is
      // the bug Codex called out: the iteration-top check would only
      // fire AFTER the batch executed.
      const haltDuringBatch = getHalt();
      if (haltDuringBatch) {
        for (const p of prepped) {
          if (p.rejected === undefined) {
            p.rejected = `Watcher halted before execution: ${haltDuringBatch.reason}`;
          }
        }
      }

      // Execute only non-rejected tools; results keyed by toolCallId
      const execInputs = prepped
        .filter((p) => p.rejected === undefined)
        .map((p) => ({ toolCallId: p.toolCallId, name: p.name, args: p.args }));

      const startedAt = Date.now();
      const execResults =
        execInputs.length > 0
          ? await this.tools.executeParallel(
              execInputs,
              toolCtxBase,
              allowedTools,
              filterOpts,
              opts.attachments,
            )
          : [];
      const execResultMap = new Map(execResults.map((r) => [r.toolCallId, r]));

      // Dry-run plan collection — record every executed tool call and track the cap.
      if (opts.dryRun) {
        for (const input of execInputs) {
          dryRunPlan.push({
            toolCallId: input.toolCallId,
            toolName: input.name,
            args: redactArgs(input.args),
          });
          dryRunCallCount++;
          if (dryRunCallCount >= dryRunCap) {
            // Count remaining tool calls in this batch that will be capped
            const remaining = execInputs.length - execInputs.indexOf(input) - 1;
            dryRunCapped += remaining;
            break;
          }
        }
      }

      // Detect think_deeper tool success → set run-local tier escalation for next LLM call.
      // Only fires when: (1) the personality declares a tier object, (2) its provider matches
      // the active LLM, and (3) the tool named 'think_deeper' returned ok.
      if (typeof personality.model === 'object' && personality.provider === this.llm.name) {
        for (const r of execResults) {
          if (r.name === 'think_deeper' && r.result.ok) {
            pendingTierEscalation = 'deep';
            break;
          }
        }
      }

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
          if (result.ok) successfulToolCalls++;
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

          // E5 — surface the touched filesystem path so subscribers (e.g. the
          // file-context injector's progressive discovery) can react to where
          // the agent is navigating without scanning every tool's args
          // themselves.
          const touchedPath = extractFilePath(p.args);
          if (touchedPath !== undefined) {
            await this.hooks.fireVoid(
              'tool_end_with_path',
              {
                sessionId,
                personalityId: personality.id,
                toolName: p.name,
                filePath: touchedPath,
                workingDir: this.workingDir,
              },
              allowedPlugins,
            );
          }

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
                this.observability?.recordSafetyBlock({
                  traceId,
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

      // FW-9 — drain SteerSink at the iteration seam. Each entry becomes a
      // `[USER STEER]: <text>` text block appended to the tool_results user
      // message. Also persisted as a `user_steer` row for transcript fidelity
      // so a future getMessages() call replays the steer cleanly.
      if (opts.steerSink) {
        const steers = opts.steerSink.drain();
        for (const steerText of steers) {
          toolResultContent.push({ type: 'text', text: `[USER STEER]: ${steerText}` });
          await this.session.appendMessage({
            sessionId,
            role: 'user_steer',
            content: steerText,
          });
        }
      }

      // Feed all tool results back to LLM as a single user message with content blocks
      llmMessages.push({ role: 'user', content: toolResultContent });
    }

    // Step 10: Memory writes flow through the `memory_save` tool during the
    // turn (see extensions/tools-memory). The agent-loop itself produces no
    // updates, so there's nothing to sync here.

    // Step 11: Update usage
    await this.session.updateUsage(sessionId, { apiCallCount: turnCount });

    // Step 12: Fire agent_done. The optional fields (E3) let the
    // skill-evolver auto-trigger decide whether the turn was substantive
    // enough to queue an analysis.
    await this.hooks.fireVoid(
      'agent_done',
      {
        sessionId,
        text: fullText,
        turnCount,
        personalityId: personality.id,
        successfulToolCalls,
        totalToolCalls,
        toolNames: [...toolNameCounts.keys()],
        initialPrompt: text,
      },
      allowedPlugins,
    );

    if (traceId) this.observability?.endTrace(traceId, 'ok');
    this.observability?.flush();

    yield { type: 'done', text: fullText, turnCount };

    if (opts.dryRun && dryRunPlan.length > 0) {
      yield {
        type: 'dry_run_summary' as const,
        plan: dryRunPlan,
        capped: dryRunCapped,
      };
    }
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

  // Q1 — tool-result dedup. A coordinator that re-reads the same file across
  // turns stores one tool_result per read; over a long session that is pure
  // token waste. Before building the LLM-facing history, collapse exact-
  // duplicate tool results — same tool, same args, same output — keeping the
  // FIRST (oldest) copy intact and replacing later ones with a placeholder
  // that points BACKWARD at it. Pointing backward preserves causality: the
  // assistant turn that followed a later read can still see the content
  // earlier in the transcript. The tool_result row stays attached to its
  // tool_use (Anthropic contract); only the content string changes.
  private dedupHistory(history: StoredMessage[]): StoredMessage[] {
    // tool_use id → serialized args, harvested from assistant messages so a
    // tool_result can be keyed by the arguments that produced it.
    const argsByToolCallId = new Map<string, string>();
    for (const msg of history) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          argsByToolCallId.set(tc.id, JSON.stringify(tc.input ?? null));
        }
      }
    }

    // Fingerprint each tool_result and group occurrences by identity.
    const occurrences = new Map<string, number[]>();
    history.forEach((msg, idx) => {
      if (msg.role !== 'tool_result') return;
      const toolName = msg.toolName ?? '';
      const argsHash = msg.toolCallId ? (argsByToolCallId.get(msg.toolCallId) ?? '') : '';
      const fingerprint = createHash('sha256')
        .update(`${toolName}\u0000${argsHash}\u0000${msg.content.trim()}`)
        .digest('hex');
      const list = occurrences.get(fingerprint);
      if (list) list.push(idx);
      else occurrences.set(fingerprint, [idx]);
    });

    // For every fingerprint seen more than once, keep the first occurrence and
    // replace every later one with a placeholder pointing back at it.
    const replacement = new Map<number, string>();
    for (const indices of occurrences.values()) {
      if (indices.length < 2) continue;
      const oldest = indices[0];
      if (oldest === undefined) continue;
      const oldestId = history[oldest]?.toolCallId ?? String(oldest);
      for (const idx of indices.slice(1)) {
        replacement.set(
          idx,
          `[deduped — identical to earlier result, see tool_use id ${oldestId}]`,
        );
      }
    }

    if (replacement.size === 0) return history;
    return history.map((msg, idx) => {
      const placeholder = replacement.get(idx);
      return placeholder !== undefined ? { ...msg, content: placeholder } : msg;
    });
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
      } else if (msg.role === 'user_steer') {
        // Steer text is already embedded as a [USER STEER]: <text> block inside
        // the tool_result user message that was constructed live during the turn.
        // The stored user_steer row exists for transcript fidelity / debugging
        // only — it must NOT be replayed as a standalone LLM message.
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
        this.observability?.recordSafetyBlock({
          traceId,
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

  // ---------------------------------------------------------------------------
  // E4 — pre-LLM compaction. Resolves the personality's context engine and
  // calls into it when estimated context usage exceeds the pressure
  // threshold (80% of the model's window). When the personality declares no
  // engine, we still resolve to `drop_oldest` — but the engine is only
  // *invoked* when there is real pressure, so static configs see no change.
  // ---------------------------------------------------------------------------
  private async maybeCompact(
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
    const window = this.llm.maxContextTokens || 200_000;
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
    const engine = this.contextEngines.get(engineName) ?? this.contextEngines.get('drop_oldest');
    if (!engine) return { messages };
    try {
      const startedAt = Date.now();
      const result = await engine.compact({
        messages,
        currentSystem: systemPrompt,
        targetTokens: target,
        personality,
        sessionMetadata,
      });
      const durationMs = Date.now() - startedAt;
      this.observability?.recordCompaction({
        code: 'context_compacted',
        cause: `${engine.name}: ${result.notes}`,
      });
      // F3 — persist the compaction event so the session stays auditable. The
      // original messages remain in `messages`; this row only records the
      // LLM-facing replay change. Best-effort: a persistence failure must not
      // break the turn, so it never propagates to the fail-open catch below.
      const changed =
        result.messages.length !== messages.length || result.summaryText !== undefined;
      const summaryTokens = result.summaryText ? estimateTokens(result.summaryText) : 0;
      if (changed) {
        try {
          await this.session.recordCompression({
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
          await this.session.updateUsage(sessionMetadata.sessionId, { compactionCount: 1 });
          // Q2 — mark this turn so the cooldown suppresses the next few turns.
          await this.session.recordCompactionTurn(
            sessionMetadata.sessionId,
            sessionMetadata.turnNumber,
          );
        } catch (persistErr) {
          this.observability?.recordCompaction({
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
        ...(changed && result.cacheBreakpoints
          ? { cacheBreakpoints: result.cacheBreakpoints }
          : {}),
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
      this.observability?.recordCompaction({
        severity: 'warn',
        code: 'context_engine_failed',
        cause: err instanceof Error ? err.message : String(err),
      });
      return { messages };
    }
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

// `defaultAlwaysDeny` lives in `@ethosagent/storage-fs` — imported above
// so both ScopedStorage (this layer) and ScopedFsImpl (capability layer)
// consume one source of truth.

function substitute(
  template: string,
  vars: { ethosHome: string; self: string; cwd: string },
): string {
  return template
    .replace(/\$\{ETHOS_HOME\}/g, vars.ethosHome)
    .replace(/\$\{self\}/g, vars.self)
    .replace(/\$\{CWD\}/g, vars.cwd);
}

// E5 — best-effort filesystem-path extractor. Detects path-like arguments
// across the common file/edit/terminal tool shapes so the AgentLoop can fire
// `tool_end_with_path` without each tool re-implementing introspection.
// Returns undefined when no plausible path argument is present (e.g. pure web
// tools).
function extractFilePath(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  if (typeof a.path === 'string' && a.path.length > 0) return a.path;
  if (typeof a.file_path === 'string' && a.file_path.length > 0) return a.file_path;
  if (typeof a.filePath === 'string' && a.filePath.length > 0) return a.filePath;
  if (typeof a.cwd === 'string' && a.cwd.length > 0) return a.cwd;
  return undefined;
}

// ---------------------------------------------------------------------------
// MCP reject_args policy — standalone so it can be tested without constructing
// a full AgentLoop.  Evaluates the per-server / per-tool forbidden-arg-value
// rules from mcp.yaml.  Returns an error string when the call should be
// rejected, or undefined when it is allowed through.
// ---------------------------------------------------------------------------
export function checkMcpRejectArgs(
  mcpPolicy: import('@ethosagent/types').McpPolicy | undefined,
  toolName: string,
  args: unknown,
): string | undefined {
  const servers = mcpPolicy?.servers;
  if (!servers || !toolName.startsWith('mcp__')) return undefined;

  const firstSep = toolName.indexOf('__');
  const secondSep = toolName.indexOf('__', firstSep + 2);
  if (secondSep === -1) return undefined;

  const server = toolName.slice(firstSep + 2, secondSep);
  const bareTool = toolName.slice(secondSep + 2);
  const argRules = servers[server]?.reject_args?.[bareTool];
  if (!argRules) return undefined;

  const typedArgs = args as Record<string, unknown>;
  for (const [argName, forbiddenValues] of Object.entries(argRules)) {
    const value = typedArgs[argName];
    if (typeof value === 'string' && forbiddenValues.includes(value)) {
      return `MCP policy: argument '${argName}' value '${value}' is rejected for tool '${bareTool}' on server '${server}'`;
    }
  }
  return undefined;
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
