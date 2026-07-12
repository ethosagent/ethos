export type ToolResult =
  | {
      ok: true;
      /**
       * Human/LLM-readable string. Always present. Multimodal or
       * structured-data tools populate `structured` alongside and use
       * `value` as a concise text summary so the LLM has something to
       * react to without parsing JSON.
       */
      value: string;
      /**
       * Optional structured payload for tools that produce non-string
       * results — image bytes (as base64 or a path), tabular data, JSON
       * documents, multi-part content. Consumers that don't know about a
       * tool's specific structured shape SHOULD ignore this field; the
       * `value` string carries the authoritative summary.
       *
       * Added in v0.x. Forward-compatible: existing tools never set this
       * and existing consumers never read it; adding it later in a
       * release that already has external `ToolResult` consumers
       * (plugin authors, SDK clients) would force a typed break.
       */
      structured?: Record<string, unknown>;
      cost_usd?: number;
    }
  | { ok: false; code: 'input_invalid'; error: string; field?: string }
  | { ok: false; code: 'not_available'; error: string; reason?: string }
  | { ok: false; code: 'execution_failed'; error: string; cause?: unknown }
  | { ok: false; code: 'STALE_WRITE'; error: string; conflictKey?: string };

export interface ToolProgressEvent {
  type: 'progress';
  toolName: string;
  message: string;
  percent?: number;
  /**
   * Phase 30.2 — audience boundary.
   *
   * `'internal'` (default when absent): consumed by the framework only —
   * logs, telemetry, dev-mode TUI. Channel adapters (telegram, discord,
   * slack, whatsapp, email) and `apps/ethos/src/commands/chat.ts` MUST NOT
   * surface it to the user.
   *
   * `'user'`: explicit opt-in by the tool author — surfaced in the user-
   * visible stream. Use sparingly: long-running operations where silent
   * latency would be confusing (`read_file` reading >1MB, multi-step
   * `bash` commands). Per-event opt-in; the framework never opts in for
   * the tool.
   */
  audience?: 'internal' | 'user' | 'dashboard';
}

export interface ToolContext {
  sessionId: string;
  sessionKey: string;
  platform: string;
  workingDir: string;
  agentId?: string;
  /**
   * Where this turn originated, as `platform:chatId` for channel turns (else unset).
   * Generic per-run context; goal_create reads it to stamp Goal.origin.
   */
  origin?: string;
  /**
   * Set by the A2A runner when this turn is servicing an inbound A2A task; the
   * outbound A2A tool threads it so an onward call signs `depth + 1` and consumes
   * the per-trace fan-out budget (plan §P8). Absent for normal turns.
   */
  a2aDelegation?: { traceId: string; depth: number; reserveOutbound: () => boolean };
  /** Active personality for this turn. Tools that touch memory must thread this through. */
  personalityId?: string;
  /**
   * Opaque scope id resolved by AgentLoop. Memory tools use it directly
   * to derive `personality:<id>` from personalityId.
   */
  memoryScopeId?: string;
  /**
   * Opaque user scope id resolved by AgentLoop. When present, memory tools use it
   * for `store='user'` instead of the personality scope. Shape: `user:<userId>`.
   */
  userScopeId?: string;
  /**
   * Active team id for this turn. Set by AgentLoop when the loop runs inside a team
   * (WiringConfig.teamName is set). Team memory tools use this to build the
   * `team:<id>` scope id for the team-scoped MemoryProvider.
   * Absent when running solo (no team context).
   */
  teamId?: string;
  currentTurn: number;
  messageCount: number;
  abortSignal: AbortSignal;
  emit: (event: ToolProgressEvent) => void;
  resultBudgetChars: number;
  /**
   * Per-turn Storage decorated by ScopedStorage with the active personality's
   * fs_reach allowlist. Tools that touch the filesystem (read_file,
   * write_file, patch_file, search_files) must route reads/writes through
   * this rather than `node:fs/promises` directly so the personality boundary
   * is enforced. Optional because not every consumer wires it (CLI/tests
   * may pass a tool execution context without storage); tools fall back to
   * unrestricted fs in that case.
   */
  storage?: import('./storage').Storage;
  /**
   * FW-28 — per-run mtime registry. Keyed by absolute path; populated by
   * read_file after each successful read. write_file / patch_file check
   * this before writing: if the on-disk mtime differs from the recorded
   * value the write is refused with STALE_WRITE, preventing silent
   * clobber of externally-modified files.
   *
   * Optional — absent in tests that don't wire AgentLoop; tools skip the
   * check when the map is undefined.
   */
  readMtimes?: Map<string, { mtimeMs: number; readAtTurn: number }>;
  /**
   * Ch.7 — per-personality network reach policy. URL-capable tools must
   * thread this through `safeFetch` from `@ethosagent/safety-network`
   * rather than calling `fetch()` directly so the policy + cloud-metadata
   * + private-network + redirect-revalidation pipeline runs. Optional —
   * tests / CLI without a personality leave it undefined and tools apply
   * the open-public-internet defaults (the always-deny floor still fires).
   *
   * The shape is duplicated from PersonalitySafetyConfig.network rather
   * than re-imported because @ethosagent/types is the lowest level — it
   * cannot depend on extension types.
   */
  networkPolicy?: {
    allow?: string[];
    deny?: string[];
    allow_private_urls?: boolean;
  };
  kvStore?: import('./tool-capabilities').KeyValueStore;
  secretsResolver?: import('./tool-capabilities').ScopedSecretsResolver;
  scopedFetch?: import('./tool-capabilities').ScopedFetch;
  scopedFs?: import('./tool-capabilities').ScopedFs;
  scopedProcess?: import('./tool-capabilities').ScopedProcess;
  attachments?: import('./tool-capabilities').ScopedAttachments;
  dryRun?: boolean;
  getContext?: <T>(key: string) => T | undefined;
  setContext?: <T>(key: string, value: T) => void;
  llm?: import('./plugin-llm').SimpleCompletion;
}

