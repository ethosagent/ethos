export interface PersonalityObservabilityConfig {
  storeToolArgs?: 'none' | 'redacted' | 'full';
  storeToolBodies?: 'none' | 'redacted' | 'full';
  storeLlmPayloads?: 'none' | 'metadata' | 'full';
  redactPatterns?: string[];
}

export interface PersonalitySafetyConfig {
  observability?: PersonalityObservabilityConfig;
  /**
   * Opt-in allowlist for skill-declared permissions. When absent, skills that
   * declare sensitive permissions are warned about but still loaded (backward
   * compat). When present, each category is enforced against declared values:
   *   true          — any value for that category is allowed
   *   string[]      — only the listed paths/hosts/vars are allowed; any
   *                   undeclared value causes the skill to be rejected
   *   false/absent  — no value for that category is allowed
   */
  allowed_skill_permissions?: {
    fs_read?: string[] | boolean;
    fs_write?: string[] | boolean;
    network?: string[] | boolean;
    mcp_env_passthrough?: string[] | boolean;
  };
  /**
   * Ch.4b — Approval mode selector.
   *
   *   `manual` (default): every `dangerous` classification surfaces the
   *     approval modal; `safe` auto-fires; `blocked` (the hardline floor)
   *     errors out. Use for interactive pairing.
   *   `smart`:  an auxiliary fast-model call reviews each `dangerous`
   *     classification and either auto-approves, auto-denies, or escalates
   *     to manual. Trades latency + $ for reduced approval fatigue.
   *   `off`:    `dangerous` classifications auto-fire without prompt; the
   *     hardline floor (Ch.4a) STILL applies. Invalid combination with any
   *     channel ingress — config rejected at load time when `off` is paired
   *     with telegram/discord/slack/email/whatsapp/etc bindings.
   */
  approvalMode?: 'manual' | 'smart' | 'off';
  /**
   * Ch.7 — Per-personality network reach. Layered with the always-deny
   * cloud-metadata + private-network floor (non-overridable) and the
   * scheme allowlist (http/https only). Empty/absent = open public
   * internet (subject to floor); non-empty `allow` = allowlist mode.
   */
  network?: {
    allow?: string[];
    deny?: string[];
    /** Opt-in for RFC1918 / loopback / link-local. Cloud-metadata still
     *  blocked even when this is true (Ch.7b is non-overridable). */
    allow_private_urls?: boolean;
  };
  /**
   * Ch.3 — Prompt-injection runtime defenses. All sub-blocks default to safe
   * values when absent, so a personality with no `injectionDefense` block
   * still gets provenance wrapping on `outputIsUntrusted` tools and a 2-turn
   * post-read downgrade for the default dangerous-tool list.
   */
  injectionDefense?: {
    /** Master switch. Default: true. Setting `false` skips wrapping, pattern
     *  check, and post-read downgrade — used by tests and headless tooling. */
    enabled?: boolean;
    /** Tier-2 LLM classifier policy. Tier-1 regex always runs when enabled. */
    classifier?: {
      /**
       * Force the LLM classifier to fire on every `outputIsUntrusted` result
       * regardless of length / pattern hits. Default false — Tier-2 only fires
       * when Tier-1 hits OR content > 500 chars.
       */
      alwaysCallLLM?: boolean;
    };
    /** Ch.3d — block dangerous tools for N turns after an untrusted read. */
    postReadDowngrade?: {
      /** Default true. */
      enabled?: boolean;
      /** Iterations the downgrade stays active. Default 2. */
      turns?: number;
      /**
       * Tools to downgrade. `'auto'` uses a built-in dangerous-tool list
       * (terminal, run_code, write_file, patch_file, web_extract, browse_url).
       * Explicit list overrides. Default `'auto'`.
       */
      tools?: string[] | 'auto';
    };
  };
}

export type ModelTierName = 'trivial' | 'default' | 'deep';

export interface PersonalityMemoryConfig {
  provider: string;
  options?: Record<string, unknown>;
}

export interface PersonalityMcpExportConfig {
  enabled: boolean;
  expose_tools?: 'all' | 'none' | string[];
  expose_memory?: 'scoped' | 'none' | 'full';
  expose_sessions?: boolean;
  auth?: 'localhost' | 'bearer';
}

