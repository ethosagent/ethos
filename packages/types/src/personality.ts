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
   * User-defined deny rules — the floor beneath `approvalMode`.
   *
   * Each entry is a case-sensitive substring matched against
   * `` `${toolName} ${canonical-json-args}` ``, so a rule like
   * `git push --force` matches a `terminal` call whose `command` argument
   * contains that text. A match denies the call outright: no approval card,
   * no allowlist, no human override.
   *
   * **The law:** deny rules are evaluated BEFORE every `before_tool_call` hook,
   * and therefore before the approval-mode dispatch. Modes can only make things
   * stricter, never looser — a deny rule binds even under `approvalMode: 'off'`
   * with the auto-approve capability flag set. Enforced by
   * `enforceBeforeToolCall` (`packages/core/src/agent-loop/stages/per-call-enforcement.ts`),
   * the one per-call site both the LLM batch path and the script bridge cross;
   * pinned by `packages/core/src/agent-loop/__tests__/deny-rule-gate.test.ts`.
   */
  denyRules?: string[];
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
   *
   * There is deliberately no master switch. ARCHITECTURE.md §V S6 makes the
   * inbound safety pipeline non-opt-out-able by personality, channel, or
   * tool; these knobs may only narrow behaviour within it, never remove it.
   */
  injectionDefense?: {
    /** Tier-2 LLM classifier policy. Tier-1 regex always runs. */
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
    /** Redact tool results that contain detected secrets. Default true (block); set false to emit only. */
    blockSecretResults?: boolean;
    /** Wrap tool results in ===TOOL_RESULT_START/<END>=== sentinels. Default true. */
    toolResultDelimiters?: boolean;
  };
  /** PII redaction applied to user messages before they enter LLM context. Opt-in. */
  piiRedaction?: {
    enabled: boolean;
    extraPatterns?: string[];
  };
}

export type ModelTierName = 'trivial' | 'default' | 'deep' | 'dreaming';

export interface PersonalityMemoryConfig {
  provider: string;
  options?: Record<string, unknown>;
}

/**
 * What ONE personality publishes to an external MCP client, and on what terms.
 *
 * The declaration is inert until the personality is served:
 * `ethos mcp serve --personality <id>` (`runServeExport`,
 * `apps/ethos/src/commands/mcp.ts`) builds a `PersonalityExportServer`
 * (`apps/mcp-server/src/export-server.ts`) that publishes exactly ONE tool,
 * `ask`. `ask` runs one whole `AgentLoop` turn with the personality, the
 * session key, `toolsetNarrow`, `toolsetExclude` and `skipMemoryPrefetch` all
 * pinned by the server — the client can name none of them, and there is no
 * `personality_id` parameter anywhere in its schema (pinned by "pins every run
 * option the client could otherwise name",
 * `apps/mcp-server/src/__tests__/export-server.test.ts`).
 *
 * `resolveMcpExportScope` (`packages/wiring/src/mcp-export.ts`) is the one
 * place this declaration becomes those bounds, and the server re-runs it —
 * after `refreshPersonalities()` — on EVERY call. That is what makes an edited
 * declaration and a revoked key take effect on the caller's next call rather
 * than at the next restart ("refuses an export disabled mid-process on the very
 * next call", same test file). What each value resolves to is pinned by
 * `packages/wiring/src/__tests__/mcp-export-scope.test.ts`.
 *
 * Written in `config.yaml` as flat dotted keys (`mcp_export.enabled: true`),
 * parsed by `buildMcpExportConfig` (`extensions/personalities/src/index.ts`).
 * A value outside the unions below is IGNORED there, leaving the fail-closed
 * default — `mcp_export.expose_memory: Scoped` resolves to `none`.
 *
 * LIMITATIONS, recorded rather than built (M-D15,
 * plan/phases/trust-before-reach.md):
 *
 *  - **No rate limit.** An admitted client may call as often as it likes.
 *    What bounds the cost is `budgetCapUsd` per session key
 *    (`AgentLoop.getPersonalityBudgetCap`, `packages/core/src/agent-loop.ts`),
 *    one in-flight `ask` per client (the `_inFlight` set in
 *    `PersonalityExportServer`, pinned by "allows at most one ask in flight per
 *    client"), and revoking the client's key. None of the three is a
 *    request-rate limit.
 *  - **No non-loopback bind and no TLS.** `serveMcpHttp`
 *    (`apps/mcp-server/src/http-session.ts`) throws for any host outside
 *    `127.0.0.1` / `localhost` / `::1` (pinned by "refuses a non-loopback
 *    bind", `apps/mcp-server/src/__tests__/export-http.test.ts`), and what it
 *    does carry is plaintext. A remote caller needs the operator's own
 *    TLS-terminating proxy in front.
 */
