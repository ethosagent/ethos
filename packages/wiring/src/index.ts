import { join } from 'node:path';
import { deriveProviderKey } from '@ethosagent/config';
import {
  type AgentLoop,
  ChainedProvider,
  DefaultLLMProviderRegistry,
  type DefaultToolRegistry,
  markServerCompaction,
  pressureGateTokens,
  type SummarizerFn,
  tagProviderEntry,
} from '@ethosagent/core';
import type { CronScheduler } from '@ethosagent/cron';
import type { GoalRunner } from '@ethosagent/goal-runner';
import type { TrustPolicy } from '@ethosagent/kanban-store';
import { AuthRotatingProvider, anthropicContextTokens } from '@ethosagent/llm-anthropic';
import type { PluginLoader } from '@ethosagent/plugin-loader';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import type { TeamRole } from '@ethosagent/tools-kanban';
import type { McpManager } from '@ethosagent/tools-mcp';
import type { MessagingSendFn } from '@ethosagent/tools-messaging';
import type {
  CliSubcommandContext,
  ExecutionBackendConfig,
  ExecutionBackendRegistry,
  ExecutionPosture,
  GoalStore,
  LLMProvider,
  Logger,
  ModelProfile,
  RetentionConfig,
  SecretsResolver,
  SessionStore,
  Storage,
} from '@ethosagent/types';

export type { WiringContext } from './types';

import { buildAgentLoop } from './build-agent-loop';
import { buildWiringContext } from './build-context';
import { buildInfrastructure } from './build-infrastructure';
import { selectServingProviderEntries } from './chain-hops';
import { composeAllTools, type OutboxWiring } from './compose-tools';
import { DisposerStack } from './disposer-stack';
import { loadPlugins } from './load-plugins';
import {
  detectLocalRuntime,
  probeServedWindowCached,
  resolveContextWindow,
  type WindowProbeResult,
  windowProbeCachePath,
} from './local-models';
import type { MemoryBundle } from './memory-backend';
import {
  lookupContextWindow,
  lookupProfile,
  mergeModelProfile,
  PROVIDER_WINDOW_DEFAULTS,
  resolveCompactionGate,
} from './model-catalog';
import type { EthosObservability } from './observability/ethos-observability';
import { registerBuiltinProviders } from './register-builtin-providers';
import {
  buildSummarizerSystemPrompt,
  capSummary,
  renderMiddleForSummary,
} from './summarizer-prompt';
import type { WiringContext } from './types';

// ---------------------------------------------------------------------------
// Messaging gateway — send function type re-exported for callers
// ---------------------------------------------------------------------------

// Re-exported so the in-process web-API hosts (`ethos serve`/`boot`, the
// desktop app) can hand the screencast takeover socket its session registry
// WITHOUT taking a direct `@ethosagent/tools-browser` dependency — which would
// pull Playwright into the desktop bundle's declared graph for one lookup.
// `packages/wiring` already depends on it to compose the browser toolset.
// Stored logins for `browser_fill_credential` (plan reach-and-containment
// §4.2). Re-exported for the same reason as the registry above: the CLI
// (`ethos secrets credential`) and web-api (`CredentialsService`) validate and
// write through the ONE implementation the tool reads back, without either app
// importing the extension directly (ARCHITECTURE.md Law 5).
export {
  type BrowserTakeoverRegistry,
  type BrowserTakeoverTarget,
  CredentialValidationError,
  type CredentialView,
  createBrowserTakeoverRegistry,
  deleteCredential,
  listCredentials,
  normalizeOrigin,
  type SetCredentialInput,
  setCredential,
  updateCredentialPolicy,
} from '@ethosagent/tools-browser';
export type { MessagingSendFn } from '@ethosagent/tools-messaging';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RotationKey {
  apiKey: string;
  priority: number;
  label?: string;
}

export interface WiringProviderConfig {
  provider: string;
  /** `providers.<n>.id` — the stable entry key a `modelRegistry` alias names
   *  (D2/D24). Absent → `deriveProviderKey`'s positional default. */
  id?: string;
  /** `providers.<n>.failover` — `false` keeps the entry out of the chain the
   *  default rung rides (D23b). Absent → `true`. */
  failover?: boolean;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Azure-only: REST API version (e.g. `2024-10-21`). Required when
   *  `provider === 'azure'`; ignored otherwise. */
  apiVersion?: string;
  /** Bedrock-only: AWS region for the Bedrock runtime endpoint (e.g.
   *  `us-west-2`). Defaults to `us-east-1`; ignored otherwise. */
  region?: string;
  /** Bedrock-only: named AWS profile from `~/.aws/config` (e.g. an SSO profile
   *  after `aws sso login`), used when no static keys are configured; ignored
   *  otherwise. Named `awsProfile`, not `profile`, because `profile` already
   *  means a per-model `ModelProfile` (`models.*`) in this config. */
  awsProfile?: string;
  /** Item 7 (D32) — `providers.<n>.serverCompaction`; honoured on `anthropic` only. */
  serverCompaction?: boolean;
  /** `providers.<n>.serverCompactionTriggerTokens`; absent → `pressureGateTokens`. */
  serverCompactionTriggerTokens?: number;
}