export interface OutboundPolicyConfig {
  approve_before_send: boolean;
  channels?: string[];
  approver_personality?: string;
}

export interface ModelTierConfig {
  trivial?: string;
  default?: string;
  deep?: string;
}

/**
 * Resolve model display string from a PersonalityConfig.model value.
 * Centralizes the typeof check so consumers don't scatter it.
 */
export function resolveModelDisplay(
  model: string | ModelTierConfig | undefined,
  fallback = '(engine default)',
): string {
  if (!model) return fallback;
  if (typeof model === 'string') return model;
  return model.default ?? fallback;
}

// Phase 30.8 — this schema is FROZEN.
//
// Adding a top-level field to `PersonalityConfig` requires:
//   1. A CHANGELOG entry justifying why it isn't a skill, a tool, or a memory section.
//   2. The `personality-schema-change` label on the PR.
//   3. Two-maintainer approval (enforced via branch protection).
//   4. Bumping the count in `.personality-field-count` at the repo root.
//
// The mechanical CI gate lives in
// `packages/types/src/__tests__/personality-field-count.test.ts`. It parses
// this interface at test time and fails if the count drifts from
// `.personality-field-count`. Culture sets the rule; CI enforces it.
//
// Common rejections — these belong in skills or per-channel adapter config,
// NOT here:
//   - voice modes / TTS settings
//   - emotion / mood / sentiment tags
//   - label or response templates
//   - per-channel UI affordances
export interface PersonalityConfig {
  /** @internal Personality directory name; populated by the loader, not user-set. */
  id: string;
  name: string;
  description?: string;
  /** @internal Absolute path to ETHOS.md; populated by the loader. */
  ethosFile?: string;
  /** @internal Absolute paths to skills directories; populated by the loader. */
  skillsDirs?: string[];
  toolset?: string[];
  capabilities?: string[];
  model?: string | ModelTierConfig;
  provider?: string;
  platform?: string;
  memoryScope?: 'global' | 'per-personality';
  /**
   * Per-personality streaming watchdog: if no chunk arrives from the LLM within
   * this many milliseconds, the agent aborts the stream and emits an error.
   * Reset on every chunk, so slow-but-progressing streams are unaffected.
   * Defaults to AgentLoop's `streamingTimeoutMs` (120000ms / 2 minutes).
   * Thinking-mode personalities (e.g. Opus extended thinking) may need longer;
   * fast-turnaround personalities (Haiku) can pick something tighter.
   * See plan/IMPROVEMENT.md P1-2 / OpenClaw #68596.
   */
  streamingTimeoutMs?: number;
  /**
   * Per-personality filesystem reach. When set, the read_file / write_file
   * tools route through a ScopedStorage that rejects paths outside these
   * absolute-prefix lists. Closes the personality_isolation Tier 1 #1 gap
   * — a researcher's read_file cannot peek at engineer's MEMORY.md.
   *
   * Substitutions resolved by AgentLoop at construction time:
   *   ${ETHOS_HOME} → ~/.ethos
   *   ${self}       → this personality's id
   *   ${CWD}        → AgentLoop.workingDir
   *
   * When unset, AgentLoop falls back to a default scope:
   *   read:  [~/.ethos/personalities/<self>/, ~/.ethos/skills/, ${CWD}]
   *   write: [~/.ethos/personalities/<self>/, ${CWD}]
   *
   * Counts as ONE field for the schema-freeze gate (the nested shape is
   * a leaf type).
   */
  fs_reach?: { read?: string[]; write?: string[] };
  /**
   * MCP servers this personality can reach. Server configs stay global in
   * ~/.ethos/mcp.json; this is a per-role allowlist keyed by server name.
   * Missing/empty = no MCP access for this personality (explicit opt-in).
   */
  mcp_servers?: string[];
  /**
   * Plugins attached to this personality. Default-deny: a plugin not listed
   * here is dormant for this personality — its tools, hooks, and injectors
   * do not fire. Missing/empty = no plugins active. Explicit opt-in only.
   */
  plugins?: string[];
  /**
   * Filter rules for skills from the universal scanner's global pool.
   * Per-personality skills/ folder is always loaded unfiltered.
   * When absent, defaults to `capability` mode (skills whose required_tools
   * are a subset of this personality's effective tool reach are included).
   */
  skills?: import('./skill').SkillIngestConfig;
  /**
   * Per-session spending cap in USD. When the running cost for the current
   * session key crosses this value, the next turn is refused with a typed
   * `BUDGET_EXCEEDED` error. Session-scoped only in v1 (resets on `/new`).
   * Absent = no cap (default behavior).
   */
  budgetCapUsd?: number;
  /**
   * Per-personality safety config. Currently carries `observability` sub-block
   * that controls what gets persisted in observability.db for this personality.
   */
  safety?: PersonalitySafetyConfig;
  /**
   * E4 — Name of the context-compaction engine to use when the conversation
   * approaches the model's context window. Resolved against the
   * `ContextEngineRegistry`; if the name is unknown, AgentLoop falls back to
   * the built-in `drop_oldest`. Counts as ONE field.
   */
  context_engine?: string;
  /**
   * E4 — Free-form per-engine options. Passed to the engine via
   * `personality.context_engine_options` so engines can read their own
   * configuration without inventing a new wiring channel. Counts as ONE field.
   */
  context_engine_options?: Record<string, unknown>;
  /**
   * E3 — Auto-triggered skill evolution. When `enabled: true`, the
   * skill-evolver auto-trigger queues an analysis after every turn that
   * crosses the `min_tool_calls` threshold and is outside the cooldown
   * window. Default: disabled (opt-in per personality). Counts as ONE
   * field for the schema-freeze gate (the nested shape is a leaf type).
   */
  skill_evolution?: {
    enabled?: boolean;
    min_tool_calls?: number;
    cooldown_minutes?: number;
  };
  /**
   * E5 — Workspace-aware context layering. Controls how the file-context
   * injector discovers `AGENTS.md` / `CLAUDE.md` files as the agent
   * navigates the workspace.
   *
   *   `static` (default): load context once at session start from `workingDir`.
   *   `progressive`: also discover sub-AGENTS.md as the agent reads/writes
   *      files; injected on the next turn.
   *   `off`: skip context-file injection entirely.
   *
   * Counts as ONE field for the schema-freeze gate (the nested shape is a
   * leaf type — same precedent as `fs_reach`).
   */
  context_layering?: {
    mode?: 'static' | 'progressive' | 'off';
    max_depth?: number;
    discovery_files?: string[];
    cap_total_chars?: number;
  };
  /**
   * Per-personality memory backend. When set, the personality uses a specific
   * memory provider instead of the global default. The `provider` value must
   * match a registered provider name (built-in: 'markdown', 'vector'; plugins
   * can register additional ones). `options` is passed to the provider factory.
   * Counts as ONE field for the schema-freeze gate.
   */
  memory?: PersonalityMemoryConfig;
  /**
   * Per-personality MCP server export. Declares what slice of the personality
   * is visible to external MCP clients. When `enabled: true`, the personality
   * can be served via `ethos mcp-server --personality <id>`.
   * Counts as ONE field for the schema-freeze gate.
   */
  mcp_export?: PersonalityMcpExportConfig;
  /**
   * Per-personality outbound approval policy. When `approve_before_send` is
   * true, the gateway holds outbound messages in a pending queue until approved.
   * Counts as ONE field for the schema-freeze gate.
   */
  outbound_policy?: OutboundPolicyConfig;
}

export interface PersonalityRegistry {
  define(config: PersonalityConfig): void;
  get(id: string): PersonalityConfig | undefined;
  list(): PersonalityConfig[];
  getDefault(): PersonalityConfig;
  setDefault(id: string): void;
  loadFromDirectory(dir: string): Promise<void>;
  /**
   * Remove a personality from the in-memory registry. Used by surfaces
   * that delete the on-disk directory (e.g. the web Personalities tab) —
   * `loadFromDirectory` only adds; a separate primitive is needed to
   * forget. Callers must also clear any associated FS state; this method
   * only mutates the registry's own map. No-op if the id is unknown.
   */
  remove(id: string): void;
}