export interface PersonalityMcpExportConfig {
  /**
   * The export exists only when this is literally `true`. Anything else —
   * `false`, or no `mcp_export` block at all — takes `resolveMcpExportScope`'s
   * `declaration?.enabled !== true` branch, which grants nothing and excludes
   * every registered tool ("a personality with no mcp_export exports nothing
   * and excludes everything"). `buildMcpExportConfig` compares the YAML string
   * `=== 'true'`, so `yes`, `True` and `1` all parse as `false`.
   *
   * Setting it back to `false` withdraws the export on the caller's next call,
   * and `tools/list` then publishes nothing rather than advertising a tool
   * whose every call would be refused.
   */
  enabled: boolean;
  /**
   * Which tools the exported TURN may use. They are never published as MCP
   * tools — the client always sees just `ask` (M-D2): a whole turn is the only
   * way SOUL, `fs_reach`, the `before_tool_call` hooks, the watcher and the
   * injection prelude apply, and `ToolRegistry.executeParallel` on its own
   * would skip all of them.
   *
   * `allowed = expose_tools ∩ toolNamesForPersonality(personality)`, so this
   * key can only ever REMOVE reach: naming a tool the personality does not have
   * grants nothing and lands in `McpExportScope.dropped`, which the character
   * sheet and the serve summary print. `'all'` is the personality's full reach,
   * never the machine's; `'none'` — and an ABSENT key — is a conversation-only
   * specialist.
   *
   * The complement of `allowed` is passed as `toolsetExclude` as well
   * (`complementExclude`, M-D3), because `toolsetNarrow` gates built-ins only:
   * without it an `expose_tools: none` export could still call every `mcp__*`,
   * plugin and `alwaysInclude` tool on the machine.
   */
  expose_tools?: 'all' | 'none' | string[];
  /**
   * How much of this personality's OWN memory the exported turn reaches.
   * `'none'` (the default) sets `RunOptions.skipMemoryPrefetch` and strips both
   * memory tools; `'scoped'` keeps the loop's normal `personality:<id>`
   * prefetch and `memory_read`; `'full'` adds `memory_write`.
   *
   * No value reaches another personality, a team, or `user:<id>`: the memory
   * scope is fixed at `personality:<id>` by `setupTurn`
   * (`packages/core/src/agent-loop/stages/turn-setup.ts`) and the export never
   * sets `userId`. Memory is never published as an MCP resource either — the
   * export server's capabilities are `{ tools: {} }` and nothing else ("offers
   * no resources and no prompts").
   *
   * LIMITATION: the strip covers `memory_read`/`memory_write` only. The
   * `team_memory_*` tools are gated by the personality's toolset and
   * `expose_tools`, not by this key (`resolveMcpExportScope`).
   */
  expose_memory?: 'scoped' | 'none' | 'full';
  /**
   * Adds `list_conversations` and `get_conversation` beside `ask`. Default
   * `false`, and they are never offered when the host wired no session store.
   *
   * They see only THIS client's own conversations with THIS personality: both
   * build their key from the server-built prefix `mcp:<id>:<clientId>:`
   * (`exportSessionKeyPrefix`), so the operator's own `cli:` and `mcp-console:`
   * sessions with the same personality stay private, and no reachable input
   * names another client's (pinned by "cannot read another client's
   * conversation by naming it").
   */
  expose_sessions?: boolean;
  /**
   * How a caller proves it may ask at all.
   *
   * `'localhost'` (the default) is stdio only — `PersonalityExportServer.serveHttp`
   * throws rather than binding a port, because the boundary it relies on is
   * "whoever can spawn `ethos` as this OS user", and a listening socket is not
   * that boundary even on loopback ("refuses to serve a localhost export over
   * HTTP at all"). LIMITATION (M-D8): under `'localhost'`, two stdio clients
   * that self-report the same `clientInfo.name` share a session-key prefix, and
   * therefore each other's conversations (`stdioClientId`).
   *
   * `'bearer'` requires an `sk-ethos-` key carrying the scope `mcp:<id>`,
   * presented in `ETHOS_MCP_KEY` (stdio) or `Authorization` (HTTP) and verified
   * by `createMcpClientAuthenticator` (`packages/wiring/src/mcp-export.ts`) at
   * initialize AND on every call — so revoking it locks that client out on its
   * next call, and no one else ("refuses a REVOKED key — no restart needed",
   * `packages/wiring/src/__tests__/mcp-export-auth.test.ts`). A key minted for
   * another export or another surface is refused by the same check.
   */
  auth?: 'localhost' | 'bearer';
}