export interface CacheOptions {
  ttlMs?: number;
  keyFn?: (args: unknown) => string;
}

export interface Tool<TArgs = unknown> {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  toolset?: string;
  maxResultChars?: number;
  capabilities: import('./tool-capabilities').ToolCapabilities;
  execute: (args: TArgs, ctx: ToolContext) => Promise<ToolResult>;
  isAvailable?: () => boolean;
  /**
   * When true, this tool is always included in the LLM's tool list regardless
   * of the personality's toolset restriction. Use only for framework-internal
   * tools that must always be reachable (e.g. `get_skill`).
   */
  alwaysInclude?: boolean;
  /**
   * Phase Ch.3a — provenance tagging.
   *
   * When true, the tool's success output is treated as adversary-controlled
   * (file content, web pages, email bodies, subprocess stdout) and AgentLoop
   * sanitizes chat-template tokens then wraps the result in an
   * `<untrusted source="..." tool="...">…</untrusted>` block before placing
   * it into the LLM's context. Falsy = trusted (owner-authored content like
   * memory files or the agent's own tool listing).
   */
  outputIsUntrusted?: boolean;
  requiresApproval?: boolean;
  returnDirect?: boolean;
  outputSchema?: Record<string, unknown>;
  cache?: boolean | CacheOptions;
  preferredModel?: string;
  strict?: boolean;
}

/**
 * Serializable request envelope sent from the registry to the transport.
 * All fields are JSON-serializable — no live objects, no callbacks.
 */
export interface ToolExecuteRequest {
  toolCallId: string;
  name: string;
  args: unknown;
  sessionId: string;
  sessionKey: string;
  platform: string;
  workingDir: string;
  personalityId?: string;
  teamId?: string;
  agentId?: string;
  origin?: string;
  memoryScopeId?: string;
  userScopeId?: string;
  currentTurn: number;
  messageCount: number;
  resultBudgetChars: number;
  networkPolicy?: { allow?: string[]; deny?: string[]; allow_private_urls?: boolean };
  dryRun?: boolean;
}

/**
 * Protocol boundary between core (AgentLoop + ToolRegistry) and tool execution.
 * `signal` is a separate param — lifecycle control, not payload.
 * Local transport propagates it directly; an HTTP transport uses it to abort
 * the underlying fetch.
 */
export interface ToolTransport {
  execute(request: ToolExecuteRequest, signal: AbortSignal): Promise<ToolResult>;
}

/** Options for filtering tools beyond the `allowedTools` name list. */
export interface ToolFilterOpts {
  /**
   * MCP server allowlist. Tools named `mcp__<server>__*` are excluded
   * unless their server name is in this list. undefined = no MCP filter.
   */
  allowedMcpServers?: string[];
  /**
   * Plugin allowlist. Tools registered by a plugin are excluded unless
   * their pluginId is in this list. undefined = allow all plugin tools.
   * [] = only built-in (non-plugin) tools.
   */
  allowedPlugins?: string[];
  /**
   * Per-server MCP tool allowlist. Maps server name to list of allowed bare
   * tool names (the part after `mcp__<server>__`). A server absent from
   * this map means all its tools pass. A server present with a list means
   * only the listed tools pass. undefined = no per-tool filter.
   */
  allowedMcpTools?: Record<string, string[]>;
}

export interface ToolRegistry {
  /** `opts.pluginId` tags the tool for per-personality plugin gating. */
  register(tool: Tool, opts?: { pluginId?: string }): void;
  registerAll(tools: Tool[]): void;
  unregister(name: string): void;
  get(name: string): Tool | undefined;
  getAvailable(): Tool[];
  getForToolset(toolset: string): Tool[];
  /** v2.2 — Return the plugin id that registered a tool, if any. */
  getPluginId?(name: string): string | undefined;
  executeParallel(
    calls: Array<{ toolCallId: string; name: string; args: unknown }>,
    ctx: ToolContext,
    allowedTools?: string[],
    filterOpts?: ToolFilterOpts,
    turnAttachments?: import('./platform').Attachment[],
    filters?: import('./tool-filter').ToolInvocationFilter[],
  ): Promise<Array<{ toolCallId: string; name: string; result: ToolResult }>>;
  toDefinitions(
    allowedTools?: string[],
    filterOpts?: ToolFilterOpts,
  ): import('./llm').ToolDefinitionLite[];
}