export interface WiringConfig {
  provider: string;
  model: string;
  apiKey: string;
  personality?: string;
  memory?: 'markdown' | 'vector' | 'vault';
  /**
   * Bring-your-own-vault backend settings (mapped from `EthosConfig.memoryVault`).
   * Read only when `memory === 'vault'`: `path` is the vault root, `agentDir`
   * the subtree the agent owns (default `Ethos`), `prefetch` the keys pulled
   * into the prompt tail, `exclude` extra names hidden from list/search.
   */
  memoryVault?: {
    path?: string;
    agentDir?: string;
    prefetch?: string[];
    exclude?: string[];
  };
  /**
   * Per-key content ceilings for the markdown backend, in characters (mapped
   * from `EthosConfig.memoryCharLimits`). Absent → 512K per key.
   */
  memoryCharLimits?: { memory?: number; user?: number };
  /**
   * Execution-backend resource caps (mapped from `EthosConfig.execution`).
   * Forwarded to `ExecutionBackendConfig` when the docker backend is resolved.
   *
   * `ssh` is the deployment's single remote execution target, and `host`'s
   * presence is the switch: no `host`, no remote posture. It is the CONTRACT's
   * own shape, not a copy: the compose path forwards this object straight to
   * `ExecutionBackendConfig.ssh` when it resolves the ssh backend, so a field
   * this type dropped would be a field the operator set and the backend never
   * saw — a configured `remoteWorkdir` or `identityFile` silently ignored.
   */
  execution?: {
    /** `execution.allowLocalFallback` — see `ResolveExecutionPostureInput` (S6 / D3). */
    allowLocalFallback?: boolean;
    docker?: { cpu?: number; diskMb?: number };
    ssh?: NonNullable<ExecutionBackendConfig['ssh']>;
  };
  /**
   * Board work-in-progress caps (mapped from `EthosConfig.kanban`). Forwarded
   * to `KanbanStore`, which refuses a claim past the cap. Absent = uncapped.
   */
  kanban?: { maxInProgress?: number; maxInProgressPerProfile?: number };
  /**
   * Ground-truth verification policy (mapped from `EthosConfig.grounding`).
   * Read by `composeGrounding`; absent = the defaults, which is ON.
   */
  grounding?: {
    enabled?: boolean;
    onFinding?: 'annotate' | 'correct';
    showUnsupported?: boolean;
    memoryTag?: boolean;
    kanban?: { checks?: boolean; allowedCheckCommands?: string[] };
  };
  /**
   * Tool-loop hard caps and soft-warn tiers (mapped from `EthosConfig.toolLoop`).
   * Forwarded to `AgentLoopConfig.options`; absent = loop defaults, no warn tier.
   */
  toolLoop?: {
    maxToolCallsWarnAt?: number;
    maxIdenticalToolCallsWarnAt?: number;
    maxToolCallsPerTurn?: number;
    maxIdenticalToolCalls?: number;
  };
  /**
   * The deployment's public web UI address — `EthosConfig.webBaseUrl`
   * verbatim (which already resolves `ETHOS_PUBLIC_URL` ahead of the
   * config-file value). Forwarded to `ClarifyBridge` so a `browser_takeover`
   * clarify carries a hand-back address a channel user can open; absent = the
   * takeover text names the web chat without a link, as before.
   */
  webBaseUrl?: string;
  /**
   * Playwright timeout budgets for the browser toolset (mapped from
   * `EthosConfig.browser`). Forwarded to `createBrowserTools`; absent = the
   * 30s navigation / 10s command literals those call sites shipped with.
   */
  browser?: {
    navigationTimeoutMs?: number;
    commandTimeoutMs?: number;
    /** `browser.headed`, verbatim — `'auto'` is resolved by the session factory. */
    headed?: boolean | 'auto';
    /** `browser.idleTimeoutMs` — sweep budget for an untouched session. */
    idleTimeoutMs?: number;
    /** `browser.profiles.enabled` — persistent per-personality profiles (D4). */
    profiles?: { enabled?: boolean };
    /** `browser.proxy.*` — applied at launch to every browser session. */
    proxy?: { server: string; username?: string; password?: string };
  };
  baseUrl?: string;
  /** Azure-only: REST API version (e.g. `2024-10-21`). Required when
   *  `provider === 'azure'`; ignored otherwise. */
  apiVersion?: string;
  /** Bedrock-only: AWS region for the Bedrock runtime endpoint (e.g.
   *  `us-west-2`). Defaults to `us-east-1`; ignored otherwise. */
  region?: string;
  /** Bedrock-only: named AWS profile from `~/.aws/config` (e.g. an SSO profile
   *  after `aws sso login`), used when no static keys are configured; ignored
   *  otherwise. Named `awsProfile`, not `profile`, because `profile` already
   *  means a per-model `ModelProfile` (`models.*`) in this config. */
  awsProfile?: string;
  /**
   * Lane 0 (eng review D4) — operator override for the primary model's served
   * context window (tokens). Wins over the probe and the catalog (precedence:
   * config > probe > catalog > default); maps to the provider's
   * `maxContextTokens`. Applied to the PRIMARY provider/model only — chain
   * fallbacks resolve their own windows.
   */
  contextWindow?: number;
  /**
   * Lane 2a (eng review D6) — tool-definition ordering at the provider
   * serialization boundary. `'stable'` (default) is the deterministic ASCII
   * sort; `'insertion'` restores legacy registration-order bytes. Temporary
   * rollback lever; removal tracked in plan/uncompleted-tasks.md (D13).
   */
  toolOrder?: 'insertion' | 'stable';
  /**
   * Lane 4a(d) — per-request deadline (ms) for OpenAI-compat AND Anthropic
   * clients. Absent → `DEFAULT_LLM_REQUEST_TIMEOUT_MS` (20 minutes), which
   * overrides both SDKs' own 10-minute defaults; the default is deliberately
   * long because a cold local model load takes minutes.
   */
  requestTimeoutMs?: number;
  /** Lane 4a(d) — retry count for OpenAI-compat clients. Absent → the OpenAI
   *  SDK default (2 retries). Anthropic has no such knob wired. */
  maxRetries?: number;
  /**
   * Lane 3(a) — total serialized tool-payload guard threshold, in chars.
   * Absent → `TOOL_PAYLOAD_GUARD_DEFAULT_CHARS` (static-floor.ts). Exceeding
   * it FAILS startup on a local dialect (losing tool calling entirely is the
   * failure prevented) and WARNS on hosted ones.
   */
  toolPayloadLimitChars?: number;
  /**
   * reach-and-containment Part 1 — on-demand tool loading mode. Absent →
   * `auto`. Built into the loop's per-turn resolver by
   * `createToolLoadingResolver` (static-floor.ts).
   */
  toolLoading?: 'auto' | 'on' | 'off';
  /** Maps personality ID → model ID for per-personality model overrides. */
  modelRouting?: Record<string, string>;
  /**
   * `modelRegistry.*` exactly as `parseConfigYaml` built it (T1.8). Handed to
   * the loop's resolver in `build-agent-loop.ts`; absent or empty → the D11b
   * legacy path (`config.model`), unchanged.
   */
  modelRegistry?: import('@ethosagent/types').ModelRegistry;
  /**
   * §7 — per-model profile overrides, keyed by `<providerId>/<modelId>`. Merged
   * OVER the catalog `profile` at provider construction (override wins). Threads
   * `toolCallFormat`/`maxOutputTokens` to the provider and sampling defaults to
   * the loop.
   */
  models?: Record<string, ModelProfile>;
  /**
   * §5 — global context-compaction gate thresholds (fractions in (0,1]). A
   * per-model catalog `profile.compaction` overrides these; both absent → the
   * hardcoded 0.8/0.7 defaults. Threaded into the loop → compaction gate.
   *
   * Item 7 — `maxContextTokens` is an absolute token ceiling applied to BOTH
   * gates (global only, no per-model layer); `minTailUserMessages` is the
   * number of user messages every compaction keeps verbatim (default 3).
   */
  // biome-ignore format: Phase 3 adds turn-end auto-compact + overflow-retry flags; Phase 4 adds smallWindow; Item 7 adds the ceiling + user tail.
  compaction?: { pressure?: number; target?: number; gateDelta?: number; autoCompact?: boolean; retryOnOverflow?: boolean; abortOnSummaryFailure?: boolean; smallWindow?: 'auto' | 'on' | 'off'; maxContextTokens?: number; minTailUserMessages?: number };
  /**
   * Call-capture personality binding (plan/phases/call-capture-extension.md
   * decision 3) — see `EthosConfig.callCapture` in `@ethosagent/config` and
   * `validateCallCaptureBinding` in this package.
   */
  callCapture?: { personalityId?: string };
  /**
   * Phase 3 — silent memory-flush turn config (opt-in). `enabled` gates the
   * whole feature; the rest tune the soft threshold, timebox + token cap,
   * per-flush memory-delta cap, and the trivial-delta skip. Threaded into the
   * loop untouched.
   */
  // biome-ignore format: one line keeps the option shape adjacent to its doc.
  memoryConsolidation?: { enabled?: boolean; flushThreshold?: number; timeboxMs?: number; maxTokens?: number; maxDeltaChars?: number; minMessagesSinceFlush?: number };
  /** Anthropic key rotation pool. Empty / absent = single-key provider. */
  rotationKeys?: RotationKey[];
  /**
   * Override path to the kanban SQLite database. When unset, the path resolves
   * based on `teamName`:
   *   - `teamName` set → `${dataDir}/teams/<teamName>/board.db` (shared team board)
   *   - `teamName` unset → `${dataDir}/board.db` (global board)
   * `kanbanDbPath` always wins when explicitly set.
   */
  kanbanDbPath?: string;
  /**
   * Team this AgentLoop belongs to. When set, the kanban store points at the
   * team's shared board (`${dataDir}/teams/<name>/board.db`) and a `before_tool_call`
   * role hook gets registered (Plan B). When unset, the loop runs solo (Plan A).
   */
  teamName?: string;
  /**
   * Caller's role within the team. Drives the kanban role-gate hook:
   *   - `coordinator` can call kanban_create/_create_goal/_assign/_link/_archive
   *   - `member` cannot, and can only complete/block/unblock/heartbeat their own
   *     assigned tasks. Both roles can comment/list/show/update_status.
   * Only honored when `teamName` is also set.
   */
  role?: TeamRole;
  /**
   * The team manifest's coordinator personality id. When set alongside
   * `teamName`/`role`, the kanban role gate resolves the caller's role per
   * turn from the turn's personality (`coordinator` iff it is this id) instead
   * of the boot-time `role` — needed on a team-scoped loop that runs every
   * member's turns. Absent → boot-time `role` applies to every turn.
   */
  coordinatorId?: string;
  /** Enable postmortem entries in team memory on ticket revision. */
  postmortems?: boolean;
  /** Reputation-aware autonomy tiers for team members. */
  trustPolicy?: TrustPolicy;
  /** Background sub-agent engine config (durable spawn-and-continue jobs). */
  background?: import('@ethosagent/config').BackgroundConfig;
  /**
   * P3 observability — request dump store configuration. When enabled, every
   * LLM request/response is logged to JSONL files for offline debugging.
   */
  observabilityRequestDump?: {
    enabled?: boolean;
    dir?: string;
    includeContent?: boolean;
    rotation?: { maxBytes?: number };
  };
  /**
   * Fallback provider chain. When 2+ entries are provided, `createLLM` wraps
   * them in a `ChainedProvider` with cooldown-based automatic failover.
   * Takes precedence over `provider`/`apiKey`/`model` when present.
   */
  providers?: WiringProviderConfig[];
  /**
   * context_compression F1 — auxiliary compression summarizer. When `model`
   * is set, `semantic_summary` is wired with a real LLM summarizer running on
   * this (typically cheap) model instead of the placeholder. `provider` /
   * `apiKey` / `baseUrl` default to the primary provider's values when unset.
   */
  auxiliaryCompression?: {
    model: string;
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /**
   * tools-vision P3 — auxiliary vision model wiring. When `model` is set,
   * `vision_analyze` routes to this (typically vision-capable) provider when
   * the active personality's primary model can't handle images / PDFs.
   * `provider` / `apiKey` / `baseUrl` default to the primary provider's
   * values when unset, mirroring `auxiliaryCompression`.
   */
  auxiliaryVision?: {
    model: string;
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /**
   * tools-web — auxiliary model for web_extract summarization. Same shape as
   * auxiliaryVision. `provider`/`apiKey`/`baseUrl` default to the primary
   * provider's values when unset.
   */
  auxiliaryWeb?: {
    model: string;
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /**
   * Lane A Phase 2 (kanban-hooks-notify-parity) — auxiliary model for
   * `kanban_decompose`'s goal-to-children fan-out. Same shape as
   * auxiliaryVision/auxiliaryWeb: `provider`/`apiKey`/`baseUrl` default to the
   * primary provider's values when unset. When absent, `kanban_decompose`
   * still registers as a tool but returns a tool error at call time rather
   * than being omitted from the toolset.
   */
  auxiliaryKanbanDecomposer?: {
    model: string;
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /** tools-web — web_search backend preference. Auto-detect from env when unset. */
  webSearchBackend?: 'exa' | 'tavily' | 'brave';
  /** tools-web — `web.searxng.url`, the keyless metasearch rung for web_search. */
  searxngUrl?: string;
  /** Global FALLBACK layer for per-personality tool config (`web_search` in
   *  v1). The personality's own `tools.yaml` is the source of truth; this fills
   *  the gap for personalities that don't declare the tool. Keyed by
   *  personality ID (or `_default`). */
  toolSettings?: import('@ethosagent/config').ToolSettingsMap;
  /** DEFAULT voice STT provider. auxiliary.asr in config.yaml. `command` is the
   *  shell template the local `command-stt` recipe provider runs, `timeout` its
   *  budget in seconds. Named alternatives live in `voice.stt.providers.*`. */
  auxiliaryAsr?: import('@ethosagent/types').SttProviderEntry;
  /** DEFAULT voice TTS provider. auxiliary.tts in config.yaml. `command` is the
   *  shell template the local `command-tts` recipe provider runs, `outputFormat`
   *  the container it writes, `timeout` its budget in seconds, and
   *  `maxTextLength` the per-call text cap it advertises as
   *  `caps.maxInputChars`. Named alternatives live in `voice.tts.providers.*`. */
  auxiliaryTts?: import('@ethosagent/types').TtsProviderEntry;
  /**
   * Real-time voice deployment config — `voice.*` in config.yaml, mapped
   * straight through from `EthosConfig`. Read by `buildVoiceStack`: bots give
   * the personality binding + lane keys, `livekit`/`trunk` gate concrete
   * transport construction (absent → those transports are simply not built),
   * and `trustedPlugins` arms the local-only egress gate.
   */
  voice?: import('@ethosagent/config').EthosConfig['voice'];
  /**
   * memory-experience pillar B — proactive capture. Default-off; when
   * `enabled`, the capture runner is wired on the `agent_done` seam. `model`
   * (+ optional provider/apiKey/baseUrl) selects the auxiliary extraction
   * model; when unset the primary model is reused. Same shape as the
   * `EthosConfig.memoryCapture` block it maps from.
   */
  memoryCapture?: {
    enabled?: boolean;
    model?: string;
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
    maxPerHour?: number;
    maxPerDay?: number;
    /**
     * Recurrence-evidence threshold (plan openclaw-9.5-adoption item 3). 0 or
     * absent: off. N > 0: a captured fact is queued until N distinct sessions
     * have extracted it — auto-promoted when approval is `off`, ordered for a
     * human otherwise (`build-agent-loop.ts`).
     */
    evidenceSessions?: number;
  };
  /**
   * Approve-before-store gate (memory-lifecycle L2). Default-off. When
   * `mode !== 'off'`, gated writers (`capture`, `dream`, and — in `all` mode —
   * explicit tool writes) park candidates in a per-scope pending queue instead
   * of writing durably; approve replays through the provenance history. Mapped
   * from `EthosConfig.memoryApproval`.
   */
  memoryApproval?: {
    mode?: 'off' | 'automated' | 'all';
    cap?: number;
    ttlDays?: number;
  };
  /**
   * Nightly-pass scheduler flag (mapped from `EthosConfig.nightlyPass`). Read
   * here only to gate capture's inline consolidation fallback (§3.5): when a
   * macro-loop is configured, capture never inline-consolidates.
   */
  nightlyPass?: { enabled?: boolean; cron?: string };
  /** Per-surface capture-notice opt-in (§3.3), mapped from display.memory_notices. */
  displayMemoryNotices?: boolean;
  /**
   * The operator's `decisions.*` keys (mapped from `EthosConfig.decisions`,
   * carried by the `...config` spread in apps/ethos/src/wiring.ts). Absent →
   * no decision layer: every decision site runs today's path and no provider
   * handle is created (`createDecisionProviderHandle`, ./decision-provider).
   * Present, WHICH sites run is still each personality's
   * (`PersonalityConfig.decisions`, resolved per call by
   * `resolvePersonalityDecisionSite`).
   */
  decisions?: import('@ethosagent/config').DecisionsConfig;
  /** File-backed secrets resolver. When provided, the capability backend
   *  resolves secrets from ~/.ethos/secrets/ before falling back to env vars. */
  secretsResolver?: SecretsResolver;
  /** Storage-layer settings. */
  storage?: {
    backend?: string;
  };
  /**
   * Remote model catalog configuration. When provided with `enabled !== false`,
   * the wiring loads the remote catalog (with cache/fallback) and uses it
   * instead of the static bundled MODEL_CATALOG.
   */
  modelCatalogConfig?: {
    enabled?: boolean;
    url?: string;
    ttlHours?: number;
    providers?: Record<string, { url: string }>;
  };
  /** Callback for OAuth authorization user prompts (open-url, device-code).
   *  Surfaces (CLI/TUI/web) provide an implementation that shows the prompt. */
  onUserPrompt?: (prompt: import('@ethosagent/oauth-core').UserPrompt) => void;
  /** Whether to auto-install plugins from plugins.lock on personality load. */
  pluginsAutoInstall?: boolean;
}

/**
 * The surface a loop was assembled for. Stamped on every turn as
 * `AgentLoop.options.platform`, and therefore on the sessions the loop
 * creates — `'mcp'` is what makes an externally-driven conversation
 * distinguishable from the operator's own in `sessions.db` (M-D13,
 * plan/phases/trust-before-reach.md Part 3). Metadata: nothing branches on it.
 */
export type WiringProfile = 'cli' | 'tui' | 'web' | 'acp' | 'mcp';

/**
 * Minimal structural shape of the app-layer slash command registry. Wiring
 * must not import the apps' concrete class (layering: apps depend on wiring,
 * never the reverse), so this declares exactly what plugin loading needs to
 * surface plugin-registered commands in autocomplete + /help.
 */
export interface WiringSlashRegistry {
  register(cmd: { name: string; description: string; usage: string; prefix?: string }): void;
  get(name: string): { description?: string; usage?: string } | undefined;
}

export interface WiringCliSubcommandRegistry {
  register(cmd: {
    name: string;
    description: string;
    handler?: (ctx: CliSubcommandContext) => Promise<number>;
    pluginId?: string;
  }): void;
  get(name: string):
    | {
        name: string;
        description: string;
        handler?: (ctx: CliSubcommandContext) => Promise<number>;
        pluginId?: string;
      }
    | undefined;
  getAll(): {
    name: string;
    description: string;
    handler?: (ctx: CliSubcommandContext) => Promise<number>;
    pluginId?: string;
  }[];
}

export interface CreateAgentLoopOptions {
  /** Root data directory (typically `~/.ethos`). Sessions DB, memory, and
   *  user personalities all resolve under this path. */
  dataDir: string;
  /** Working directory tools see. Defaults to `process.cwd()`. */
  workingDir?: string;
  /**
   * Override for where personality built-ins load from — forwarded to
   * `WiringContext.builtinPersonalitiesDir` (see `types.ts` for the full
   * rationale). Needed only by bundled callers whose `import.meta.dirname`
   * no longer resolves to the source tree post-bundling (e.g. the desktop
   * app's electron-vite main bundle). Unset for every other caller.
   */
  builtinPersonalitiesDir?: string;
  /**
   * Override for the root directory containing call-capture's native
   * binaries — forwarded to `WiringContext.callCaptureNativeDir` (see
   * `types.ts` for the full rationale). Needed only by bundled callers
   * whose `import.meta.dirname` no longer resolves to the source tree
   * post-bundling (e.g. the desktop app's electron-vite main bundle). Unset
   * for every other caller.
   */
  callCaptureNativeDir?: string;
  /** Surface label surfaced to tools/hooks as `AgentLoop.options.platform`.
   *  Pure metadata — no behavioral branches keyed on it. */
  profile?: WiringProfile;
  /** Skip Docker init and the tools that depend on it (run_code, browser).
   *  Useful in containers / CI / web profiles where Docker isn't reachable. */
  disableDocker?: boolean;
  /**
   * Turn OFF everything that writes back what a turn said: the improvement
   * fork's `agent_done` learner (`ImprovementFork.register()`) and proactive
   * memory capture's (`MemoryCaptureRunner.registerHook`), both in
   * `build-agent-loop.ts`.
   *
   * A security property, not a preference (M-D6, plan/phases/trust-before-reach.md
   * Part 3). In a process whose turns are driven by an EXTERNAL MCP client, a
   * post-turn learner makes that client's text into the operator's memory and
   * skills with nobody in the loop — a persistent-injection path that survives
   * the session. Any host that lets someone other than the operator start a
   * turn sets this; the export server (`ethos mcp serve --personality <id>`) is
   * the first.
   *
   * What it does NOT disable: an explicit `memory_write` the turn itself makes.
   * That is a tool call, visible in the transcript and gated by the toolset and
   * by `expose_memory` (`resolveMcpExportScope`, `./mcp-export.ts`).
   *
   * Pinned by `packages/wiring/src/__tests__/post-turn-learning.test.ts`.
   */
  disablePostTurnLearning?: boolean;
  /**
   * Assemble this loop as ONE ARM OF A REPLAY (L-T3, plan/phases/trust-before-reach.md
   * Part 4, Design section 3). A replay measures a learning candidate against
   * frozen past cases: one arm runs on what is live, the other on a loop that
   * sees exactly one path differently. Set by `createReplayLoop`
   * (`./learning-replay.ts`); no other caller should set it by hand.
   *
   * What it changes, all of it isolation:
   *  - `WiringContext.storage` becomes `storage` — an `OverlayStorage`
   *    (`@ethosagent/learning-inbox`) that shadows the candidate's one path and
   *    throws `BoundaryError` on every write. The SAME handle is what the
   *    `AgentLoop` reads SOUL.md and skills through (`build-agent-loop.ts`), so
   *    the shadow is what the model actually sees.
   *  - the loop's `SessionStore` becomes `session` — an in-memory store, so a
   *    replay turn never lands in `sessions.db`. The isolation precedent is
   *    `ImprovementFork.run` step 4 (`extensions/skill-evolver/src/improvement-fork.ts`).
   *  - `disablePostTurnLearning` is forced on in `createAgentLoop`, so the
   *    `ImprovementFork` is not registered and proactive memory capture does not
   *    run: a replay must never feed learning. One gate, not a second mechanism.
   *  - the memory provider is wrapped read-only (`sync` is a no-op), so a
   *    turn-end memory flush neither writes nor trips the overlay's refusal.
   *  - `contextLog` and `contentStore` are left off the loop, so the
   *    model-visible⟺logged path writes no `sessions.db` rows and no CAS blobs
   *    for a measurement (`stages/context-emit.ts` is a no-op unless both are
   *    set).
   *
   * What it does NOT change, and cannot: assembling ANY loop opens
   * `sessions.db` (three raw-SQLite connections, `build-infrastructure.ts`) —
   * `Storage` does not police a raw path. What keeps a replay from PUBLISHING
   * is `RunOptions.dryRun` (X-D6), which is the runner's job to pass, not this
   * option's. Pinned by `./__tests__/replay-isolation.test.ts`.
   */
  replay?: { storage: Storage; session: SessionStore };
  /** Optional log sink for non-fatal warnings (e.g. Docker missing, skill
   *  skipped). Defaults to a no-op so the package stays headless. */
  logger?: Logger;
  /** Absolute path to the mesh registry file this agent belongs to.
   *  Controls which peers route_to_agent and broadcast_to_agents can see.
   *  Defaults to the 'default' mesh (~/.ethos/meshes/default/registry.json).
   *  Set by ethos serve --mesh <name> so team members route within their mesh. */
  meshRegistryPath?: string;
  /**
   * Optional observability adapter. When provided, passed through to
   * AgentLoop so LLM calls, tool calls, and hook blocks are recorded via
   * typed domain helpers. When absent, no observability writes occur.
   *
   * Construct as `new EthosObservability(observabilityService)` at the
   * call site; the adapter owns the ethos vocabulary while the underlying
   * service stays vocabulary-agnostic.
   */
  observability?: import('./observability/ethos-observability').EthosObservability;
  /**
   * Shared CronScheduler for agent-callable cron tools. When provided, the
   * 6 tools from `@ethosagent/tools-cron` (`create_cron_job`,
   * `list_cron_jobs`, `delete_cron_job`, `pause_cron_job`,
   * `resume_cron_job`, `run_cron_job_now`) are registered on this
   * AgentLoop's tool registry. Personalities opt in by listing the tool
   * names in their `toolset.yaml` — the same scheduler instance that fires
   * operator-created jobs also accepts agent-created ones.
   *
   * When unset, the cron tools are not registered, and personalities that
   * list them get an "unknown tool" error at call time. CLI / standalone
   * `ethos chat` profiles typically leave this unset; `ethos gateway` and
   * `ethos serve` pass their scheduler instance through.
   */
  cronScheduler?: CronScheduler;
  /**
   * Shared WatcherManager for agent-callable watcher tools. When provided,
   * the 5 tools from `@ethosagent/tools-watchers` (`watcher_create`,
   * `watcher_list`, `watcher_pause`, `watcher_resume`, `watcher_delete`)
   * are registered on this AgentLoop's tool registry (toolset `watchers`).
   * Ticks piggyback on the shared CronScheduler as `source:'system'` jobs —
   * long-lived surfaces (`ethos gateway`, `ethos serve`) pass the manager
   * they wired next to their scheduler; CLI/standalone profiles leave it
   * unset and the tools are not registered.
   */
  watcherManager?: import('@ethosagent/watchers').WatcherManager;
  /**
   * The approval outbox — what makes `outbound_policy.approve_before_send`
   * real for `send_message` and `watcher_create` (O-T3/O-T12,
   * plan/phases/trust-before-reach.md).
   *
   * Two things wiring cannot answer for itself, both app-layer: the operator's
   * own chat on a platform (`channel_filter.<platform>.ownerUserId`, an exempt
   * destination), and queueing a publication — which resolves the sending bot
   * from the config's bindings and writes the durable row. Build it with
   * `createOutboxRuntime` (`apps/ethos/src/lib/outbox-wiring.ts`) and pass
   * `runtime.wiring`.
   *
   * Absent → no gate is constructed at all and both tools behave exactly as
   * they did before Part 2. That is the right answer only for a surface with
   * no path to a channel — one that never calls `setMessagingSend` and passes
   * no `watcherManager` (CLI chat, one-shot runs, tests). Holding no adapters
   * is not the test: `ethos serve` holds none and still passes one, because
   * its watchers' stored `deliver` targets are sent by a gateway.
   */
  outbox?: OutboxWiring;

  /**
   * Shared call history for the outbound `call` tool. When provided, a call the
   * agent places opens a row the same way an inbound one does, so the
   * Communications call list is the whole story rather than the inbound half of
   * it. Pass the SAME instance the surface's inbound dispatch writes to — a
   * second `SQLiteCallLog` on the same file is a second connection for no gain.
   *
   * Absent (chat, one-shot CLI, tests) and `call` dials exactly as before,
   * writing nothing: the log is a seam, never a precondition for dialling.
   */
  callLog?: import('@ethosagent/call-log').CallLog;
  /**
   * App-layer slash command registry. When provided, plugins that call
   * `registerSlashCommand` during loading land their commands here so the
   * CLI's autocomplete and /help can surface them. Omit for surfaces with
   * no slash command UI (web, ACP).
   */
  slashRegistry?: WiringSlashRegistry;
  /**
   * App-layer CLI subcommand registry. When provided, plugins that call
   * `registerCliSubcommand` during loading land their commands here so the
   * CLI's `--help` and boot dispatch can surface them. Omit for surfaces
   * with no CLI subcommand UI (web, ACP).
   */
  cliSubcommandRegistry?: WiringCliSubcommandRegistry;
  /** True for one-shot CLI invocations that exit immediately — disables the
   *  background executor by default (a job spawned in a dying process is a lie).
   *  Long-lived surfaces (chat, gateway, web) omit it. */
  oneShot?: boolean;
  /**
   * The bot identity this loop answers as, stamped on every background job it
   * spawns (`origin_bot_key`). The gateway builds one loop per bot and passes
   * the same key it routes that bot's inbound messages by — that column is what
   * makes a completion routable back to its lane after a restart. Surfaces with
   * no bot identity (CLI, web) omit it.
   */
  originBotKey?: string;
  /**
   * Resolve the thread a live turn on `sessionKey` originated in, for stamping
   * `origin_thread_id` on background jobs. Supplied by the gateway (the only
   * component that knows the mapping); omitted elsewhere, in which case a
   * completion is delivered to the channel root.
   */
  resolveOriginThreadId?: (sessionKey: string) => string | undefined;
  /**
   * Lane 0 (eng review D16) — force a LIVE served-window probe (bypassing the
   * 15-minute disk cache) and rewrite the cache. Set by the command paths
   * whose numbers the operator tunes against (`ethos doctor`, `ethos bench
   * context`); chat and gateway startup leave it unset and ride the cache.
   */
  probeWindowRefresh?: boolean;
  /**
   * Native LiveKit MEDIA binding, forwarded to `buildVoiceStack`.
   *
   * `@livekit/rtc-node` ships a per-arch native binary and is deliberately NOT
   * a repo dependency (see `extensions/platform-voice/src/livekit/room-client.ts`),
   * so the app layer loads it optionally and passes the binding down. Absent —
   * which is every deployment that does not do telephony, and every test — the
   * voice stack builds exactly as it did before and the LiveKit/SIP media
   * transports report themselves unavailable.
   */
  livekit?: import('./voice-stack').LiveKitBindings;
}

// ---------------------------------------------------------------------------
// LLM provider construction
// ---------------------------------------------------------------------------

// L-T8 — the inbox's own types, re-exported so a surface (web-api) reaches the
// review inbox through the composition root rather than a second package link.
export {
  AWAITING_DECISION,
  type CandidateStatus,
  type CurrentContent,
  LEARNING_AUDIT_CODES,
  type LearningCandidate,
  type LearningCandidateDetail,
  type LearningInbox,
  type LearningInboxRefusal,
  type LearningInboxResult,
  type LearningObservability,
  REPLAY_LIMITATIONS,
  type ReplayAndResolveResult,
  type ReplayReport,
} from '@ethosagent/learning-inbox';
export {
  type A2aIdentityView,
  A2aPeeringError,
  type A2aPeeringErrorCode,
  A2aPeeringService,
  type A2aPeeringServiceDeps,
  type A2aPeerRow,
  type AddPeerArgs,
  type BuildA2aPeeringServiceContext,
  buildA2aPeeringService,
  createA2aPeeringService,
} from './a2a-peering-service';
// F06 — the cleanup stack every composition root in this repo registers on.
export { DISPOSE_STEP_TIMEOUT_MS, DisposerStack } from './disposer-stack';
export { resolveKanbanDbPath } from './kanban-path';
// L-T6 — the learning inbox's composition root: every submit, replay, legacy
// import and promotion binds the inbox to real packages through these.
export {
  type CaseSessionSource,
  createLearningInbox,
  createLearningReplayer,
  freezeLatestUserTurnCase,
  freezeNightlyCases,
  freezeRecentSessionCases,
  importLegacyLearningQueues,
  type LearningContext,
  type LearningInboxOptions,
  type LearningReplayerOptions,
  learningPendingSkillsPort,
  learningPolicyFor,
  learningPromoteDeps,
  learningSubmitPort,
  listPendingExpressionCandidates,
  pendingReplayCandidateIds,
  personalityCore,
  promoteLearningCandidate,
  rejectLearningCandidate,
  submitExpressionCandidate,
  toPendingSkillSummary,
} from './learning-pipeline';
// Lane 6 (D5 + D19) — the arithmetic model-fit verdict: `computeModelFit` is
// the pure division; `resolvePersonalityModelFit` is the one assembler both
// the CLI (`ethos personality show`) and the `personalities.characterSheet`
// RPC seam call, so the surfaces can never disagree.
export { type ComputeModelFitInputs, computeModelFit } from './model-fit';
export {
  type ResolvePersonalityModelFitOptions,
  resolvePersonalityModelFit,
} from './personality-fit';
// The project-context term of the static floor, for surfaces with no turn in
// hand (`ethos bench context`, the character sheet).
export {
  createProjectContextInjector,
  declaredWorkdirProjectContext,
  projectContextAtStartup,
} from './project-context-floor';
// Lane 1(b/c/e) + D8 — the shared static-floor measurement and window-scaled
// result-budget arithmetic (consumed by build-agent-loop, `ethos bench
// context`, and — later — Lane 6's fit verdict).
export {
  type ContextFitVerdict,
  evaluateContextFit,
  evaluateToolPayloadGuard,
  evaluateToolSchemaBudget,
  type MeasurableToolDefinition,
  measureStaticFloor,
  measureToolSchemaSizes,
  outputReserveTokens,
  RESULT_BUDGET_CEILING_CHARS,
  RESULT_BUDGET_FLOOR_CHARS,
  resolveResultBudget,
  type StaticFloorComponent,
  type StaticFloorInputs,
  type StaticFloorMeasurement,
  TOOL_PAYLOAD_GUARD_DEFAULT_CHARS,
  type ToolPayloadGuardVerdict,
  type ToolSchemaBudgetVerdict,
} from './static-floor';

// Hard ceiling on a single summarizer call. The summarizer runs on the turn's
// critical path before the main provider call, so a hung auxiliary provider
// would otherwise hang the whole turn. On timeout the call aborts and throws,
// which `maybeCompact` catches and fails open to the un-compacted history.
// (Q6 will add a tighter timeout + a fallback model; this is the floor.)
const SUMMARIZER_TIMEOUT_MS = 30_000;

// context_compression F1 — build the real LLM summarizer for `semantic_summary`.
// Runs on the auxiliary (typically cheap) model so a compacting turn costs
// ~one Haiku-tier call rather than a full main-model re-prompt. Fails open: a
// throw here is caught by the engine's caller (`maybeCompact`), which ships
// the un-compacted history and records a degradation event.
// Lane 5(ii) — the summarizer's provider gets the SAME window/profile
// threading as the main provider (D15 precedence: config > cached probe >
// catalog > default). Without it the provider inherits the 128k default —
// the §0 mis-sizing — so the summarizer's own compaction arithmetic lies on
// local setups. Exported for tests (asserted at the factory seam).
export function buildCompressionSummarizer(
  registry: import('@ethosagent/types').LLMProviderRegistry,
  config: WiringConfig,
  observability: EthosObservability | undefined,
  log: Logger,
  windowProbe?: WindowProbeContext,
): SummarizerFn {
  const aux = config.auxiliaryCompression;
  const providerName = aux?.provider ?? config.provider;
  const model = aux?.model ?? config.model;
  const baseUrl = aux?.baseUrl ?? config.baseUrl;
  let cachedProvider: LLMProvider | undefined;

  const getProvider = async (): Promise<LLMProvider> => {
    if (cachedProvider) return cachedProvider;
    const factory = registry.get(providerName);
    if (!factory) {
      throw new Error(
        `LLM provider "${providerName}" is not registered (compression summarizer). ` +
          `Available: ${registry.list().join(', ')}`,
      );
    }
    const NOOP: import('@ethosagent/types').SecretsResolver = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    // Lane 0 precedence, cache-first: the summarizer is not a diagnostic
    // command, so the probe never forces a live refresh here — a warm cache
    // resolves with no network call.
    const isPrimary = providerName === config.provider && model === config.model;
    const runtime = detectLocalRuntime(providerName, baseUrl ?? '');
    let probe: WindowProbeResult | undefined;
    if (runtime !== undefined && baseUrl !== undefined && windowProbe !== undefined) {
      probe = await probeServedWindowCached({
        runtime,
        baseUrl,
        model,
        storage: windowProbe.storage,
        cachePath: windowProbeCachePath(windowProbe.dataDir),
        ...(windowProbe.fetchImpl !== undefined ? { fetchImpl: windowProbe.fetchImpl } : {}),
      });
    }
    const resolvedWindow = resolveContextWindow({
      provider: providerName,
      model,
      ...(isPrimary && config.contextWindow !== undefined
        ? { configWindow: config.contextWindow }
        : {}),
      ...(probe !== undefined ? { probe } : {}),
      ...(() => {
        const catalogWindow =
          lookupContextWindow(providerName, model) ?? PROVIDER_WINDOW_DEFAULTS[providerName];
        return catalogWindow !== undefined ? { catalogWindow } : {};
      })(),
      localRuntime: runtime !== undefined,
    });
    for (const diagnostic of resolvedWindow.diagnostics) {
      log.warn(`compression summarizer: ${diagnostic}`);
    }
    const profile = mergeModelProfile(
      lookupProfile(providerName, model),
      config.models?.[`${providerName}/${model}`],
    );
    cachedProvider = await factory({
      config: {
        provider: providerName,
        model,
        apiKey: aux?.apiKey ?? config.apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
        ...(resolvedWindow.contextWindow !== undefined
          ? { maxContextTokens: resolvedWindow.contextWindow }
          : {}),
        ...(profile?.toolCallFormat !== undefined
          ? { toolCallFormat: profile.toolCallFormat }
          : {}),
        ...(profile?.maxOutputTokens !== undefined
          ? { maxOutputTokens: profile.maxOutputTokens }
          : {}),
        ...(profile?.structuredOutput !== undefined
          ? { structuredOutput: profile.structuredOutput }
          : {}),
        ...(profile?.parseThinkTags !== undefined
          ? { parseThinkTags: profile.parseThinkTags }
          : {}),
        // FIX 8 — this path already surfaced any unknown-window diagnostic
        // (prefixed 'compression summarizer:' above); the factory must not
        // log a near-identical second copy.
        windowResolutionDiagnosed: true,
      },
      secrets: config.secretsResolver ?? NOOP,
      logger: log,
    });
    return cachedProvider;
  };

  return async (middle, targetTokens, instructions) => {
    const provider = await getProvider();
    const startedAt = Date.now();
    let text = '';
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const stream = provider.complete(
        [{ role: 'user', content: renderMiddleForSummary(middle) }],
        [],
        {
          system: buildSummarizerSystemPrompt(instructions),
          maxTokens: Math.ceil(targetTokens * 1.5),
          abortSignal: AbortSignal.timeout(SUMMARIZER_TIMEOUT_MS),
        },
      );
      for await (const chunk of stream) {
        if (chunk.type === 'text_delta') {
          text += chunk.text;
        } else if (chunk.type === 'usage') {
          costUsd = chunk.usage.estimatedCostUsd;
          inputTokens = chunk.usage.inputTokens;
          outputTokens = chunk.usage.outputTokens;
        }
      }
    } catch (err) {
      log.warn(
        `compression summarizer failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      log.warn('compression summarizer returned empty output');
      throw new Error('compression summarizer returned empty output');
    }
    const summary = capSummary(trimmed, targetTokens);
    observability?.recordCompaction({
      code: 'compaction_summarized',
      cause: `${provider.model}: summarized ${middle.length} message(s)`,
      details: {
        model: provider.model,
        inputTokens,
        outputTokens,
        costUsd,
        durationMs: Date.now() - startedAt,
      },
    });
    return summary;
  };
}

/**
 * Lane 0 (eng review D3+D16) — context needed to run the served-window probe
 * with its disk cache. When absent, no probe runs and resolution falls back
 * to config > catalog > default (preserves pre-Lane-0 callers unchanged).
 */
export interface WindowProbeContext {
  storage: Storage;
  dataDir: string;
  /** Bypass the 15-min cache: probe LIVE and rewrite it. Set by the command
   *  paths an operator tunes against (setup / doctor / personality show /
   *  bench context); chat and gateway startup leave it unset. */
  forceRefresh?: boolean;
  /** Test seam — stub fetch so probes stay off the network. */
  fetchImpl?: typeof fetch;
}

export async function createLLM(
  config: WiringConfig,
  windowProbe?: WindowProbeContext,
  log?: Logger,
): Promise<LLMProvider> {
  const registry = new DefaultLLMProviderRegistry();
  registerBuiltinProviders(registry);
  const noop: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => noop,
  };
  return createLLMFromRegistry(registry, config, log ?? noop, undefined, windowProbe);
}

/**
 * §4.B trust gate — default-deny for plugin-contributed LLM providers.
 * Built-in providers (no `/` in name) are always allowed.
 * Plugin providers (`pluginId/name`) require `pluginId` in the allowlist.
 * When `allowedPlugins` is undefined, all providers are allowed (backward compat).
 */
export function isProviderAllowed(providerName: string, allowedPlugins?: string[]): boolean {
  if (!allowedPlugins) return true;
  if (!providerName.includes('/')) return true;
  const pluginId = providerName.split('/')[0] ?? '';
  return allowedPlugins.includes(pluginId);
}

/**
 * Item 7 (D32) — the server-compaction setting for one provider entry, or
 * `undefined` when it compacts locally. Honoured only for `anthropic`: any
 * other provider with the flag gets a warning and local compaction. The
 * trigger defaults to the local gate's own threshold for the model
 * (`pressureGateTokens` over the provider's reported window, with the resolved
 * `compaction.pressure` and `compaction.maxContextTokens`), so the switch
 * changes WHO compacts, not WHEN.
 */
function serverCompactionFor(
  cfg: {
    provider: string;
    model: string;
    serverCompaction?: boolean;
    serverCompactionTriggerTokens?: number;
  },
  config: WiringConfig,
  log: Logger,
): { triggerTokens: number } | undefined {
  if (cfg.serverCompaction !== true) return undefined;
  if (cfg.provider !== 'anthropic') {
    log.warn(
      `providers: serverCompaction is honoured only on an anthropic entry; the "${cfg.provider}" ` +
        'entry compacts locally.',
    );
    return undefined;
  }
  const profile = mergeModelProfile(
    lookupProfile(cfg.provider, cfg.model),
    config.models?.[`${cfg.provider}/${cfg.model}`],
  );
  const triggerTokens =
    cfg.serverCompactionTriggerTokens ??
    pressureGateTokens(
      anthropicContextTokens(cfg.model),
      resolveCompactionGate(profile, config.compaction)?.pressure,
      config.compaction?.maxContextTokens,
    );
  return { triggerTokens };
}

/**
 * Registry-aware LLM creation — used internally by `createAgentLoop` after
 * plugins have loaded. Falls through to the registry for each provider name,
 * so plugin-contributed providers participate in chained failover.
 */
async function createLLMFromRegistry(
  registry: import('@ethosagent/types').LLMProviderRegistry,
  config: WiringConfig,
  log: Logger,
  allowedPlugins?: string[],
  windowProbe?: WindowProbeContext,
  observability?: EthosObservability,
): Promise<LLMProvider> {
  const secrets: import('@ethosagent/types').SecretsResolver = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  };

  const resolveOne = async (
    cfg: {
      provider: string;
      model: string;
      apiKey: string;
      baseUrl?: string;
      apiVersion?: string;
      region?: string;
      awsProfile?: string;
      serverCompaction?: boolean;
      serverCompactionTriggerTokens?: number;
    },
    opts: { chainHop?: boolean } = {},
  ): Promise<LLMProvider> => {
    // §4.B trust gate: plugin-contributed providers (pluginId/name) require
    // the plugin to be in the personality's allowed-plugins list.
    if (!isProviderAllowed(cfg.provider, allowedPlugins)) {
      const pluginId = cfg.provider.split('/')[0] ?? '';
      throw new Error(
        `LLM provider "${cfg.provider}" is from plugin "${pluginId}" which is not in ` +
          `the personality's allowed plugins list. Add "${pluginId}" to personality.plugins ` +
          `to use this provider.`,
      );
    }

    const factory = registry.get(cfg.provider);
    if (!factory) {
      throw new Error(
        `LLM provider "${cfg.provider}" is not registered. ` +
          `Available: ${registry.list().join(', ')}`,
      );
    }
    // Lane 0 — resolve the model's context window with the D15 precedence:
    // config > probe > catalog > default. The probe runs only for a detected
    // local runtime (hosted endpoints are never probed), cache-first on
    // chat/gateway startup (D3) and live when the caller forces a refresh
    // (D16). A full miss leaves the field absent → the provider default still
    // applies (no crash), with the loud unknown-window diagnostic below.
    const isPrimary = cfg.provider === config.provider && cfg.model === config.model;
    const configWindow = isPrimary ? config.contextWindow : undefined;
    const runtime = detectLocalRuntime(cfg.provider, cfg.baseUrl ?? '');
    let windowProbeResult: WindowProbeResult | undefined;
    if (runtime !== undefined && cfg.baseUrl !== undefined && windowProbe !== undefined) {
      windowProbeResult = await probeServedWindowCached({
        runtime,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        storage: windowProbe.storage,
        cachePath: windowProbeCachePath(windowProbe.dataDir),
        ...(windowProbe.forceRefresh !== undefined
          ? { forceRefresh: windowProbe.forceRefresh }
          : {}),
        ...(windowProbe.fetchImpl !== undefined ? { fetchImpl: windowProbe.fetchImpl } : {}),
      });
    }
    const resolvedWindow = resolveContextWindow({
      provider: cfg.provider,
      model: cfg.model,
      ...(configWindow !== undefined ? { configWindow } : {}),
      ...(windowProbeResult !== undefined ? { probe: windowProbeResult } : {}),
      ...(() => {
        const catalogWindow =
          lookupContextWindow(cfg.provider, cfg.model) ?? PROVIDER_WINDOW_DEFAULTS[cfg.provider];
        return catalogWindow !== undefined ? { catalogWindow } : {};
      })(),
      localRuntime: runtime !== undefined,
    });
    for (const diagnostic of resolvedWindow.diagnostics) log.warn(diagnostic);
    const contextWindow = resolvedWindow.contextWindow;
    // §7 — resolve the effective per-model profile (config override OVER catalog)
    // and thread its provider-facing fields (toolCallFormat, maxOutputTokens)
    // into the factory config, next to maxContextTokens. Sampling defaults are
    // handled at the loop (see resolveModelProfile / buildAgentLoop). No profile
    // → no fields injected → behavior byte-identical to today.
    const profile = mergeModelProfile(
      lookupProfile(cfg.provider, cfg.model),
      config.models?.[`${cfg.provider}/${cfg.model}`],
    );
    const serverCompaction = serverCompactionFor(cfg, config, log);
    const provider = await factory({
      config: {
        ...(cfg as unknown as Record<string, unknown>),
        // Item 7 — the resolved trigger, never the raw config value alone;
        // `anthropicFactory` sends the edit only when both are present.
        serverCompaction: serverCompaction !== undefined,
        ...(serverCompaction
          ? { serverCompactionTriggerTokens: serverCompaction.triggerTokens }
          : {}),
        ...(contextWindow !== undefined ? { maxContextTokens: contextWindow } : {}),
        ...(profile?.toolCallFormat !== undefined
          ? { toolCallFormat: profile.toolCallFormat }
          : {}),
        ...(profile?.maxOutputTokens !== undefined
          ? { maxOutputTokens: profile.maxOutputTokens }
          : {}),
        // §3 — a profile that declares structured-output support turns on the
        // provider's `capabilities.structuredOutput`, which internal JSON
        // consumers gate on. Absent → capability stays unset (unchanged).
        ...(profile?.structuredOutput !== undefined
          ? { structuredOutput: profile.structuredOutput }
          : {}),
        // FIX 5 — <think>-tag parsing opt-in for hosted reasoning models.
        // Absent → the provider derives it from its local classification.
        ...(profile?.parseThinkTags !== undefined
          ? { parseThinkTags: profile.parseThinkTags }
          : {}),
        // Lane 2a — tool-ordering escape hatch (global, applies to every
        // resolved provider). Absent → the provider's 'stable' default.
        ...(config.toolOrder !== undefined ? { toolOrder: config.toolOrder } : {}),
        // Lane 4a(d) — request deadline + retry count (global, applies to
        // every resolved provider). Absent → the SDK defaults stay in force.
        ...(config.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: config.requestTimeoutMs }
          : {}),
        //
        // A hop in a chain of two or more does NOT retry on its own: the SDKs'
        // retries honour `retry-after`, so a 429 with `retry-after: 30` held a
        // turn on the failing hop for ~60s (three attempts) before
        // `ChainedProvider` could fail over. In a chain the failover + cooldown
        // IS the retry policy, so hops get `maxRetries: 0`. An explicit
        // operator `maxRetries` still wins — it is documented as global, one
        // value for every resolved provider (`EthosConfig.maxRetries` in
        // packages/config/src/index.ts). A single provider keeps the SDK
        // default. Pinned by `provider-chain-wiring.test.ts`. A pinned call
        // cannot fail over (D21), so `ChainedProvider.complete` gives it a
        // bounded retry of its own entry instead (`PINNED_MAX_ATTEMPTS` in
        // packages/core/src/providers/chained-provider.ts).
        ...(() => {
          const maxRetries = config.maxRetries ?? (opts.chainHop ? 0 : undefined);
          return maxRetries !== undefined ? { maxRetries } : {};
        })(),
        // Lane 3(a) — llamacpp-class runtimes (llama.cpp server, Ollama,
        // LM Studio — all GBNF grammar compilers) get the schema sanitizer at
        // the provider boundary (D7). vLLM is local but not llamacpp-class
        // (no GBNF lowering of tool schemas); hosted dialects never sanitize.
        ...(runtime === 'llamacpp' || runtime === 'ollama' || runtime === 'lmstudio'
          ? { toolSchemaProfile: 'llamacpp' }
          : {}),
        // FIX 8 — resolveContextWindow above already logged any unknown-window
        // diagnostic for this provider; suppress the factory's duplicate copy
        // so the condition surfaces exactly ONE warning.
        windowResolutionDiagnosed: true,
      },
      secrets: config.secretsResolver ?? secrets,
      logger: log,
    });
    // Capability validation: LLMProvider requires supportsCaching,
    // supportsThinking, and maxContextTokens. TypeScript enforces this for
    // typed plugins. For JS plugins, a missing field would surface as
    // undefined reads in the agent loop — fail-loud at resolution time.
    if (
      typeof provider.supportsCaching !== 'boolean' ||
      typeof provider.supportsThinking !== 'boolean' ||
      typeof provider.maxContextTokens !== 'number'
    ) {
      throw new Error(
        `LLM provider "${cfg.provider}" is missing required capability declarations ` +
          `(supportsCaching, supportsThinking, maxContextTokens). ` +
          `These must be declared on the provider instance.`,
      );
    }
    // The loop reads the same fact to skip its own compaction for turns this
    // instance serves (`servesServerCompaction`, packages/core).
    return serverCompaction ? markServerCompaction(provider) : provider;
  };

  if (config.providers && config.providers.length >= 2) {
    // Every instance is tagged with its provider ENTRY key (`providers.<n>.id`,
    // else `deriveProviderKey`'s positional default) so a turn can scope a
    // model to the entry a registry alias names (`routeTurnModel` in
    // packages/core/src/agent-loop/model-route.ts).
    //
    // D23b — which entries are hops (`failover: false` ones are not, and the
    // all-opted-out fallback) is `selectServingProviderEntries`, the rule the
    // character sheet's `resolveActiveLlmName` names the LLM by.
    const serving = selectServingProviderEntries(config.providers, config.modelRegistry);
    // Only a real chain disables per-hop SDK retries; one hop left is used
    // directly below and keeps the single-provider behaviour.
    const chainHop = serving.length >= 2;
    const instances = await Promise.all(
      serving.map((hop) =>
        resolveOne(
          {
            provider: hop.entry.provider,
            model: hop.entry.model ?? config.model,
            apiKey: hop.entry.apiKey,
            ...(hop.entry.baseUrl !== undefined ? { baseUrl: hop.entry.baseUrl } : {}),
            ...(hop.entry.apiVersion !== undefined ? { apiVersion: hop.entry.apiVersion } : {}),
            ...(hop.entry.region !== undefined ? { region: hop.entry.region } : {}),
            ...(hop.entry.awsProfile !== undefined ? { awsProfile: hop.entry.awsProfile } : {}),
            ...(hop.entry.serverCompaction !== undefined
              ? { serverCompaction: hop.entry.serverCompaction }
              : {}),
            ...(hop.entry.serverCompactionTriggerTokens !== undefined
              ? { serverCompactionTriggerTokens: hop.entry.serverCompactionTriggerTokens }
              : {}),
          },
          { chainHop },
        ).then((instance) => tagProviderEntry(instance, hop.key)),
      ),
    );
    // One hop left: use it directly, exactly as the single-provider path does.
    const [only] = instances;
    if (instances.length === 1 && only) return only;
    return new ChainedProvider(
      instances,
      observability ? { onFailover: (event) => observability.recordProviderFailover(event) } : {},
    );
  }

  // The top-level spelling IS chain entry 0 (D2), so it carries that entry's key.
  const [head] = config.providers ?? [];
  const topKey =
    head && head.provider === config.provider ? deriveProviderKey(head, 0) : config.provider;
  // Item 7 — the same rule gives the top-level spelling entry 0's
  // server-compaction switch.
  const topCompaction =
    head && head.provider === config.provider
      ? {
          ...(head.serverCompaction !== undefined
            ? { serverCompaction: head.serverCompaction }
            : {}),
          ...(head.serverCompactionTriggerTokens !== undefined
            ? { serverCompactionTriggerTokens: head.serverCompactionTriggerTokens }
            : {}),
        }
      : {};

  // Anthropic rotation pool is provider-specific (rotates across API keys for
  // the same model). Handled inline — rotation is an Anthropic concern, not a
  // registry concern.
  if (config.provider === 'anthropic') {
    const rotation = config.rotationKeys ?? [];
    if (rotation.length > 0) {
      const serverCompaction = serverCompactionFor(
        { provider: config.provider, model: config.model, ...topCompaction },
        config,
        log,
      );
      const pool = new AuthRotatingProvider(
        [
          { id: 'primary', apiKey: config.apiKey, priority: 100 },
          ...rotation.map((k, i) => ({
            id: k.label ?? `key-${i + 1}`,
            apiKey: k.apiKey,
            priority: k.priority,
          })),
        ],
        config.model,
        // Lane 2a — the tool-ordering escape hatch applies to rotation pools
        // too, and so does the per-request deadline: every pooled key builds
        // its own client, so a deadline set only on the non-rotating path
        // would silently not apply to a rotation deployment.
        config.toolOrder !== undefined ||
          config.requestTimeoutMs !== undefined ||
          serverCompaction !== undefined
          ? {
              ...(config.toolOrder !== undefined ? { toolOrder: config.toolOrder } : {}),
              ...(config.requestTimeoutMs !== undefined
                ? { requestTimeoutMs: config.requestTimeoutMs }
                : {}),
              ...(serverCompaction ? { serverCompaction } : {}),
            }
          : undefined,
      );
      if (serverCompaction) markServerCompaction(pool);
      return tagProviderEntry(pool, topKey);
    }
  }

  const primary = await resolveOne({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiVersion !== undefined ? { apiVersion: config.apiVersion } : {}),
    ...(config.region !== undefined ? { region: config.region } : {}),
    ...(config.awsProfile !== undefined ? { awsProfile: config.awsProfile } : {}),
    ...topCompaction,
  });
  return tagProviderEntry(primary, topKey);
}

// Part 3 (plan/phases/trust-before-reach.md) — honouring `mcp_export`: the pure
// declaration→scope resolver and the per-client bearer check the export server
// runs on every call.
export {
  type CreateMcpClientAuthenticatorOptions,
  createMcpClientAuthenticator,
  type McpApiKeyStoreView,
  type McpClientAuthenticator,
  type McpClientAuthResult,
  type McpClientDenyReason,
  type McpExportScope,
  type McpExportToolView,
  resolveMcpExportScope,
} from './mcp-export';
// Skill passthrough helpers live in a separate file so tests can import them
// without pulling in the heavy plugin-loader / docker / mcp dependency chain.
export { applySkillPassthrough, deriveSkillPassthrough } from './skill-passthrough';
// Tool-scope helper — turns an allowlist into the `toolsetExclude` denylist
// that also reaches MCP, plugin and `alwaysInclude` tools. Separate file, no
// heavy imports, so a caller can take it without the composition chain.
export { complementExclude } from './tool-scope';

// ---------------------------------------------------------------------------
// AgentLoop assembly
// ---------------------------------------------------------------------------

export interface CreateAgentLoopResult {
  loop: AgentLoop;
  /**
   * The registry the loop runs on — the CONCRETE `DefaultToolRegistry`, not the
   * narrower `ToolRegistry` contract from `@ethosagent/types`.
   *
   * It always was one (`buildInfrastructure` constructs it); the field merely
   * stopped saying so, and `toolNamesForPersonality` — the personality's full
   * reach, which `resolveMcpExportScope` (`./mcp-export`) needs on every
   * exported call — lives only on the class. Narrowing it here cost every
   * caller that wants the reach an `as` cast at the call site, which is a
   * worse trade than naming the type once. Every consumer that only wants the
   * contract (`createWebApi`, the realtime surface, the tool-settings service)
   * keeps taking `ToolRegistry` and accepts this unchanged.
   */
  toolRegistry: DefaultToolRegistry;
  /**
   * F06 — release everything this call started or opened, in exactly this
   * order (the reverse of construction, `DisposerStack`):
   *   1. the voice stack's span flush timer;
   *   2. the goal runner — refuses new starts, aborts and awaits in-flight
   *      goal runs, which end `interrupted`;
   *   3. the mesh proxy reconciler;
   *   4. the background executor — stops claiming, hands its queued rows back
   *      (`JobStore.releaseQueued`), aborts active runs and awaits their unwind;
   *   5. jobs.db;
   *   6. the per-personality memory backends the loop built, then the
   *      request-dump store, then the primary memory backend (each closed
   *      only when it holds a connection);
   *   7. the plugins (`deactivate` + registrations);
   *   8. the notify queue, the MCP clients, goals.db, the kanban store;
   *   9. the docker execution sessions;
   *  10. the three sessions.db connections (kv stores, context log, session
   *      store), then the execution backends.
   * Every step is attempted even when one throws; failures reject together as
   * one `AggregateError`. Idempotent — a second call returns the first promise.
   *
   * The host stops feeding the loop first (close the HTTP server, stop the
   * adapters, drain the gateway) and disposes any surface that borrowed from
   * it (`CreateWebApiResult.dispose`) before calling this. Every handle on
   * this result is dead afterwards.
   *
   * NOT covered: the process-global browser session sweeper
   * (`@ethosagent/tools-browser/compose` — shared by every loop in the
   * process, so no one loop may stop it). Pinned by
   * packages/wiring/src/__tests__/runtime-dispose.test.ts.
   */
  dispose: () => Promise<void>;
  /**
   * F06 — for a loop that has been REPLACED while its process lives on (the
   * chat `/model` switch): stop taking new background work (queued rows go to
   * the successor, `BackgroundExecutor.drain`) and resolve once no background
   * job and no goal run is still running on this loop (`GoalRunner.whenIdle`).
   * Aborts nothing — call `dispose()` afterwards. A process stop skips this and
   * disposes directly. Unbounded by design: work in flight finishes on the loop
   * it started on. Pinned by packages/wiring/src/__tests__/runtime-dispose.test.ts.
   */
  drain: () => Promise<void>;
  /** Lane 3(b) — the served context window (tokens) of the primary provider.
   *  `ethos bench context` uses it as the schema-budget denominator so the
   *  bench table and the startup warning read the same numbers (D8). */
  contextWindow: number;
  /**
   * The smart approver's decision site (plan decision-provider-jev §8.2),
   * carrying THIS build's one lazy decision-provider handle so the approver
   * and the injection classifier share a breaker. Present whenever
   * `decisions.provider` is configured; the site's mode is resolved per call
   * from the turn's personality (plan decision-provider-personality §7.3), so
   * a personality that enables no approver site gets exactly the LLM reviewer.
   * Hosts forward it as `decision` to `createApprovalDangerPredicate`; absent,
   * the approver is exactly the LLM reviewer.
   */
  approverDecision?: import('./smart-approver').SmartApproverDecisionSite;
  /**
   * The execution posture a personality's turns resolve to in THIS build —
   * the same resolution its exec tools run under (`ExecutionRouting.resolvePosture`,
   * packages/wiring/src/compose-tools.ts). `undefined` id → the deployment
   * default; an unknown id → `undefined`. Hosts forward it as
   * `executionPostureFor` to `createApprovalDangerPredicate`, which flags the
   * shell tools under a host-local posture (S6 / D1(a)).
   */
  executionPostureFor: (personalityId: string | undefined) => ExecutionPosture | undefined;
  /** The McpManager instance from tool composition. Pass to createWebApi so
   *  re-auth via the web UI hits the live manager and updates the tool registry. */
  mcpManager: McpManager;
  /**
   * THIS loop's execution-backend registry (`buildInfrastructure`). Exposed so a
   * composition root that also hosts the web API can hand web-api's
   * `ExecutionService` the registry the TOOLS run on — `resolve()` memoises, so
   * `get('ssh')` there is literally the instance `compose-tools` resolved, and
   * the Settings probe tests the object that executes rather than a look-alike
   * built for the occasion. Without it the probe answers `backend_unresolved`.
   */
  executionBackends: ExecutionBackendRegistry;
  /** The SkillsInjector from tool composition — the single eligibility decision
   *  ("which skills does personality P see"). Pass to createWebApi so read-only
   *  surfaces derive from THIS instance rather than building a second injector
   *  with its own scanner + mtime cache. Note it closes over the LOOP's
   *  personality registry, not the web-api's; refresh via `refreshPersonalities`. */
  skillsInjector: import('@ethosagent/skills').SkillsInjector;
  /** Replace the messaging tool's send implementation with the real gateway.
   *  Called from gateway.ts after Gateway construction. Scoped to this loop
   *  instance — multiple loops in the same process are independent. */
  setMessagingSend: (fn: MessagingSendFn) => void;
  /** Set by the web-api chat service to receive SSE notifications when the
   *  improvement fork submits a skill candidate to the learning inbox. The id
   *  passed is the inbox candidate id. There is no "applied" counterpart: the
   *  fork never promotes (L-T6); promotion happens after a replay or a human. */
  setOnSkillProposed?: (fn: (skillId: string, personalityId: string) => void) => void;
  /**
   * Subscribe to proactive-capture notices (memory-experience §3.3). Present
   * only when `memoryCapture.enabled`. CLI chat subscribes to print one dim
   * "· remembered: …" line; channel adapters do not subscribe. Returns an
   * unsubscribe fn.
   */
  onMemoryCaptured?: (
    cb: (n: { sessionId: string; scopeId: string; summary: string }) => void,
  ) => () => void;
  /**
   * Directly and deterministically runs the call-capture pipeline for the
   * given personality — no LLM turn, no tool registry involved. Present only
   * when call capture is enabled (`isCallCaptureToolsEnabled`). Bound in
   * `build-agent-loop.ts`, closing over the constructed TapCapture/MicCapture/
   * STT/memory dependencies. `apps/ethos/src/commands/serve.ts` wires this
   * directly into `CallCaptureDaemon`'s `runCapture` option.
   */
  runCallCapture?: (
    personalityId: string,
    opts: {
      source?: string;
      abortSignal: AbortSignal;
      /**
       * Live per-entry callback (plan/phases/call-capture-desktop-ux.md,
       * P3) — forwarded straight through to `RunCallCaptureInput.onEntry`.
       * Absent for every caller except the desktop app's pill popover.
       */
      onEntry?: (entry: import('@ethosagent/platform-callcapture').TranscriptEntry) => void;
      /**
       * Live per-chunk audio-level callback (much higher frequency than
       * `onEntry`) — forwarded straight through to
       * `RunCallCaptureInput.onAudioLevel`. Absent for every caller except
       * the level-meter UI consuming it via `CallCaptureIndicatorPort`.
       */
      onAudioLevel?: (
        speaker: import('@ethosagent/platform-callcapture').Speaker,
        level: number,
        at: number,
      ) => void;
    },
  ) => Promise<import('@ethosagent/tools-callcapture').CallCaptureResult>;
  /** v2.2 — Notification router for registering per-session adapters.
   *  CLI/TUI/web-api register a NotificationAdapter on this router so plugin
   *  monitors can deliver messages to the active surface. */
  notificationRouter: import('@ethosagent/types').NotificationRouter;
  /** v2.2 — Plugin loader instance for health checks and diagnostics. */
  pluginLoader: PluginLoader;
  /** The goal backend, always present: the one goals.db store (compose-tools'
   *  `goalStore`, the instance the goal_* tools write) and the loop-bearing
   *  runner that executes goals from it, paired in buildAgentLoop. Hosts forward
   *  the pair to web-api's GoalsService as is, so no surface opens a second
   *  store or runs a loop-less runner. Borrowers do not dispose it. */
  goals: { store: GoalStore; executor: GoalRunner };
  /** The host-side memory surfaces (editor, Timeline, restore, approve queue)
   *  for THIS loop's configured backend — built in buildAgentLoop from the same
   *  `config` its memory registry resolves, so a web edit lands where the agent
   *  reads (F04). Hosts forward it to `createWebApi` as is. */
  memoryBundle: MemoryBundle;
  /** Durable background-job store — present only when the background subsystem is
   *  enabled for this loop. Shared with the gateway/Tasks surface. */
  jobStore?: import('@ethosagent/types').JobStore;
  /** Detached background executor — present only when enabled. Hosts register
   *  completion handlers on it; `dispose()` shuts it down. */
  backgroundExecutor?: import('@ethosagent/job-runner').BackgroundExecutor;
  /** Resolved job runners — present only when the background subsystem is enabled.
   *  The web-api Tasks detail RPC asks the runner that executed a row for its own
   *  detail-grid rows (pi-delegation D18). */
  jobRunners?: import('@ethosagent/types').JobRunnerRegistry;
  /** Mesh proxy reconciler — present only when the background subsystem is enabled.
   *  Polls mesh peers for jobs spawned via route_to_agent(background:true). Its
   *  timer is unref'd; `dispose()` stops it. */
  meshProxyReconciler?: import('@ethosagent/tools-delegation').MeshProxyReconciler;
  /** The resolved active personality for this loop. Exposed so gateway.ts can
   *  read the plugins allowlist without duplicating the personality load. */
  activePersonality: import('@ethosagent/types').PersonalityConfig;
  /**
   * THIS loop's personality registry — the one `refreshPersonalities()`
   * reloads and the one every injector and tool closed over.
   *
   * Exposed so a host that must re-read a declaration between turns (the MCP
   * export server re-resolves `mcp_export` on every call, M-D13) reads the
   * registry the turn will actually run against. An app constructing its own
   * `FilePersonalityRegistry` would get a second mtime cache and a second
   * answer; there is one registry per loop, and this is it. Borrowers do not
   * dispose it.
   */
  personalities: import('@ethosagent/personalities/compose').PersonalityCompose['personalities'];
  /** Re-load this loop's personality registry from `~/.ethos/personalities/`.
   *  Cheap when nothing changed (mtime-fingerprint cache → ~4 stat() calls per
   *  dir). Callers refresh before resolving a personality so a newly dropped or
   *  edited directory is picked up without a restart. */
  refreshPersonalities: () => Promise<void>;
  /** STT provider registry — threaded to Gateway for voice transcription. */
  sttProviders: import('@ethosagent/types').SttProviderRegistry;
  /** TTS provider registry — threaded to Gateway for voice synthesis. */
  ttsProviders: import('@ethosagent/types').TtsProviderRegistry;
  /**
   * Realtime (speech-to-speech) provider registry — threaded to web-api so the
   * browser talk lane can mint an ephemeral token on the realtime tier.
   */
  realtimeProviders: import('@ethosagent/types').RealtimeVoiceProviderRegistry;
  /**
   * Real-time voice stack built from `config.voice.*`. Absent when no voice
   * block is configured — the clean no-op every non-voice deployment takes.
   */
  voiceStack?: import('./voice-stack').VoiceStack;
  /** Voice provider config from auxiliary.asr / auxiliary.tts in config. */
  voiceConfig: {
    sttProviderName?: string;
    sttProviderConfig: Record<string, unknown>;
    ttsProviderName?: string;
    ttsProviderConfig: Record<string, unknown>;
    /**
     * Named TTS roster from `voice.tts.providers.*`, keyed by the operator's
     * label. A personality's `voice.tts_provider` names one of these; anything
     * else (and anything unknown) falls back to the `auxiliary.tts` default.
     */
    ttsRoster?: Record<string, import('@ethosagent/types').TtsProviderEntry>;
    /**
     * Named STT roster from `voice.stt.providers.*`. The exact mirror:
     * `voice.stt_provider` names one, anything unknown falls back to the
     * `auxiliary.asr` default.
     */
    sttRoster?: Record<string, import('@ethosagent/types').SttProviderEntry>;
    /**
     * Named REALTIME roster from `voice.realtime.providers.*`. Unlike the other
     * two this roster has no `auxiliary.*` default underneath it:
     * `realtimeDefault` NAMES one of these entries, and a deployment with
     * neither simply has no realtime tier.
     */
    realtimeRoster?: Record<string, import('@ethosagent/types').RealtimeProviderEntry>;
    /** `voice.realtime.default` — the roster key a personality that names none gets. */
    realtimeDefault?: string;
    /** `voice.tier` — the deployment's default voice engine. */
    tier?: 'pipeline' | 'realtime';
    /**
     * `voice.realtime.sessionBudgetUsd` — USD cap on ONE realtime call.
     *
     * Forwarded for the same reason `tier` is. Without it the only route from
     * the parsed config to the surface that enforces the cap was web-api's
     * OPTIONAL live-config read, so a surface built without that read was
     * silently uncapped — and a cap that silently does not apply is worse than
     * no cap, because the deployment believes it has one.
     */
    realtimeSessionBudgetUsd?: number;
    secretsResolver: import('@ethosagent/types').SecretsResolver;
    /**
     * Local-only voice-egress allowlist from `voice.trustedPlugins`. Present
     * only when the operator declared the key; surfaces pass it straight
     * through so a non-local provider selection is refused with a typed error
     * instead of quietly shipping audio off the machine.
     */
    trustedVoicePlugins?: ReadonlySet<string>;
  };
}

export async function createAgentLoop(
  config: WiringConfig,
  rawOpts: CreateAgentLoopOptions,
): Promise<CreateAgentLoopResult> {
  // L-T3 — a replay must never feed learning. That is exactly what
  // `disablePostTurnLearning` already means (M-D6), so a replay IS that flag
  // rather than a second gate beside it: the two places that read it
  // (`ImprovementFork.register`, `MemoryCaptureRunner.registerHook`, both in
  // `build-agent-loop.ts`) stay untouched, and `__tests__/post-turn-learning.test.ts`
  // keeps guarding them.
  const opts: CreateAgentLoopOptions = rawOpts.replay
    ? { ...rawOpts, disablePostTurnLearning: true }
    : rawOpts;
  const { wiringCtx, profile, log } = buildWiringContext(opts);
  // F06 — ONE stack for the whole assembly. Every stage pushes the release of
  // each resource it opens right after opening it, so a stage that throws
  // leaves the stack holding exactly what the earlier stages built — released
  // here before the error propagates — and a finished boot hands the same
  // stack back as `CreateAgentLoopResult.dispose`. Pinned by
  // packages/wiring/src/__tests__/runtime-dispose.test.ts.
  const disposers = new DisposerStack();
  try {
    return await assembleAgentLoop(wiringCtx, config, opts, profile, log, disposers);
  } catch (err) {
    await disposers.dispose().catch((rollbackErr: unknown) => {
      log.warn(
        `createAgentLoop: releasing a failed boot's resources also failed: ${
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        }`,
      );
    });
    throw err;
  }
}

async function assembleAgentLoop(
  wiringCtx: WiringContext,
  config: WiringConfig,
  opts: CreateAgentLoopOptions,
  profile: WiringProfile,
  log: Logger,
  disposers: DisposerStack,
): Promise<CreateAgentLoopResult> {
  // -------------------------------------------------------------------------
  // Infrastructure: registries, personalities, sandbox, hooks, session,
  // capability backends, tool registry, clarify bridge
  // -------------------------------------------------------------------------

  const infra = await buildInfrastructure(wiringCtx, config, opts, disposers);

  // -------------------------------------------------------------------------
  // Tool composition: all tool groups, hooks, skills, MCP, design tools,
  // guard hooks, team memory.
  // -------------------------------------------------------------------------

  const toolsResult = await composeAllTools(wiringCtx, config, opts, {
    infra,
    profile,
    disposers,
    // The approval outbox (O-T3/O-T4, plan/phases/trust-before-reach.md).
    // Absent for every surface with no path to a channel — CLI chat, one-shot
    // runs, the desktop app, tests — and `send_message` behaves exactly as it
    // did before Part 2 (there, the "Gateway not active" error). `ethos
    // gateway`, `ethos boot` and `ethos serve` supply one, which is what makes
    // `outbound_policy.approve_before_send` a gate rather than a doc comment.
    ...(opts.outbox ? { outbox: opts.outbox } : {}),
  });
  const { skillPool, injectors, skillScanner } = toolsResult;

  // -------------------------------------------------------------------------
  // Plugin loading: context engines + plugin registries + plugin loader
  // -------------------------------------------------------------------------

  const pluginsResult = await loadPlugins(wiringCtx, config, opts, {
    tools: infra.tools,
    hooks: infra.hooks,
    injectors,
    personalities: infra.personalities,
    llmProviders: infra.llmProviders,
    memoryProviders: infra.memoryProviders,
    storageBackends: infra.storageBackends,
    executionBackends: infra.executionBackends,
    sttProviders: infra.sttProviders,
    ttsProviders: infra.ttsProviders,
    activePerson: infra.activePerson,
    skillScanner,
    skillPool,
    buildCompressionSummarizer: () =>
      config.auxiliaryCompression?.model
        ? buildCompressionSummarizer(infra.llmProviders, config, opts.observability, log, {
            // Lane 5(ii) — cache-first window resolution for the summarizer's
            // provider; never a forced live probe (not a diagnostic command).
            storage: wiringCtx.storage,
            dataDir: wiringCtx.dataDir,
          })
        : undefined,
    ...(opts.slashRegistry ? { slashRegistry: opts.slashRegistry } : {}),
    ...(opts.cliSubcommandRegistry ? { cliSubcommandRegistry: opts.cliSubcommandRegistry } : {}),
    disposers,
  });

  // -------------------------------------------------------------------------
  // Resolve LLM AFTER plugin loading so plugin-contributed providers are
  // available for config-level selection.
  // -------------------------------------------------------------------------

  const llm = await createLLMFromRegistry(
    infra.llmProviders,
    config,
    log,
    infra.activePerson.plugins,
    // Lane 0 — startup consults the probe cache (D3); command paths that must
    // show fresh numbers set probeWindowRefresh to force a live probe (D16).
    {
      storage: wiringCtx.storage,
      dataDir: wiringCtx.dataDir,
      ...(opts.probeWindowRefresh === true ? { forceRefresh: true } : {}),
    },
    // D17 — every chain failover lands in observability.db as `llm.failover`.
    opts.observability,
  );

  // -------------------------------------------------------------------------
  // Final assembly: memory, vision, improvement fork, safety, AgentLoop.
  // -------------------------------------------------------------------------

  return buildAgentLoop(wiringCtx, config, opts, {
    infra,
    toolsResult,
    pluginsResult,
    llm,
    profile,
    disposers,
  });
}

// ---------------------------------------------------------------------------
// Session / memory factories
// ---------------------------------------------------------------------------
// Apps that need a SessionStore or MemoryProvider before they build a full
// AgentLoop (e.g. the TUI session picker) ask wiring for one. Wiring keeps
// the choice of concrete backend; the app does not import session-sqlite or
// a memory backend directly. Memory is always opened for the CONFIGURED
// backend — `createMemoryProviderFromConfig` / `createMemoryBundle` below —
// never an assumed markdown root (F04).

export interface CreateSessionStoreOptions {
  /** Root data directory (typically `~/.ethos`). */
  dataDir: string;
  /**
   * `retention.*` slice from the app config. Only the post-prune maintenance
   * knobs are consumed here; the TTL strings belong to the observability prune
   * pass. Absent → no automatic vacuum, today's behavior.
   */
  retention?: Pick<RetentionConfig, 'vacuumAfterPrune' | 'minVacuumIntervalDays'>;
}

/** The caller opened it, so the caller closes it: `close()` releases the
 *  sessions.db connection (F06 — a host that restarts in-process must). */
export function createSessionStore(
  opts: CreateSessionStoreOptions,
): SessionStore & { close(): void } {
  return new SQLiteSessionStore(join(opts.dataDir, 'sessions.db'), {
    ...(opts.retention?.vacuumAfterPrune !== undefined
      ? { vacuumAfterPrune: opts.retention.vacuumAfterPrune }
      : {}),
    ...(opts.retention?.minVacuumIntervalDays !== undefined
      ? { minVacuumIntervalDays: opts.retention.minVacuumIntervalDays }
      : {}),
  });
}

export {
  isGated,
  type MemoryApprovalMode,
  type PendingEntry,
  type PendingGateObservability,
  PendingMemoryGate,
  PendingMemoryStore,
  type ProposeInput,
  TombstoneStore,
  withPendingGate,
} from '@ethosagent/memory-approval';
// Content-normalized fact hash — the tombstone key shared by capture dedup and
// the L4 `ethos memory retract` op, so a retracted fact is never re-proposed.
export { hashFact } from '@ethosagent/memory-capture';
export {
  type HistoryEntry,
  type HistoryReadFilter,
  type HistoryReadResult,
  type HistorySource,
  HistoryStore,
  withHistory,
} from '@ethosagent/memory-history';
// Shared archive-restore path (pillar C, §4.2) — re-exported so the web-api
// MemoryService can call the exact function the CLI `ethos memory restore`
// uses, without depending on `apps/ethos`.
export { type RestoreResult, restoreArchivedSlug } from '@ethosagent/nightly-loop';
// Backend-aware memory (memory-lifecycle vault gaps, F04). By convention, code
// outside a loop opens memory through these, so it acts on the configured
// backend. Nothing enforces that: `HistoryStore` / `TombstoneStore` stay
// exported above, and `@ethosagent/memory-markdown` is still importable — F04
// only removed wiring's own markdown-only factory (`createMemoryProvider`),
// the one path every surface used to take. `createMemoryProviderFromConfig` returns a
// history-decorated handle for the CONFIGURED backend (`memory: vault` → the
// vault; anything else → markdown at dataDir) plus the history store and
// sidecar root/storage out-of-loop writers (nightly) need;
// `fileMemoryUnsupportedReason` says when a backend has no file surface to
// edit (vector); `createPendingMemoryStore` assembles the approve queue (CLI
// `ethos memory pending`); `createMemoryBundle` is the host-side editor/
// Timeline/restore/approve set a loop hands its web API
// (`CreateAgentLoopResult.memoryBundle`).
// Option/branch types stay module-local until something outside wiring needs
// them: `MemoryBundle` carries `editing` structurally, and every caller passes
// its options inline.
export {
  type ConfiguredMemoryBackend,
  type CreateMemoryProviderFromConfigOptions,
  createMemoryBundle,
  createMemoryProviderFromConfig,
  createPendingMemoryStore,
  createTeamMemoryProvider,
  fileMemoryUnsupportedReason,
  type MemoryBackendSelection,
  type MemoryBundle,
} from './memory-backend';

// ---------------------------------------------------------------------------
// Danger predicate (shared between CLI guard + web approval flow)
// ---------------------------------------------------------------------------

// The one session fork (plan openclaw-9.5-adoption D27), re-exported so app
// modules reach it through the composition layer (Law 5); it lives in core so
// the gateway extension, below wiring, can call it too.
export {
  type ForkSessionResult,
  forkSession,
  forkSessionKey,
  listBranches,
} from '@ethosagent/core';
export {
  type CreateApprovalDangerPredicateOptions,
  createApprovalDangerPredicate,
  createLazyProvider,
} from './approval-seams';
export {
  APPROVAL_SURFACE_ALWAYS_ASK,
  type CreateDangerPredicateOptions,
  canonicalizeArgs,
  createDangerPredicate,
  type DangerPredicate,
  type DangerReason,
  hardlineReason,
  LOCAL_POSTURE_CONSEQUENTIAL_TOOLS,
  SMART_MODE_CONSEQUENTIAL_TOOLS,
  type SmartApprovalCallback,
  type SmartVerdict,
} from './danger-predicate';
// The questions and digest each decision site sends — exported so a
// calibration run (`runDecisionCalibration`, @ethosagent/eval-harness) measures
// against exactly what the live sites ask.
export {
  APPROVER_CHOICES,
  APPROVER_QUESTIONS,
  type ApproverChoice,
  type ApproverDigestInput,
  approverDigest,
  DECISION_QUESTION_IDS,
  INJECTION_QUESTIONS,
  ROUTER_CHOICES,
  ROUTER_QUESTIONS,
  type RouterChoice,
} from './decision-questions';
// The Settings Test button's one decision call — a fresh provider, the
// injection question, redacted state (./decision-test). Apps reach the provider
// extension only through here (Law 5).
export {
  type DecisionTestOutcome,
  type TestDecisionProviderOptions,
  testDecisionProvider,
} from './decision-test';
export type { ModelSource, ModelTarget, ResolveModelInput } from './model-resolver';
// Re-export the resolver so callers don't need a separate import.
export { resolveModelTarget } from './model-resolver';
// The on-demand model test (T1.23/T1.24/T2.8) — one probe behind the CLI's
// `ethos models test` and the `modelRegistry.test` / `testAll` RPCs.
export {
  findProviderEntry,
  MODEL_TEST_TIMEOUT_MS,
  MODEL_TEST_WINDOW_MS,
  type ModelTestAnyRequest,
  type ModelTestOutcome,
  type ModelTestProbe,
  ModelTestRateLimiter,
  type ModelTestRequest,
  type ModelTestTarget,
  modelTestRateLimiter,
  type ProviderCredentialStatus,
  type ProviderEntryRef,
  type ProviderTestRequest,
  providerCredentialStatus,
  providerEntries,
  providerEntryProbes,
  testModel,
  testModelAlias,
  testProviderEntry,
} from './model-test';
// Shared live provider-credential probe (W2.2 / W2.4) with W1.2 liveness
// classification — used by the readline fallback, TUI AuthStep, and --from-env.
export {
  classifyProbeError,
  type ProbeProviderConfig,
  type ProbeProviderOutcome,
  probeProvider,
} from './probe-provider';
export {
  type CreateSmartApproverOptions,
  createSmartApprover,
  type SmartApproverDecisionSite,
} from './smart-approver';
export {
  farEndRefusalReason,
  SPOKEN_CONFIRMATION_TOOLS,
  type SpokenConfirmationOptions,
  type SpokenConfirmationRecord,
  spokenConfirmationReason,
  withSpokenConfirmation,
} from './spoken-confirmation';

// ---------------------------------------------------------------------------
// Real-time voice stack (config.voice.* → VoiceSession / transports)
// ---------------------------------------------------------------------------

export {
  createFarEndConsultTool,
  FAR_END_VOICE_ORIGIN,
  type FarEndConsultOptions,
} from './far-end-consult';
export { createBuiltinVoiceRegistries } from './voice-registries';
export {
  type BuildVoiceStackDeps,
  buildVoiceStack,
  type CreateVoiceAdapterOptions,
  type CreateVoiceSessionOptions,
  createObservabilitySpanSink,
  type LiveKitBindings,
  resolveSipTrunkClient,
  type VoiceInboundGates,
  type VoiceStack,
} from './voice-stack';

// ---------------------------------------------------------------------------
// Ethos observability adapter
// ---------------------------------------------------------------------------

// `## Decisions` on the character sheet and the per-personality lines of
// `ethos doctor` (plan decision-provider-personality §4.5, §8).
export { resolveCharacterSheetDecisions } from './decision-diagnostics';
export { IdentityMap, type IdentityMapEntry, type IdentityMapOptions } from './identity-map';
export {
  ETHOS_EVENT_CATEGORIES,
  ETHOS_TRACE_KINDS,
  type EthosEventCategory,
  EthosObservability,
  type EthosTraceKind,
} from './observability/ethos-observability';
export {
  FUNNEL_STATE_FILE,
  type FunnelObservability,
  type FunnelState,
  FunnelTracker,
  type FunnelTrackerOptions,
  type FunnelWizardPath,
  mergeFunnelState,
  readFunnelState,
} from './observability/funnel';
export { resolveExecutionBackendName } from './resolve-execution-backend';
export {
  type BuildExecutionPostureInput,
  buildExecutionPosture,
  type ContainerizedDetection,
  type ContainerizedDetectionInput,
  type ContainerizedSignal,
  constitutionForbidsLocal,
  detectContainerized,
  formatSshTarget,
  hasExecTool,
  isExecTool,
  type ResolveExecutionPostureInput,
  resolveExecutionPosture,
} from './resolve-execution-posture';
export { resolveActiveLlmName, resolveCharacterSheetRouting } from './tier-diagnostics';

// ---------------------------------------------------------------------------
// OAuth service factory
// ---------------------------------------------------------------------------

export { createOAuthService } from './oauth-factory';

// ---------------------------------------------------------------------------
// Security kernel — passthrough for apps (ARCHITECTURE.md §II, §III Law 5)
//
// The list lives in ./security-kernel so a lazily-loaded CLI command can import
// it WITHOUT the composition root's import graph (a barrel import costs ~7s and
// loads every extension). Re-exported here so surfaces already on the barrel —
// gateway, serve — keep one import.
// ---------------------------------------------------------------------------

export * from './security-kernel';

// ---------------------------------------------------------------------------
// Backup / restore (plan agent-state-backup, T2)
// ---------------------------------------------------------------------------
//
// The archive format, the scope table and the create/restore pair. Re-exported
// on the barrel so the CLI shims, the scheduled task and the web RPC all reach
// one implementation.

export * from './backup';

// ---------------------------------------------------------------------------
// Scheduled backup + system cron job reconciliation (plan agent-state-backup, T4)
// ---------------------------------------------------------------------------

export * from './backup-schedule';
// The approval outbox's app-layer seam. `apps/ethos` builds one of these and
// passes it as `CreateAgentLoopOptions.outbox`; `createOutboxGate` combines it
// with the personality's `outbound_policy` to produce the gate the two
// publishing tools see. `createOutboundPolicyGate` is its policy half alone —
// what an app root hands a `WatcherManager` at construction.
export { createOutboundPolicyGate, createOutboxGate, type OutboxWiring } from './compose-tools';
// The gateway singleton lock (plan reach-and-containment §2.7) — taken by
// `ethos gateway start`, read by `ethos gateway status`.
export * from './gateway-lock';
export * from './system-jobs';