export interface OutboundPolicyConfig {
  approve_before_send: boolean;
  channels?: string[];
  approver_personality?: string;
}

/**
 * How a personality's call LOOKS (DESIGN.md § "Call Stage"). Three treatments,
 * all driven by the same amplitude signal — only the shape differs.
 */
export type CallTreatment = 'liquid' | 'orb' | 'rings';

/** The treatments in a fixed order. The derivation below indexes into this. */
export const CALL_TREATMENTS: readonly CallTreatment[] = ['liquid', 'orb', 'rings'];

/**
 * The treatment a personality gets when nobody picked one.
 *
 * Content-addressed on the id, so the same personality draws the same shape on
 * every machine and across restarts — a look that is part of who it is, not an
 * accident of insertion order or a random seed. Deliberately the same hash
 * `accentFor` in `@ethosagent/design-tokens` uses for the accent: one
 * derivation shape for "identity → look", not two.
 */
export function derivedCallTreatment(personalityId: string): CallTreatment {
  let hash = 0;
  for (let i = 0; i < personalityId.length; i++) {
    hash = (hash * 31 + personalityId.charCodeAt(i)) | 0;
  }
  return CALL_TREATMENTS[Math.abs(hash) % CALL_TREATMENTS.length] ?? 'liquid';
}

/**
 * The ONE precedence rule for which treatment a call draws. Every surface calls
 * this — a second copy of the order is a second answer to the same question.
 *
 *   1. The personality's own `voice.call_style` — explicit identity wins.
 *   2. The operator's `display.call_style`, when it names a concrete treatment
 *      (`personality`, the default, is not a pin — it defers to step 3).
 *   3. Derived from the personality id, so every personality has a distinct
 *      look with nothing configured.
 */
export function resolveCallTreatment(input: {
  personalityId: string;
  /** `PersonalityConfig.voice.call_style`. */
  personalityCallStyle?: CallTreatment | undefined;
  /** `display.call_style` from `~/.ethos/config.yaml`. */
  operatorCallStyle?: CallTreatment | 'personality' | undefined;
}): CallTreatment {
  if (input.personalityCallStyle) return input.personalityCallStyle;
  const operator = input.operatorCallStyle;
  if (operator && operator !== 'personality') return operator;
  return derivedCallTreatment(input.personalityId);
}

/**
 * How a personality SOUNDS, and how its call LOOKS. The sanctioned exception to
 * the "no voice/speech fields on PersonalityConfig" rule (voice V1a,
 * eng-review D2), widened by the personality-presentation amendment: a
 * deployment chooses the voice PROVIDER, the personality chooses its own voice
 * and its own call treatment, the same way it chooses its own model.
 * Everything that is a deployment or per-channel concern stays out — voice
 * modes, VAD tuning, per-adapter affordances, and wake routes all remain
 * gateway/config-owned.
 *
 * Absent = inherit the global `auxiliary.asr.*` / `auxiliary.tts.*` defaults,
 * and a call treatment derived from the personality id.
 */
export interface PersonalityVoiceConfig {
  /**
   * Name of an entry in the deployment's TTS roster
   * (`voice.tts.providers.<name>.*` in `~/.ethos/config.yaml`). A LABEL the
   * operator chose, never a provider id — the egress gate keys on the entry's
   * underlying `provider`, so naming an entry `local-kokoro` buys nothing.
   *
   * Absent, or naming an entry this machine does not have, falls back to the
   * default `auxiliary.tts` entry: a personality shared between machines must
   * still speak on one that lacks its preferred provider.
   *
   * `voice.provider` is still ACCEPTED on read as the older spelling of this
   * key; the loader maps it here and re-serializes the new one, so a config
   * never carries both.
   */
  tts_provider?: string;
  /**
   * Name of an entry in the deployment's STT roster
   * (`voice.stt.providers.<name>.*`). The exact mirror of `tts_provider`, down
   * to the fallback: unknown here → the default `auxiliary.asr` entry.
   *
   * A personality's VOICE is identity; its EAR is a technical override — a
   * Spanish-tuned or local-only personality transcribing through a different
   * engine than the deployment default.
   */
  stt_provider?: string;
  /**
   * Name of an entry in the deployment's REALTIME roster
   * (`voice.realtime.providers.<name>.*`). The speech-to-speech sibling of
   * `tts_provider` / `stt_provider`, under the same rules: a LABEL the operator
   * chose, never a provider id, and a name this machine lacks falls back to
   * `voice.realtime.default` rather than failing the load.
   *
   * Only consulted when a turn runs on the realtime tier; on the pipeline tier
   * `tts_provider` / `stt_provider` are what speak and listen.
   */
  realtime_provider?: string;
  /** TTS voice id, provider-specific (e.g. `af_bella` for Kokoro, `alloy` for OpenAI). */
  tts_voice?: string;
  /**
   * BCP-47 tag → TTS voice id. Wins over `tts_voice` when the turn's language
   * is known: a personality that declares a Spanish voice means it in Spanish.
   */
  languages?: Record<string, string>;
  /**
   * Preferred voice tier. `pipeline` = STT → LLM → TTS (V1a); `realtime` =
   * hosted speech-to-speech (V1b). A preference, not a guarantee — a
   * deployment with no realtime provider serves `pipeline` either way.
   */
  tier?: 'pipeline' | 'realtime';
  /**
   * Fast-lane model for spoken turns. Conversational latency and agentic depth
   * want different models; this is how a personality says which one talks.
   */
  model?: string;
  /**
   * Which treatment the Call Stage draws for this personality — how it LOOKS
   * while it holds the floor, the visual sibling of `tts_voice`. Absent falls
   * through to the operator's `display.call_style` and then to a value derived
   * from the id, so a personality always has a look; see
   * {@link resolveCallTreatment} for the one precedence rule every surface uses.
   */
  call_style?: CallTreatment;
}

export interface DreamingConfig {
  enable: boolean;
  idleMinutes: number;
  maxPerDay: number;
  prompt?: string;
}

export interface ModelTierConfig {
  trivial?: string;
  default?: string;
  deep?: string;
  dreaming?: string;
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

export interface LearningLogEntry {
  revisionId: string; // monotonic, e.g. "expr-rev-7"
  at: string; // ISO timestamp
  summary: string; // short human description of the change
  evidenceRef: string; // pointer to the evidence that justified the change
  prevExpressionRef: string; // id of the prior-Expression snapshot, enables one-click revert
}

export interface LivingSoul {
  core: string; // raw Core section — NEVER written by the evolution loop
  expression: string; // raw Expression section — the only auto-editable region
  learningLog: LearningLogEntry[];
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
// How a personality PRESENTS itself — how it sounds, how its call is drawn,
// how it looks — is identity, and lives as sub-keys of an identity block
// below (`voice`, `display`; the personality-presentation amendment). It is
// not a new top-level field, and it is not a licence for one.
//
// Common rejections — these belong in skills, in `~/.ethos/config.yaml`, or in
// per-channel adapter config, NOT here:
//   - voice MODES, VAD tuning, per-channel voice affordances (the `voice`
//     field below is identity — which voice this personality speaks in and
//     what its call looks like — and is the one sanctioned exception, granted
//     by the voice V1a amendment; it is not a licence for further
//     speech/audio SETTINGS)
//   - emotion / mood / sentiment tags
//   - label or response templates
//   - per-channel UI affordances
//   - operator and deployment concerns: transport, credentials, rosters,
//     endpoints, anything an operator sets once for the machine
export interface PersonalityConfig {
  /** @internal Personality directory name; populated by the loader, not user-set. */
  id: string;
  name: string;
  description?: string;
  /** @internal Absolute path to SOUL.md; populated by the loader. */
  soulFile?: string;
  /** @internal Absolute paths to skills directories; populated by the loader. */
  skillsDirs?: string[];
  toolset?: string[];
  capabilities?: string[];
  model?: string | ModelTierConfig;
  provider?: string;
  platform?: string;
  /**
   * Per-personality streaming watchdog: if no chunk arrives from the LLM within
   * this many milliseconds, the agent aborts the stream and emits an error.
   * Reset on every chunk, so slow-but-progressing streams are unaffected.
   * Absent → the loop's `options.streamingTimeoutMs`, and absent there too →
   * `DEFAULT_STREAMING_TIMEOUT_MS` in
   * `@ethosagent/core`'s `agent-loop/streaming-timeout.ts`. The
   * number is deliberately not restated here; it has been wrong in this comment
   * before. The resolution order is read at
   * `core/src/agent-loop/stages/stream-step.ts` (`watchdogMs`).
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
   * `workdir` is this personality's working directory — where its relative
   * file paths land. It takes the same substitutions, must resolve absolute,
   * and BECOMES the `${CWD}` that the read/write entries substitute against.
   * A declared workdir is always reachable: it is added to both derived
   * lists, because a declared `write` REPLACES the defaults and would
   * otherwise leave the workdir unwritable. When `workdir` is unset the
   * working directory is the process cwd and read/write derive exactly as
   * before.
   *
   * `workdir` accepts a single path OR an array of paths. An array declares
   * MULTIPLE Documents roots — every entry becomes its own top-level root in
   * the Documents surface (`apps/web-api/src/services/documents.service.ts`),
   * each with its own independent containment boundary. `${CWD}` substitution
   * — both for this personality's own agent working directory and for the
   * `${CWD}` token injected into `read`/`write` entries — uses ONLY the FIRST
   * declared entry; later entries exist for Documents only and never become
   * the agent's cwd. This is a WIDENING of an existing field's type, not a
   * new field, so it still counts as ONE field for the schema-freeze gate
   * (the nested shape is a leaf type).
   */
  fs_reach?: { read?: string[]; write?: string[]; workdir?: string | string[] };
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
   * Skill evolution for this personality. Every drafted skill is submitted to
   * the learning inbox as a candidate (plan `trust-before-reach.md` Part 4);
   * nothing configured here writes a live skill directly.
   *
   *   `enabled` — gates the nightly pass's skill-drafting step
   *     (`apps/ethos/src/commands/nightly.ts`). Default: off.
   *   `promotion`, `scope`, `evolve_existing` — documented on each key below.
   *   `min_tool_calls`, `cooldown_minutes`, `model` — parsed and written back
   *     by `extensions/personalities/src/index.ts`, but READ BY NOTHING: their
   *     one reader, the per-turn skill-evolver auto-trigger, was deleted
   *     (L-T6). Limitation: setting them has no effect.
   *
   * Counts as ONE field for the schema-freeze gate (the nested shape is a
   * leaf type).
   */
  skill_evolution?: {
    /**
     * Turns on this personality's two automatic drafters: the post-turn
     * improvement fork (`ImprovementFork.shouldFork`,
     * `extensions/skill-evolver/src/improvement-fork.ts`) and the nightly skill
     * drafter (`nightlySkillDrafter`, `apps/ethos/src/commands/nightly.ts`).
     * Absent or `false` = neither runs. Does not gate `ethos evolve` /
     * `ethos eval --evolve`, which draft whenever invoked.
     */
    enabled?: boolean;
    /**
     * Successful tool calls a turn needs before the fork runs. Default 5.
     * Fork only (`ImprovementFork.shouldFork`).
     */
    min_tool_calls?: number;
    /**
     * Minimum minutes between fork runs for this personality, counted from the
     * previous run's start. Default 60. In memory per process — a restart
     * clears it. Fork only (`ImprovementFork.shouldFork`).
     */
    cooldown_minutes?: number;
    /**
     * Model id this personality's skill drafting runs on, sent as
     * `modelOverride` to the configured provider (it does not switch provider):
     * the fork's turn (`ImprovementFork.run`), the nightly drafter
     * (`proposeSkillFromEvidence`), and `ethos evolve` / `ethos eval --evolve`
     * (`skillEvolutionEvolveOptions`, `extensions/skill-evolver/src/evolver.ts`).
     * Absent = the provider's own model. Not read by the chat-turn
     * `skill_propose` tool. Pinned by
     * `apps/ethos/src/commands/__tests__/skill-evolution-keys.test.ts`.
     */
    model?: string;
    /**
     * `false` stops rewrites of existing skills while new skills still draft:
     * `SkillEvolver`'s `evolveExisting` (`ethos evolve`, `ethos eval --evolve`,
     * mapped by `skillEvolutionEvolveOptions`) skips the rewrite branch, and
     * both `skill_propose` tools — the fork's and the chat turn's
     * (`packages/wiring/src/compose-tools.ts`) — refuse a `targetFile`
     * (`SkillProposeTarget.evolveExisting`). The nightly drafter only creates.
     * Absent = rewrites allowed. Pinned by
     * `apps/ethos/src/commands/__tests__/skill-evolution-keys.test.ts` and, for
     * the chat turn, `packages/wiring/src/__tests__/chat-skill-propose.test.ts`.
     */
    evolve_existing?: boolean;
    /**
     * Who may promote this personality's skill candidates — the first of the
     * three auto knobs (`promotion` > `evolution_approval_mode` >
     * `evolve-config.json` `autoApprove`; `resolveAutoPromotion`,
     * `extensions/learning-inbox/src/auto-promotion.ts`). `'review'`: only a
     * human. `'auto'`: additionally, a replay promotes a candidate whose
     * verdict is `pass` — and only when `scope` is `'personality'`; a shared
     * skill always needs a human (`autoPromotionDecision`, same file). Unset =
     * the next knob decides.
     */
    promotion?: 'review' | 'auto';
    /**
     * Where a promoted skill is written (`liveSkillDir`,
     * `extensions/skill-evolver/src/skill-dir.ts`). `'shared'` (default) =
     * `<dataDir>/skills`, visible to every capability-matched personality;
     * `'personality'` = `<dataDir>/personalities/<id>/skills`. Also decides
     * whether auto-promotion is possible at all (see `promotion`).
     */
    scope?: 'personality' | 'shared';
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
   * Per-personality MCP export — the one slice of this personality another app
   * (Claude Desktop, Cursor) may reach, and nothing else of Ethos.
   *
   * `ethos mcp serve --personality <id>` is what serves it, and only while that
   * process runs: the declaration alone publishes nothing. What the caller gets
   * is ONE tool, `ask`, running one whole turn as this personality with every
   * run option pinned by the server; it can never name the personality, the
   * session key or the tool set. The terms come from `resolveMcpExportScope`
   * (`packages/wiring/src/mcp-export.ts`), re-resolved on every call by
   * `PersonalityExportServer` (`apps/mcp-server/src/export-server.ts`).
   *
   * Fail-closed throughout: `enabled` must be literally `true`, `expose_tools`
   * defaults to `none`, `expose_memory` to `none`, `expose_sessions` to
   * `false`, `auth` to `localhost`. See {@link PersonalityMcpExportConfig} for
   * each key's enforcer and for the two limitations this export does not have
   * (no rate limit; no non-loopback bind and no TLS).
   *
   * The global `ethos mcp serve` — no `--personality` — is a DIFFERENT surface:
   * the operator console, full trust, every personality and every session on
   * the machine (M-D14). Nothing here bounds it.
   *
   * Counts as ONE field for the schema-freeze gate.
   */
  mcp_export?: PersonalityMcpExportConfig;
  /**
   * Per-personality outbound approval policy.
   *
   * `approve_before_send: true` turns an agent-initiated `send_message` into a
   * PROPOSAL rather than a send. The gate is in `executeSendMessage`
   * (extensions/tools-messaging/src/index.ts), which runs it AFTER the
   * operator allowlist check, so an approval can never widen the destinations
   * the operator allowed. The queued item, its immutable revisions and the
   * content binding a human approves live in `SQLiteOutboxStore` /
   * `OutboxService` (`@ethosagent/outbox`).
   *
   * WHERE it binds. The gate is built only when a surface supplies
   * `ComposeToolsDeps.outbox` (packages/wiring/src/compose-tools.ts), and
   * every root that can reach a channel does, through
   * apps/ethos/src/lib/outbox-wiring.ts:
   *  - `ethos gateway start` and `ethos boot` hold the adapters and build the
   *    whole outbox (`createOutboxRuntime`): gate, reviewer, Telegram cards,
   *    and the dispatcher that delivers approved items;
   *  - `ethos serve` holds no adapters, but its watcher tools store `deliver`
   *    targets a gateway later sends from, so it builds the proposal side
   *    (`createOutboxProposalSide`): gate and reviewer, no dispatcher, no card.
   *    What it queues is delivered by a gateway's dispatcher.
   * The other roots that run a turn — `chat`, `cron`, `mcp`, `batch`, `eval`,
   * `acp`, `bench` — wire no gate because they cannot publish at all: none
   * calls `setMessagingSend`, so `send_message` fails with the default
   * "Gateway not active" error (`gatewaySendRef` in compose-tools.ts), and
   * none registers the watcher tools. Both halves are pinned by
   * `apps/ethos/src/__tests__/outbox-gate-live.test.ts`, which fails if either
   * seam appears in a root without the gate.
   *
   * A human approves in the web Outbox pane, with `ethos outbox approve`
   * (apps/ethos/src/commands/outbox.ts), or on a Telegram card. A card is
   * posted only by a process holding the sending bot's adapter, so an item
   * proposed under `ethos serve` gets none.
   *
   * `channels` names platforms (`slack`, `telegram`, `discord`, `whatsapp`,
   * `email`); absent means every platform. An unknown name FAILS the
   * personality load — `buildOutboundPolicy`
   * (extensions/personalities/src/index.ts) — so a typo cannot silently leave
   * a platform ungated. `approve_before_send: false` ignores `channels` at
   * runtime, but a bad name in it is still refused at load.
   *
   * `approver_personality` is an ADVISORY reviewer, never an approver: it
   * attaches a PASS/FAIL receipt and a human still decides.
   *
   * What it does NOT cover, stated because the name would otherwise imply it:
   * the turn's own chat and the operator's own chat are exempt destinations;
   * cron delivery, goal notes, owner notices and team/mesh dispatch are not
   * gated; and egress through MCP tools or `a2a_send` is not covered at all —
   * that would mean classifying arbitrary third-party tools. `publishingLine`
   * (extensions/personalities/src/character-sheet.ts) prints the exclusion on
   * every character sheet rather than letting this field read as blanket
   * coverage.
   *
   * Counts as ONE field for the schema-freeze gate.
   */
  outbound_policy?: OutboundPolicyConfig;
  /**
   * Idle-time dreaming. When enabled, the gateway triggers a background
   * maintenance turn after `idleMinutes` of silence, up to `maxPerDay`
   * per rolling 24-hour window. Counts as ONE field for the schema-freeze gate.
   */
  dreaming?: DreamingConfig;
  /**
   * Phase 3a — Governance dial for Expression self-evolution, distinct from
   * `safety.approvalMode` (which gates tool calls, not evolution). Do NOT
   * overload safety.approvalMode.
   * Every drafter — the nightly pass, `ethos personality evolve`, the web
   * Living Soul editor — submits its draft to the learning inbox as a
   * candidate; none applies it (plan `trust-before-reach.md` Part 4, L-D2).
   * What this field decides is who may promote that candidate:
   *   `user` (default when absent): only a human — `y` at
   *     `ethos personality evolve <id>`, Apply on the web, or the inbox. The
   *     auto resolver answers `review` (`resolveAutoPromotion`,
   *     extensions/learning-inbox/src/auto-promotion.ts).
   *   `auto`: additionally, `replayAndResolve` promotes a candidate whose
   *     replay verdict is `pass`. The Personality Judge decides only whether to
   *     draft; an unevaluated draft is never applied.
   * For skills it is the middle of the three auto knobs
   * (`skill_evolution.promotion` > this > `evolve-config.json` `autoApprove`).
   * Pinned by extensions/learning-inbox/src/__tests__/auto-promotion.test.ts
   * and extensions/nightly-loop/src/__tests__/orchestrator.test.ts.
   * Counts as ONE field for the schema-freeze gate.
   */
  evolution_approval_mode?: 'auto' | 'user';
  /**
   * Phase 3 (P5) — Gates the nightly governed-learning pass and its Personality
   * Judge. Every field defaults to today's behavior when absent, so an existing
   * personality with no `nightly` block runs the full pass (judge + expression)
   * exactly as before.
   *   `enabled`               — master nightly toggle. Default true: the pass
   *                             runs for this personality.
   *   `judge.enabled`         — run the Personality Judge step. Default true.
   *                             When false, the judge step records `skipped`
   *                             and no verdict is produced (expression short-
   *                             circuits, as it does on insufficient data).
   *   `judge.minInteractions` — activation threshold for the judge. Default 20
   *                             (= DEFAULT_ACTIVATION.minInteractions).
   *   `expression`            — run the expression-evolution step. Default true.
   * Counts as ONE field for the schema-freeze gate (the nested shape is a
   * leaf type — same precedent as `fs_reach`).
   */
  nightly?: {
    enabled?: boolean;
    judge?: { enabled?: boolean; minInteractions?: number };
    expression?: boolean;
  };
  /**
   * Voice V1a — how this personality SOUNDS: TTS voice id, language→voice map,
   * tier preference, fast-lane model — and, since the personality-presentation
   * amendment, how its call LOOKS (`call_style`). See
   * {@link PersonalityVoiceConfig} for why this is identity rather than a
   * deployment setting, and what stays out.
   * Absent = inherit the global `auxiliary.tts.*` config.
   * Counts as ONE field for the schema-freeze gate (the nested shape is a
   * leaf type — same precedent as `fs_reach`).
   */
  voice?: PersonalityVoiceConfig;
  /**
   * How a personality LOOKS across identity surfaces (the rail, the picker,
   * the chat header, …) — the visual sibling of `voice`, granted by the same
   * personality-presentation amendment: a personality is not only its tools
   * and its plugins, it is also how it looks and feels. First field:
   * `avatar_url`, a URL to a served or uploaded avatar image. Absent, or an
   * image that fails to load, falls back to the generated mark
   * (`PersonalityRingAvatar` / `PersonalityMark`) every identity surface
   * already renders — no other behavior changes.
   * Counts as ONE field for the schema-freeze gate (the nested shape is a
   * leaf type — same precedent as `fs_reach`).
   */
  display?: { avatar_url?: string };
  /**
   * Execution REQUIREMENT — what this personality demands of wherever its
   * execution tools run. Two values, and both are identity under the content
   * test in `docs/content/building/explanation/personality-governance.md`:
   *
   *   - `remote` — this personality's work belongs on a machine that is NOT
   *     the one Ethos runs on. An agent whose hands only ever reach a build
   *     box is a different agent from one holding a shell here; every
   *     deployment of it agrees about that.
   *   - `none` — this personality does not execute. The refusal IS the
   *     identity: an agent with no hands.
   *
   * A personality NEVER names a transport. `docker` vs `local` vs `ssh` is a
   * machine fact two deployments of the same personality reasonably disagree
   * about — one runs inside a container, one has no daemon, one has an ssh
   * target — so it is the operator's, and the resolver already derives it from
   * environment, `~/.ethos/config.yaml` and the constitution. The earlier
   * four-literal form of this field (`local` / `docker` / `ssh` / `none`)
   * failed that test on its `local` and `docker` halves and named the ssh
   * transport on its third; those three literals are now load errors that
   * name the replacement.
   *
   * This is emphatically NOT the remote HOST. The target — host, user, port,
   * identity file, known-hosts, remote workdir — is operator config
   * (`execution.ssh.*` in `~/.ethos/config.yaml`), one per deployment. Never
   * put a hostname, user, or key path here.
   *
   * Absent = no requirement; the resolver picks the transport on its own
   * (sandboxed by default, the host when Ethos is itself containerized).
   * A requirement the deployment CANNOT satisfy is refused outright, never
   * silently downgraded: `remote` with no configured target leaves execution
   * tools unavailable rather than quietly running them on this machine.
   * Counts as ONE field for the schema-freeze gate.
   */
  execution?: 'remote' | 'none';
}

/**
 * Patch shape consumed by `PersonalityRegistry.update`. Narrow on purpose —
 * the SDK install flow only ever needs to mutate the `mcp_servers` list,
 * and consumers in the type layer should not be aware of the broader edit
 * shape that the file-backed registry supports (name, SOUL.md, toolset).
 * Concrete implementations may accept a wider patch via their own type.
 */
export interface PersonalityRegistryPatch {
  mcp_servers?: string[];
  plugins?: string[];
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
  /**
   * Apply a patch to a personality. Optional in the interface because not
   * every backend (e.g. read-only built-in registries used in tests) supports
   * mutation; the SDK install flow checks for presence before calling. The
   * file-backed registry implements this with the broader patch shape it
   * accepts internally, then narrows to the interface here. Return shape
   * intentionally minimal — surfaces that need the full updated record call
   * the concrete method directly.
   */
  update?(id: string, patch: PersonalityRegistryPatch): Promise<unknown>;
  /**
   * Model-visible ⟺ logged (plan/phases/model-visible-logged.md, Phase B,
   * D8) — the six-path content fingerprint (`config.yaml`, `SOUL.md`,
   * `toolset.yaml`, `mcp.yaml`, `tools.yaml`, `skills/` presence) for a
   * personality, as raw source strings for the caller to hash. Optional:
   * only `FilePersonalityRegistry` (extensions/personalities) implements
   * it, since only a file-backed registry has a directory to read from.
   * `context-assembly.ts` (packages/core) calls this through the interface
   * rather than importing extensions/personalities directly — core does not
   * depend on extensions (ARCHITECTURE.md layer direction). Returns `null`
   * when the personality is unknown.
   */
  getContentFingerprint?(id: string): Promise<PersonalityFingerprintSources | null>;
}

/** Six-path content sources for a personality's fingerprint (D8). See
 *  `PersonalityRegistry.getContentFingerprint`. */
export interface PersonalityFingerprintSources {
  soulSrc: string | null;
  configSrc: string | null;
  toolsetSrc: string | null;
  mcpSrc: string | null;
  toolsSrc: string | null;
  skillsDirPresent: boolean;
}
