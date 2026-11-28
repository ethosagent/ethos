import type { ChannelFilterConfig } from '@ethosagent/safety-channel';
import type {
  LogLevel,
  ModelProfile,
  ModelRegistry,
  RealtimeProviderEntry,
  RetentionConfig,
  SttProviderEntry,
  TtsProviderEntry,
} from '@ethosagent/types';
import type { ChannelsPlatformConfig } from './builders/channels';
import type { BackgroundConfig, CronTopLevelConfig } from './builders/cron-background';
import type {
  MemoryApprovalConfig,
  MemoryCaptureConfig,
  MemoryConsolidationConfig,
  MemoryVaultConfig,
} from './builders/memory';
import type {
  SlackAppConfig,
  TeamRuntimeConfig,
  TelegramBotConfig,
  WhatsAppConfig,
} from './builders/platforms';
import type { PluginIsolationConfig, ToolLoadingMode } from './builders/tools';
import type { WebhookHookConfig } from './builders/webhooks';
import type { DecisionsConfig } from './decisions';
import type { ActiveContext, ToolSettingsMap } from './keys';
import type { NotificationsConfig } from './notifications';
import type { ProviderConfig } from './provider-chain';
import type {
  AuxiliaryCompressionConfig,
  AuxiliaryVisionConfig,
  AuxiliaryWebConfig,
  AwsConfig,
  IdleWatcherConfig,
  ModelCatalogConfig,
  NodesConfig,
  QuickCommandConfig,
  TelemetryConfig,
  WebConfig,
} from './section-types';
import type {
  VoiceBargeInConfig,
  VoiceBotConfig,
  VoiceFillerConfig,
  VoiceInboundConfig,
  VoiceLiveKitConfig,
  VoiceTrunkConfig,
  WakeRouteConfig,
} from './voice';

export interface EthosConfig {
  /**
   * On-disk schema version. Optional for backward compatibility — pre-
   * versioned configs are accepted as `1` with a deprecation warning.
   * Always written by `writeConfig` going forward.
   */
  schemaVersion?: number;
  provider: string;
  model: string;
  apiKey: string;
  personality: string;
  /** Memory backend: 'markdown' (default), 'vector' (semantic retrieval), or 'vault' (bring-your-own external directory) */
  memory?: 'markdown' | 'vector' | 'vault';
  /**
   * Per-key ceilings, in characters, for the markdown memory backend. A write
   * past the ceiling keeps the newest content and archives the trimmed prefix
   * into `memory-archive.md`. Both default to 524288 (512K). Named
   * `memoryCharLimits` on the type because `memory` is already the backend
   * selector; the flat config keys keep the block shape:
   *   memory.charLimits.memory: 524288
   *   memory.charLimits.user: 262144
   */
  memoryCharLimits?: { memory?: number; user?: number };
  /**
   * Execution-backend configuration, forwarded to `ExecutionBackendConfig`.
   *
   * `docker` — resource caps. `cpu` is the docker `--cpus` quota (default 2);
   * `diskMb` is a best-effort `--storage-opt size=<N>m` quota honoured only
   * where the daemon's storage driver and backing filesystem can enforce it
   * (the backend warns and skips otherwise). Flat keys:
   *   execution.docker.cpu: 4
   *   execution.docker.diskMb: 20480
   *
   * `docker.image` is the ONE image every docker-posture exec tool runs in
   * (`terminal`, `run_code`, `run_tests`, `lint`, `process_*`), threaded into
   * `ExecutionBackendConfig.images.default` by `createExecutionRouting`
   * (packages/wiring/src/compose-tools.ts). It must be digest-pinned —
   * `<repo>@sha256:<64 hex>`, checked by {@link dockerImageRefError}; an
   * unpinned value is a parse WARNING and is dropped, never a boot failure,
   * so the backend then refuses with `MissingDockerImageError`
   * (extensions/execution-docker) instead of running an unpinned image:
   *   execution.docker.image: node@sha256:<digest>
   *
   * `ssh` — the ONE remote target this deployment executes on. There is no
   * roster and no per-personality target: a personality declares the posture,
   * the operator declares the machine. Presence of `host` is the switch (the
   * same posture as `background.pi.image`): without it there is nothing to
   * connect to, so the block is absent and a personality asking for ssh falls
   * back honestly. Flat keys:
   *   execution.ssh.host: build-01.internal
   *   execution.ssh.user: deploy
   *   execution.ssh.port: 2222
   *   execution.ssh.identityFile: ~/.ssh/id_ed25519
   *   execution.ssh.knownHostsFile: ~/.ssh/known_hosts_ethos
   *   execution.ssh.strictHostKeys: accept-new
   *   execution.ssh.remoteWorkdir: /srv/work
   *
   * `allowLocalFallback` — the operator's opt-in to run exec-bearing
   * personalities UN-SANDBOXED on the host when this process cannot build a
   * Docker backend at all (the desktop in-process backend). Unset, that
   * docker→local downgrade is refused and exec tools answer `not_available`
   * (`resolveExecutionPosture`, packages/wiring/src/resolve-execution-posture.ts;
   * S6 / D3, plan openclaw-2026.9.6-gaps). Only the literal `true` opts in:
   *   execution.allowLocalFallback: true
   *
   * `containerized` — the operator's statement that Ethos itself runs inside a
   * container that auto-detection (`/.dockerenv`, `/proc/1/cgroup`,
   * `KUBERNETES_SERVICE_HOST`) cannot see, so that container is already the
   * isolation boundary and exec personalities run `local` in it. It is
   * `detectContainerized`'s explicit config signal
   * (packages/wiring/src/resolve-execution-posture.ts), forwarded by the
   * compose path (`createExecutionRouting`'s `containerizedConfig`). Only the
   * literal `true` sets it; the env equivalent is `ETHOS_EXECUTION_BACKEND=local`:
   *   execution.containerized: true
   */
  execution?: {
    allowLocalFallback?: boolean;
    containerized?: boolean;
    docker?: { cpu?: number; diskMb?: number; image?: string };
    ssh?: {
      /** Hostname or IP of the remote target. Non-empty; its presence is the switch. */
      host: string;
      /**
       * Remote login user. Absent means ssh's own resolution — the local
       * username, or whatever `~/.ssh/config` matches for this host.
       */
      user?: string;
      /** Remote sshd port, 1-65535. Absent means ssh's default of 22. */
      port?: number;
      /**
       * Private key path passed as `ssh -i`. A PATH, never key material: absent
       * means ssh-agent or ssh's own default key search.
       */
      identityFile?: string;
      /**
       * Passed as `-o UserKnownHostsFile=`. Absent means ssh's own
       * `~/.ssh/known_hosts`. A destination that cannot PERSIST a learned key
       * (`none`, a null device) is rejected: it would switch off the pinning
       * `strictHostKeys` exists to enforce. See {@link sshKnownHostsError}.
       */
      knownHostsFile?: string;
      /**
       * Passed VERBATIM as ssh's `-o StrictHostKeyChecking=<value>`, so the
       * consumer has nothing to map. Only the two safe values are accepted:
       * `'accept-new'` (trust on first connection, then pin) and `'yes'` (the
       * host key must already be in the known-hosts file). `'no'` is
       * deliberately not accepted — it disables host-key verification
       * altogether, and this surface will not spell that. A literal string
       * rather than a boolean because `false` would have to mean one of
       * `'accept-new'` or `'no'`, and those two differ by exactly the
       * man-in-the-middle guarantee.
       */
      strictHostKeys?: 'accept-new' | 'yes';
      /**
       * The working directory ON THE REMOTE HOST. The host's own working
       * directory is never sent to the remote.
       *
       * ABSENT MEANS THE REMOTE LOGIN DIRECTORY — the backend does not `cd` at
       * all. It is not the local cwd, and it is not `/`. Set this only when
       * commands must run somewhere other than where the ssh login lands.
       */
      remoteWorkdir?: string;
    };
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
   * Lane 0 (eng review D4) — operator override for the model's served context
   * window, in tokens. A window FACT (how many tokens the server accepts) —
   * not a compaction POLICY (`compaction.maxContextTokens` is the ceiling
   * compaction aims for, different semantics) — hence the name matches the
   * catalog's `contextWindow` field rather than the provider-internal
   * `maxContextTokens` it maps to. Wins over the window probe and the catalog
   * (precedence: config > probe > catalog > default). Flat-key shape:
   *   contextWindow: 8192
   */
  contextWindow?: number;
  /**
   * Lane 2a (eng review D6) — tool-definition ordering at the provider
   * serialization boundary. `'stable'` (the default) applies the
   * deterministic ASCII sort so the tool payload — part of the cacheable
   * request prefix — is byte-identical across restarts; `'insertion'`
   * restores the legacy registration-order bytes. Temporary rollback lever;
   * removal tracked in plan/uncompleted-tasks.md (D13). Flat-key shape:
   *   toolOrder: insertion
   */
  toolOrder?: 'insertion' | 'stable';
  /**
   * Lane 4a(d) — per-request deadline for the OpenAI-compat AND Anthropic
   * clients, in milliseconds. Absent → `DEFAULT_LLM_REQUEST_TIMEOUT_MS` from
   * `@ethosagent/types` (20 minutes), which both providers apply in place of
   * their SDK's own 10-minute default. The default is deliberately LONG: a cold
   * local model load (Ollama paging weights into RAM/VRAM on the first turn)
   * legitimately takes minutes, and a short default would break every fresh
   * server start. Set this only when you know your serving latency.
   *
   * Note what it bounds: both SDKs clear the timer once response HEADERS
   * arrive, so on a streaming request this is a time-to-first-headers deadline.
   * Stream duration is bounded by the loop's streaming watchdog
   * (`DEFAULT_STREAMING_TIMEOUT_MS`) instead. Flat-key shape:
   *   requestTimeoutMs: 120000
   *
   * `0` is NOT accepted here — the parser below requires a positive integer, so
   * `requestTimeoutMs: 0` is dropped as a typo and the default applies. The
   * providers themselves would honour `0` as "no deadline" if it reached them.
   */
  requestTimeoutMs?: number;
  /**
   * Operator-tunable approval SLA, in milliseconds — how long a dangerous
   * tool call may sit waiting for a human Allow/Deny before it is
   * auto-denied. Absent → each approval store's own 10-minute default
   * (gateway `ApprovalCoordinator`, web-api `ApprovalsService`). `0` means
   * no timeout at all — the call waits forever. Flat-key shape:
   *   approvalTimeoutMs: 1800000
   */
  approvalTimeoutMs?: number;
  /**
   * Operator opt-in for unattended dangerous tools on the gateway systemLoop
   * (cron, dreams, watcher wakes, SIP-inbound). No human is present there, so
   * a call that would need approval is refused by the unattended gate
   * (`wireUnattendedApprovalGate`, apps/ethos/src/unattended-approval-gate.ts).
   * With this set to `true`, a personality that declares
   * `safety.approvalMode: off` has its flagged calls auto-approved on that
   * loop instead. Deny rules and hardline commands still refuse. Only the
   * literal `true` enables it. Flat-key shape:
   *   allowUnattendedDangerousTools: true
   */
  allowUnattendedDangerousTools?: boolean;
  /**
   * Lane 4a(d) — SDK retry count for every SDK-backed provider (OpenAI-compat,
   * Azure, Anthropic; codex/gemini/bedrock/xai do not retry). Absent → the SDK
   * default (2 retries) for a single provider, and `0` for each hop of a
   * provider chain, where failover + cooldown is the retry policy
   * (`createLLMFromRegistry` in packages/wiring/src/index.ts). Set explicitly,
   * it applies to chain hops too. Flat-key shape:
   *   maxRetries: 0
   */
  maxRetries?: number;
  /**
   * Lane 3(a) — total serialized tool-payload guard threshold, in chars.
   * Absent → the wiring default (128 KiB). Exceeding it fails startup on a
   * local dialect and warns on hosted ones, naming the offending tools.
   * Flat-key shape:
   *   toolPayloadLimitChars: 131072
   */
  toolPayloadLimitChars?: number;
  /**
   * reach-and-containment Part 1 — on-demand tool loading (`tool_search`).
   * `auto` (the default when absent) engages it only for a personality whose
   * tool schemas exceed the schema-budget share of the served window — the
   * same verdict that already warns (`evaluateToolSchemaBudget`); `on` always;
   * `off` never. Any other value is a parse error (`parseConfigYaml` →
   * `configParseNotices`), which the strict boot paths refuse. Flat-key shape:
   *   tool_loading: on
   */
  toolLoading?: ToolLoadingMode;
  // Per-personality model overrides: maps personality ID → model ID string
  modelRouting?: Record<string, string>;
  /**
   * Global FALLBACK layer for per-personality tool config. Keyed by
   * personality ID (or `_default`). The personality's own `tools.yaml` is the
   * source of truth; this map only fills the gap for personalities (especially
   * read-only built-ins) that don't declare a tool. Only secret NAMES live
   * here — never values (§V S9). `web_search` is the sole consumer in v1.
   */
  toolSettings?: ToolSettingsMap;
  /**
   * §7 — per-model config profile overrides, merged OVER the catalog profile
   * for the same `(providerId, modelId)`. Keyed by `<providerId>/<modelId>`
   * (the model id itself may contain `/`, e.g. `openrouter/anthropic/...`).
   * Flat-key config shape (the first path segment is the providerId, the rest
   * is the modelId):
   *   models.ollama/llama3.2.sampling.temperature: 0.2
   *   models.ollama/llama3.2.sampling.topP: 0.9
   *   models.ollama/llama3.2.sampling.topK: 40
   *   models.ollama/llama3.2.sampling.minP: 0.05
   *   models.ollama/llama3.2.toolCallFormat: openai
   *   models.ollama/llama3.2.maxOutputTokens: 2048
   */
  models?: Record<string, ModelProfile>;
  /**
   * §5 — global context-compaction gate thresholds, as fractions of the
   * model's window in (0,1]. `pressure` is the gate (compact above it);
   * `target` is what compaction shrinks toward. A per-model catalog `profile`'s
   * `compaction` overrides these; both absent → hardcoded 0.8/0.7 defaults.
   * Flat-key config shape:
   *   compaction.pressure: 0.85
   *   compaction.target: 0.7
   *   compaction.gateDelta: 2000
   *
   * Phase 1c — `gateDelta` is a token headroom (integer ≥ 0, NOT a fraction)
   * added to the previous turn's actual input tokens so the gate fires slightly
   * before the next turn reaches pressure.
   *
   * Phase 3 — `autoCompact` gates the turn-end auto-compaction trigger
   * (default on since the context-economy Phase 2 eval-gated flip; set false
   * to disable). `retryOnOverflow`
   * (default on) turns a provider context-overflow rejection into a
   * compact-and-retry instead of a surfaced error. Flat-key config shape:
   *   compaction.autoCompact: false
   *   compaction.retryOnOverflow: false
   *
   * Phase 4 — `smallWindow` overrides small-window-mode auto-detection. `auto`
   * (default) applies the window (≤32k) + static-ratio (>40%) triggers; `on`
   * forces small-window mode; `off` disables it. Flat-key config shape:
   *   compaction.smallWindow: on
   *
   * Item 7 — `maxContextTokens` is an ABSOLUTE ceiling in tokens (integer > 0):
   * compaction fires above it even when the fractional gate has not been
   * reached, so a million-token window need not grow to 800k first. It applies
   * to both the pre-LLM gate and the turn-end trigger.
   * `minTailUserMessages` (integer ≥ 0, default 3) is the number of USER
   * messages every compaction keeps verbatim in the tail — `tailKeep` counts
   * rows of any role, and a tool-heavy tail can hold none. Flat-key shape:
   *   compaction.maxContextTokens: 400000
   *   compaction.minTailUserMessages: 3
   * `abortOnSummaryFailure` (default false) surfaces a failed emergency
   * summary as its own `compaction_summary_failed` error instead of masking it
   * as the generic overflow rejection:
   *   compaction.abortOnSummaryFailure: true
   */
  // biome-ignore format: keep the option shape on one line for readability.
  compaction?: { pressure?: number; target?: number; gateDelta?: number; autoCompact?: boolean; retryOnOverflow?: boolean; abortOnSummaryFailure?: boolean; smallWindow?: 'auto' | 'on' | 'off'; maxContextTokens?: number; minTailUserMessages?: number };
  /**
   * Call-capture personality binding (plan/phases/call-capture-extension.md
   * decision 3). Exactly one personality, system-wide, may hold the
   * `call_capture` toolset capability (declared in its `toolset.yaml`, not a
   * `PersonalityConfig` field); this names which one is actually bound.
   * Validated at wiring time — see `validateCallCaptureBinding` in
   * `@ethosagent/wiring`, called from `packages/wiring/src/build-infrastructure.ts`.
   * Flat-key config shape:
   *   callCapture.personalityId: assistant
   */
  callCapture?: { personalityId?: string };
  /**
   * Fallback provider chain. When 2+ entries are present, `createLLM` wraps
   * them in a `ChainedProvider` with automatic cooldown-based failover.
   * The primary `provider`/`apiKey`/`model` fields are used when absent or
   * when only one entry is present. Config format:
   *   providers.0.provider: anthropic
   *   providers.0.apiKey: sk-ant-...
   *   providers.0.model: claude-opus-4-7
   *   providers.1.provider: openrouter
   *   providers.1.apiKey: sk-or-...
   */
  providers?: ProviderConfig[];
  /**
   * Active chat target. Managed by `ethos set` — do not hand-edit.
   * Takes precedence over `personality` for `ethos chat` and `ethos serve`.
   * @internal
   */
  activeContext?: ActiveContext;
  // Platform tokens — legacy scalar shape (single bot / single app). When
  // `telegram.bots` / `slack.apps` is present the list-shape wins and these
  // are ignored. Existing configs continue to boot unchanged via the
  // deprecation shim in `applyPlatformShim`.
  telegramToken?: string;
  discordToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  /**
   * Multi-bot routing: one bot entry per @handle. Serialized as dotted
   * indexed keys, matching `providers.<n>.<field>`. Identifiers (id,
   * bind.name) are restricted to `[A-Za-z0-9_-]+` so they round-trip
   * through the line-based config format unambiguously. Example:
   *   telegram.bots.0.token: 123:ABC
   *   telegram.bots.0.bind.type: personality
   *   telegram.bots.0.bind.name: researcher
   */
  telegram?: { bots: TelegramBotConfig[] };
  /**
   * Multi-app routing: one entry per Slack app. Same indexed-key shape
   * as `telegram.bots`. Identifier rules apply. Example:
   *   slack.apps.0.botToken: xoxb-…
   *   slack.apps.0.appToken: xapp-…
   *   slack.apps.0.signingSecret: …
   *   slack.apps.0.bind.type: personality
   *   slack.apps.0.bind.name: coder
   */
  slack?: { apps: SlackAppConfig[] };
  /**
   * Discord-adapter knobs that are not per-bot credentials: the mode every
   * channel starts in, and the missed-message backfill (the first time the
   * bot sees a channel it reads a slice of recent history so its first reply
   * is not context-blind).
   *
   * Config format:
   *   discord.defaultChannelMode: observe
   *   discord.missedMessageBackfill.enabled: false
   *   discord.missedMessageBackfill.windowSeconds: 3600
   *   discord.missedMessageBackfill.limit: 50
   */
  discord?: {
    /**
     * The mode every channel falls back to before any per-channel override.
     * Mirrors `extensions/platform-discord/src/config.ts`'s
     * `ChannelModeSchema` exactly — Discord, unlike Telegram, has no
     * `regex_match`. Absent leaves the adapter on its own `mention_only`.
     */
    defaultChannelMode?: 'mention_only' | 'thread_follow' | 'all' | 'observe';
    /**
     * Role ids allowed to click Approve / Deny on an approval card
     * (`discord.approvalRoleIds: 111,222`). Passed to
     * `DiscordAdapterConfig.approvalRoleIds` by `buildAdapters`
     * (apps/ethos/src/commands/gateway.ts). Absent leaves the adapter's
     * default `role_gate` with no roles, which refuses every click
     * (`DiscordAdapter.handleApprovalDecision`), so every Discord approval
     * waits out its timeout. Pinned by `__tests__/discord-approval-roles.test.ts`.
     */
    approvalRoleIds?: string[];
    /** `discord.replyPrefix` — see `TelegramBotConfig.replyPrefix`. */
    replyPrefix?: string;
    /** `discord.mentionByName` — see `TelegramBotConfig.mentionByName`. */
    mentionByName?: boolean;
    missedMessageBackfill?: {
      /** Read history at all. Default `true` — today's behaviour. */
      enabled?: boolean;
      /**
       * Drop fetched messages older than this many seconds. Absent = no age
       * bound, which is today's behaviour. 1–604800 (7 days).
       */
      windowSeconds?: number;
      /**
       * How many messages to ask Discord for. 1–100 (the platform's own
       * `messages.fetch` ceiling). Default 50.
       */
      limit?: number;
    };
  };
  /**
   * Discord "Thinking…" placeholder message posted while a turn runs.
   * Config key: `discord.post_thinking_placeholder`. Absent = undefined
   * (consumer default: on); `false` disables it. A flat top-level field —
   * the gateway half that reads it lands separately; this carries exactly
   * what the file says.
   */
  discordPostThinkingPlaceholder?: boolean;
  /** Per-team runtime knobs. Keyed by team manifest name (same identifier rules). */
  teams?: Record<string, TeamRuntimeConfig>;
  whatsapp?: WhatsAppConfig[];
  /**
   * Real-time voice bot routing (plan/phases/gap-voice-realtime.md §3(b)).
   * Same indexed-key shape as `telegram.bots`, but keyed on a room/number
   * `match` pattern instead of a token. Example:
   *   voice.bots.0.match: +15551234567
   *   voice.bots.0.bind.type: personality
   *   voice.bots.0.bind.name: receptionist
   * LiveKit transport keys live alongside the bots under `voice.livekit.*`;
   * SIP trunk keys (telephony) live under `voice.trunk.*`.
   *
   * `trustedPlugins` is the local-only voice-egress allowlist:
   *   voice.trustedPlugins: openai-tts, elevenlabs
   * Declaring the key AT ALL arms the gate — providers advertising
   * `caps.local` always pass, and every other provider must be named here or
   * its selection is refused before a single audio byte leaves the machine.
   * Absent (the default) leaves the gate off, which is why an empty list is a
   * meaningful value, not the same as omitting the key.
   *
   * `defaultMode` is the voice-reply mode a NEW channel lane starts in:
   *   voice.defaultMode: mirror_inbound
   * `off` never speaks back, `mirror_inbound` speaks when it was spoken to,
   * `all` speaks every reply. `/voice <mode>` overrides it per lane at runtime;
   * this is only where a lane starts. Absent = `mirror_inbound`.
   *
   * `tts.providers` / `stt.providers` are the named rosters — several
   * configured providers a personality can pick between by name
   * (`voice.tts_provider:` / `voice.stt_provider:` in its `config.yaml`). Three
   * dotted levels, each entry the same shape as `auxiliary.tts` / `auxiliary.asr`:
   *   voice.tts.providers.mac-say.provider: command-tts
   *   voice.tts.providers.mac-say.command: say -o {output_path} -f {input_path}
   *   voice.tts.providers.mac-say.outputFormat: wav
   *   voice.tts.providers.studio.provider: openai-tts
   *   voice.tts.providers.studio.apiKey: ${secrets:voice/tts/providers/studio/apiKey}
   *   voice.stt.providers.whisper-es.provider: local-stt
   *   voice.stt.providers.whisper-es.baseUrl: http://localhost:8000/v1
   * `auxiliary.tts` / `auxiliary.asr` remain the DEFAULT entries: a personality
   * that names no provider — or names one this machine does not have — uses
   * them, so a deployment with no roster is unchanged. Names are restricted to
   * `[A-Za-z0-9_-]+` so they round-trip through the line-based format.
   *
   * `voice.providers.<name>.*` is ACCEPTED on read as the older spelling of
   * `voice.tts.providers.<name>.*` — it shipped before STT had a roster, when
   * "providers" could only mean one thing. It is never written back: a config
   * re-serialized from either spelling carries only the new one.
   *
   * `realtime.providers` is the THIRD roster, on the same three dotted levels
   * and through the same builder — hosted speech-to-speech engines that own the
   * audio in both directions instead of a transcribe → think → speak pipeline:
   *   voice.realtime.providers.live.provider: openai-realtime
   *   voice.realtime.providers.live.apiKey: ${secrets:voice/realtime/providers/live/apiKey}
   *   voice.realtime.providers.live.costPerMinuteUsd: 0.06
   * `realtime.default` names the entry a deployment uses when a personality
   * names none, and `realtime.sessionBudgetUsd` caps the accrued cost of ONE
   * session (rate × audio minutes) before it is cut short.
   *
   * `tier` is the deployment's default voice engine: `realtime` runs talk mode
   * as one hosted duplex session, `pipeline` is the explicit private/offline
   * mode (STT → LLM → TTS, which is what local providers can serve). Absent
   * leaves the choice to the surface. Anything other than those two values is
   * ignored, the same way an unknown `defaultMode` is.
   */
  voice?: {
    /**
     * Per-channel TTS-out default: which platforms speak their replies without
     * being asked. Keyed by platform id (`telegram`, `slack`, `discord`,
     * `whatsapp`, `email` — see `VOICE_CHANNEL_PLATFORMS`), value
     * `true`/`false`.
     *
     *   voice.channels.slack.ttsOut: false
     *
     * A platform absent here inherits `voice.defaultMode`. An explicit `false`
     * means "never speak on this channel", and outranks a lane's mode — an
     * operator turning a channel off is a deployment decision, not a
     * conversational one. `/voice all` in a Slack lane with
     * `voice.channels.slack.ttsOut: false` stays silent. An unknown platform id
     * or a non-boolean value is ignored, the same way an unknown `tier` is.
     */
    channels?: Record<string, { ttsOut?: boolean }>;
    /**
     * ffmpeg transcode stage. Present because voice notes only render as voice
     * bubbles in the container each platform wants, and the host binary is the
     * one new runtime dependency this feature has. Out-of-range numbers are
     * dropped, not clamped.
     */
    transcode?: {
      /** Path or name of the ffmpeg binary. Default: `ffmpeg` on PATH. */
      ffmpegPath?: string;
      /** Target bitrate for compressed containers, kbps. 8–320. Default 32 (voice). */
      bitrateKbps?: number;
      /** Budget for one ffmpeg invocation, seconds. 1–600. Default 30. */
      timeout?: number;
    };
    /**
     * Retention for synthesized voice artifacts. An artifact is deleted the
     * moment its delivery obligation is confirmed; these two keys bound what
     * happens to the ones that are never confirmed.
     */
    artifacts?: {
      /**
       * Give up on an undelivered obligation after this many days and delete
       * its artifact. 1–365. Default 7.
       */
      abandonAfterDays?: number;
      /**
       * Total on-disk cap for the artifact directory, MiB. Oldest-first
       * eviction once exceeded — the backstop for runaway accumulation when
       * neither delivery nor abandonment has fired. 1–102400. Default 512.
       */
      maxTotalMb?: number;
    };
    /**
     * Wake-word satellites: "hey engineer" from across the room wakes THAT
     * personality, with its toolset, memory scope and model routing intact.
     *
     * Routing is a DEPLOYMENT concern and deliberately not a PersonalityConfig
     * field: which phrase reaches which personality depends on the room and the
     * people in it, and two deployments of one personality can reasonably
     * disagree. Voice IDENTITY — the TTS voice, language map, tier, fast-lane
     * model — is on `PersonalityConfig.voice` and stays there.
     *
     * Out-of-range numbers and unknown engine ids are ignored rather than
     * clamped, and a route id outside `[A-Za-z0-9_-]+` is dropped: a typo here
     * must not make the whole config unloadable.
     */
    wake?: {
      /** Master switch. Absent → satellites decide from their own persisted state. */
      enabled?: boolean;
      /** Wake matcher: `fallback` (built-in, no native deps) | `sherpa` | `openwakeword`. */
      engine?: 'fallback' | 'sherpa' | 'openwakeword';
      /** Match threshold, 0..1. Higher = fewer false accepts, more misses. */
      sensitivity?: number;
      /** Consecutive matching frames before a wake fires — the false-accept damper. */
      confirmationFrames?: number;
      /** Transcribe on the satellite instead of shipping audio upstream. */
      edgeStt?: boolean;
      /**
       * Seconds of silence that end the LISTENING state. Ends listening ONLY —
       * never the session (eng-review D15). A post-timeout re-wake resumes the
       * same conversation.
       */
      idleTimeout?: number;
      /** Phrase → personality. Key is an operator-chosen route id. */
      routes?: Record<string, WakeRouteConfig>;
      /** Per-satellite overrides, keyed by the node's stable id. */
      nodes?: Record<string, { inputDevice?: string; enabled?: boolean }>;
    };
    bots: VoiceBotConfig[];
    livekit?: VoiceLiveKitConfig;
    trunk?: VoiceTrunkConfig;
    /** Who may reach the number, what answering costs, and where the summary
     *  goes. See `VoiceInboundConfig`. */
    inbound?: VoiceInboundConfig;
    /** Per-surface barge-in sensitivity. See `VoiceBargeInConfig`. */
    bargeIn?: VoiceBargeInConfig;
    /** Tool-call filler/tick keep-alive. See `VoiceFillerConfig`. */
    filler?: VoiceFillerConfig;
    trustedPlugins?: string[];
    defaultMode?: 'off' | 'mirror_inbound' | 'all';
    tier?: 'pipeline' | 'realtime';
    tts?: { providers: Record<string, TtsProviderEntry> };
    stt?: { providers: Record<string, SttProviderEntry> };
    realtime?: {
      providers?: Record<string, RealtimeProviderEntry>;
      /** Roster entry name a deployment falls back to. Not a provider id. */
      default?: string;
      /** USD cap on ONE realtime session's accrued cost. */
      sessionBudgetUsd?: number;
    };
  };
  // Email platform
  emailImapHost?: string;
  emailImapPort?: number;
  emailUser?: string;
  emailPassword?: string;
  emailSmtpHost?: string;
  emailSmtpPort?: number;
  /**
   * The authserv-id (first token of `Authentication-Results`) the mailbox's own
   * receiving server stamps. The email adapter trusts a `From:` address as an
   * identity only on a passing verdict in the topmost header carrying this id;
   * unset → every sender is unverified. Enforced by `resolveEmailSender`
   * (extensions/platform-email/src/index.ts).
   */
  emailTrustedAuthservId?: string;
  /** Show per-turn timing summary after every response. */
  verbose?: boolean;
  /**
   * FW-10 — chat-surface verbosity. Cycles via `/verbose`.
   *   `quiet`    final assistant text only — pipe-clean output
   *   `default`  text + tool chips + spinner + usage line
   *   `verbose`  also surfaces internal tool_progress events
   *   `debug`    also dumps raw event JSON
   */
  displayVerbosity?: 'quiet' | 'default' | 'verbose' | 'debug';
  /**
   * FW-9 — what Enter does mid-turn.
   *   `interrupt` (default) — abort in-flight run, start a new turn
   *   `queue`     FIFO-queue the input, run it after the current turn ends
   *   `steer`     inject as `[USER STEER]` on the next iteration's user message
   */
  displayBusyInputMode?: 'interrupt' | 'queue' | 'steer';
  /**
   * FW-11 — tool feed arg truncation. 0 = no truncation (default).
   */
  displayToolPreviewLength?: number;
  /**
   * FW-5 — show resume hint on chat exit. Defaults to true.
   * Set to false via `display.resume_hint: false` in config.yaml.
   */
  displayResumeHint?: boolean;
  /**
   * FW-6 — how many turn pairs to show in the recap panel on resume.
   * 0 disables the panel. Default 3. Range 0–10.
   */
  displayResumeRecapTurns?: number;
  /**
   * Named skin override (see `@ethosagent/design-tokens` built-in skins:
   * `default`, `mono`, `paper`). When set, the resolved tokens are wired
   * into both the TUI SkinContext and the Web ConfigProvider so the
   * visible palette matches the user's choice on every surface.
   */
  skin?: string;
  /**
   * FW-8 — CLI toolset override. Set by `--toolsets <list>` for this
   * invocation only. Never written to config.yaml.
   * @internal
   */
  cliToolsets?: string[];
  /**
   * FW-8 — CLI skill preload. Set by `-s <list>` for this invocation only.
   * Never written to config.yaml.
   * @internal
   */
  cliSkills?: string[];
  /**
   * FW-8 — Pre-loaded content for cliSkills. Populated by applyCliOverrides
   * so the hook in wiring.ts avoids a second readFileSync path.
   * @internal
   */
  cliSkillContents?: string[];
  /**
   * FW-16 — user-defined shell shortcuts, registered as `[quick]` slash commands.
   * Config format:
   *   quick_commands.status.type: exec
   *   quick_commands.status.command: git status
   *   quick_commands.status.gateway: true
   *   quick_commands.status.channels: telegram,slack
   */
  quick_commands?: Record<string, QuickCommandConfig>;
  /**
   * Context-economy Phase 1 — static per-channel toolset narrowing for the
   * gateway (platform → allowed tool names, intersect-only with the
   * personality toolset). Config format:
   *   channel_toolsets.whatsapp: read_file,memory_read
   */
  channelToolsets?: Record<string, string[]>;
  /** Global retention settings. Per-category TTLs. */
  retention?: RetentionConfig;
  /**
   * Per-personality overrides. Keyed by personality ID.
   * Only `retention` sub-block is supported here.
   */
  personalitiesConfig?: Record<string, { retention?: RetentionConfig }>;
  /**
   * Chapter 1 safety: per-platform sender allowlist + pairing config.
   * Parsed from `channel_filter.<platform>.<field>: <value>` keys in config.yaml.
   * When absent, the gateway allows all inbound messages (backward compat).
   * When present, the gateway enforces sender allowlists, DM pairing codes,
   * mention gating, and context-visibility stripping per platform.
   */
  channelFilter?: ChannelFilterConfig;
  /** Per-room entries by platform; see `ChannelsPlatformConfig` (restart-required on change). */
  channels?: Record<string, ChannelsPlatformConfig>;
  /**
   * FW-29 — skill evolver cron registration.
   *   `evolverCronEnabled` — when true, registers an in-process cron job that
   *     runs `ethos evolve run --quiet` on the configured schedule.
   *   `evolverSchedule`   — 5-field cron expression (default: "0 3 * * *").
   */
  evolverCronEnabled?: boolean;
  evolverSchedule?: string;
  /**
   * FW-13 — background sessions.
   *   `backgroundMaxConcurrent` — max simultaneous background agent tasks (default 4).
   *     Config key: background.max_concurrent
   *   `displayBellOnComplete` — ring the terminal bell when a background task finishes.
   *     Config key: display.bell_on_complete
   *
   * NOTE: `backgroundMaxConcurrent` is superseded by the durable engine's
   * `background.maxConcurrentJobs` (`BackgroundJobConfig`). It is retained only
   * for config round-trip stability and is no longer read by any surface.
   */
  backgroundMaxConcurrent?: number;
  /**
   * Background Sub-Agents job pool config (`background:` section). Parsed from
   * flat `background.<snake_case>` keys; see `BackgroundConfig` for the fields
   * and `backgroundDefaults()` for the fallbacks.
   */
  background?: BackgroundConfig;
  /**
   * Cron trigger surface (plan/phases/cron-fire-url-collapse.md), parsed from
   * the `cron.fireUrl` / `cron.maxParallelJobs` keys. A fresh config.yaml with
   * no `cron:` section at all runs only the local interval trigger, unchanged.
   */
  cron?: CronTopLevelConfig;
  /**
   * U11 — operator quiet hours for unprompted channel notices (`notifications.*`).
   * A setting, not identity: it never lives on a personality. The gateway holds
   * a background-job wake or an owner notice inside the window and delivers it
   * when the window ends (`Gateway.noticeHoldReason`); a reply to the user's
   * own message is never held. Config keys:
   *   notifications.quietHours: 22:00-07:00      (HH:MM-HH:MM, may cross midnight)
   *   notifications.timezone: Europe/London      (IANA; absent = the host's zone)
   *   notifications.bots.<botKey>.quietHours: off  (per-bot window, or off)
   */
  notifications?: NotificationsConfig;
  displayBellOnComplete?: boolean;
  /**
   * UD3 (plan ux-feedback-and-config-clarity H1) — how long a non-streaming
   * channel lane stays silent before the gateway sends its one per-turn
   * "working on it" ack. Config key: display.slow_turn_notice_ms. Absent means
   * the consumer's default (8000); `0` disables the notice. The default is NOT
   * baked in here — this field carries exactly what the file says.
   */
  displaySlowTurnNoticeMs?: number;
  displayDebugPanel?: boolean;
  displayDebugPanelModel?: string;
  /**
   * Per-surface opt-in for the "· remembered: …" capture notice (pillar B,
   * §3.3). CLI subtle-on when `true`; channels never surface it. Default
   * undefined (CLI decides its own default). Config key: display.memory_notices
   */
  displayMemoryNotices?: boolean;
  /**
   * Channel streaming draft edits (W3.1). Controls whether the gateway
   * delivers a turn's reply as live `editMessage` updates that grow in place
   * on edit-capable channels (Telegram, Slack):
   *   `'off'`  — never stream; one final message per turn.
   *   `'dms'`  — stream in direct messages only (default).
   *   `'all'`  — stream in DMs and group chats.
   * Config key: `display.streaming_edits`.
   */
  displayStreamingEdits?: 'off' | 'dms' | 'all';
  /**
   * Which treatment the Call Stage draws (DESIGN.md § "Call Stage").
   * Config key: `display.call_style`.
   *   `'personality'` (default) — each personality draws its own treatment:
   *     its `voice.call_style` if it declares one, otherwise a shape derived
   *     from its id.
   *   `'liquid' | 'orb' | 'rings'` — pin one treatment for every personality
   *     that has not declared its own.
   * Unset = `personality`.
   */
  displayCallStyle?: 'liquid' | 'orb' | 'rings' | 'personality';
  /**
   * What color the Call Stage draws in. Config key: `display.call_accent`.
   *   `'personality'` (default) — follow the active personality's `--accent`
   *   `'#RRGGBB'`               — an explicit hex
   * Anything else is ignored, so a typo falls back to the personality accent
   * rather than painting the call an unreadable color.
   */
  displayCallAccent?: string;
  /**
   * context_compression F1 — auxiliary model wiring. `auxiliary.compression`
   * configures the cheap summarizer that `semantic_summary` uses to condense
   * long histories. Config keys:
   *   auxiliary.compression.model: claude-haiku-4-5-20251001
   *   auxiliary.compression.provider: anthropic   (optional — defaults to `provider`)
   *   auxiliary.compression.apiKey: sk-ant-...     (optional — defaults to `apiKey`)
   *   auxiliary.compression.baseUrl: https://...   (optional — defaults to `baseUrl`)
   *
   * tools-vision P2 — `auxiliary.vision` configures the vision-capable model
   * `vision_analyze` routes to when the personality's primary model can't
   * process images / PDFs. Same shape as `compression`.
   *
   * tools-web — `auxiliary.web` configures the model `web_extract` uses to
   * summarize large pages. Same shape as `vision`.
   */
  auxiliary?: {
    compression?: AuxiliaryCompressionConfig;
    vision?: AuxiliaryVisionConfig;
    web?: AuxiliaryWebConfig;
    /** The DEFAULT STT entry. `command` is the shell template the `command-stt`
     *  provider runs (placeholders: {input_path}, {output_path}, {language});
     *  `timeout` is that command's budget, in seconds. Same shape as every
     *  `voice.stt.providers.<name>` roster entry, because it IS one — the one a
     *  personality gets when it names no other. */
    asr?: SttProviderEntry;
    /** The DEFAULT TTS entry. `command` is the shell template the `command-tts`
     *  provider runs (placeholders: {input_path}, {output_path}, {format},
     *  {voice}, {speed}); `outputFormat` is the container that command writes —
     *  and the extension `{output_path}` carries; `timeout` is its budget in
     *  seconds; `maxTextLength` caps the text handed to one synthesis call.
     *  Same shape as every `voice.tts.providers.<name>` roster entry, because it
     *  IS one — the one a personality gets when it names no other. */
    tts?: TtsProviderEntry;
  };
  /** tools-web — web_search/web_extract backend selection. */
  web?: WebConfig;
  /**
   * Inbound webhooks. Each hookId maps to a personality + a bearer secret.
   * Exposes POST /webhook/<hookId> on the gateway when non-empty.
   *   webhooks.<hookId>.personalityId: researcher
   *   webhooks.<hookId>.secret: <bearer-secret>
   *   webhooks.<hookId>.sessionKey: <optional-stable-session-key>
   *   webhooks.<hookId>.prefilter: <script under ~/.ethos/scripts/, .sh or .py>
   *   webhooks.<hookId>.prefilterTimeoutSeconds: 30   (max 600)
   *   webhooks.<hookId>.mode: sync | ack              (default sync)
   *   webhooks.<hookId>.events: push, issue.opened    (default: accept all)
   *   webhooks.<hookId>.eventHeader: x-github-event   (default x-event-type)
   *   webhooks.<hookId>.eventField: meta.event        (default event)
   *   webhooks.<hookId>.deliverOnly: true             (relay only, no turn)
   *   webhooks.<hookId>.private: true                 (turn may read private memory, D12)
   *   webhooks.<hookId>.deliver.0.type: platform | log
   *   webhooks.<hookId>.deliver.0.adapterId: telegram:tg-a
   *   webhooks.<hookId>.deliver.0.chatId: 12345
   *   webhooks.<hookId>.deliver.0.threadId: <optional-thread>
   *   webhooks.<hookId>.hmac.secret: <signing-secret>   (additive to secret)
   *   webhooks.<hookId>.hmac.header: x-hub-signature-256 (default x-signature)
   *   webhooks.<hookId>.hmac.algorithm: sha256 | sha1 | sha512  (default sha256)
   *   webhooks.<hookId>.hmac.previousSecret: <rotation-window-secret>
   *   webhooks.<hookId>.rateLimit.maxPerMinute: 60    (default: unlimited)
   *   webhooks.<hookId>.rateLimit.lockoutSeconds: 600 (default 600)
   */
  webhooks?: Record<string, WebhookHookConfig>;
  /**
   * Remote model catalog configuration. Controls how Ethos fetches and caches
   * the centralized model metadata catalog (capabilities, context windows, pricing).
   * Config keys:
   *   modelCatalog.enabled: false
   *   modelCatalog.url: https://custom.example.com/catalog.json
   *   modelCatalog.ttlHours: 12
   *   modelCatalog.providers.<id>.url: https://internal.example.com/anthropic.json
   */
  modelCatalog?: ModelCatalogConfig;
  /**
   * The deployment's model roster — which models this deployment may use, under
   * operator-chosen aliases (D2 of plan/phases/model-registry.md).
   *
   * It takes its own prefix rather than sharing `models.*`: that namespace is
   * the §7 per-model profile override, keyed `<providerId>/<modelId>`, and an
   * alias literally named `anthropic/claude-sonnet-5` would be genuinely
   * ambiguous with it.
   *
   * An entry holds NO credential. `provider` names a provider ENTRY — the `id`
   * on a `providers.<n>` line, not a provider TYPE — and that entry already
   * owns the key, the base URL and the region. Config keys:
   *   modelRegistry.sonnet.provider: anthropic-work
   *   modelRegistry.sonnet.modelId: claude-sonnet-5
   *   modelRegistry.sonnet.label: everyday driver
   *   modelRegistry.sonnet.contextWindow: 200000
   *   modelRegistry.sonnet.costPer1kInput: 0.003
   *   modelRegistry.sonnet.costPer1kOutput: 0.015
   *   modelRegistry.sonnet.fallbacks: sonnet-eu,sonnet-old
   *   modelRegistry.default: sonnet
   *   modelRegistry.roles.deep: opus
   *
   * The codec does not judge what it reads: a missing `provider` or `modelId`
   * reaches the config as `''` rather than being dropped, so
   * `validateModelRegistry` (T1.3, not yet written) can refuse it by name.
   */
  modelRegistry?: ModelRegistry;
  /**
   * Logging settings. `rotation` controls when `~/.ethos/logs/errors.jsonl` is
   * rotated; `level` is the lowest severity `ConsoleLogger` prints (records
   * below it are dropped). Absent `level` means `'debug'` — everything prints,
   * which is what the framework did before the gate existed. Config keys:
   *   logs.rotation.maxBytes: 10485760
   *   logs.rotation.maxFiles: 5
   *   logs.rotation.enabled: false
   *   logs.level: info
   */
  logs?: {
    rotation?: {
      maxBytes?: number;
      maxFiles?: number;
      enabled?: boolean;
    };
    level?: LogLevel;
  };
  /**
   * AWS integration configuration. Currently supports Secrets Manager
   * as a secrets backend. Config keys:
   *   aws.secrets.enabled: true
   *   aws.secrets.region: us-east-1
   *   aws.secrets.prefix: ethos/engineer
   *   aws.secrets.endpoint: http://localhost:4566
   */
  aws?: AwsConfig;
  /** Public-facing URL of the web UI. Used as the OAuth redirect base.
   *  Resolution: ETHOS_PUBLIC_URL env > config.yaml webBaseUrl > localhost default. */
  webBaseUrl?: string;
  /** Storage-layer settings: a pluggable backend via `storage.backend`
   *  (default `fs`). Set `s3` to target AWS S3 (or an S3-compatible endpoint)
   *  when `backend: s3`. (`storage.encryption` was removed — see
   *  `storageEncryptionRemovedNotice`.) */
  storage?: {
    backend?: 'fs' | 's3';
    s3?: {
      bucket?: string;
      region?: string;
      prefix?: string;
      endpoint?: string;
      forcePathStyle?: boolean;
    };
  };
  /** Whether to auto-install plugins from plugins.lock on personality load.
   *  Config key: plugins.auto_install */
  pluginsAutoInstall?: boolean;
  /**
   * Plugin process isolation (plan plugin-process-isolation §6.1). Present only
   * when the file sets at least one `plugins.isolation*` / `plugins.host.*` key;
   * every field is then resolved (an invalid value keeps its default).
   * Config keys: plugins.isolation, plugins.isolation.<pluginId>,
   * plugins.host.sandbox, plugins.host.hook_timeout_ms,
   * plugins.host.idle_stop_minutes, plugins.host.max_heap_mb
   */
  pluginIsolation?: PluginIsolationConfig;
  /**
   * Web admin panel gate. The `/admin` page and the `admin.*` RPC namespace
   * are available only when `admin.enabled: true` is set explicitly —
   * default false. Config key: admin.enabled
   */
  admin?: { enabled?: boolean };
  /**
   * Agent-to-Agent (A2A) surface gate. The `/a2a`, `/a2a-auth`, and well-known
   * card routes plus the `a2a_send` tool are live only when `a2a.enabled: true`
   * is set explicitly — default false (A2A stays opt-in). Config key:
   * a2a.enabled. Supersedes the deprecated `ETHOS_A2A_ENABLED` env override.
   *
   * `peering.allowPrivateUrls` (config key `a2a.peering.allowPrivateUrls`,
   * default false) lets OPERATOR-initiated peering — `ethos a2a peer add` and
   * the web "Add peer" dialog — fetch a card from a loopback or private-network
   * URL. Read by `A2aPeeringService.fetchVerified`
   * (packages/wiring/src/a2a-peering-service.ts); the model-driven `a2a_send`
   * never reads it and stays on the personality's `safety.network`. The
   * cloud-metadata address is refused regardless (`validateUrl` in
   * packages/safety/network/src/safe-fetch.ts).
   */
  a2a?: { enabled?: boolean; peering?: { allowPrivateUrls?: boolean } };
  /**
   * Goal settings. `allowCheckCommands: true` lets a goal created from the web
   * UI/API carry a check with a `command`, which the goal judge runs as that
   * personality's shell command — through the `terminal` gates and on its
   * resolved execution backend, which is the host itself under a local posture
   * (`createAcceptanceCheckExecutor`, packages/wiring). Default false: a create
   * carrying a command is refused (`GoalsService.create`,
   * apps/web-api/src/services/goals.service.ts). Config key:
   * goals.allowCheckCommands
   */
  goals?: { allowCheckCommands?: boolean };
  /**
   * Operator-controlled security settings.
   *
   * `trustedGitHubOrgs` — the GitHub organizations whose skills and plugins
   * resolve to the `trusted-repo` install tier. The configured list REPLACES
   * the shipped default (`ethosagent`, `anthropic`) rather than extending it,
   * so an operator can remove an org they do not trust. An explicitly empty
   * value is meaningful — it trusts no organization — and is distinct from the
   * key being absent, which leaves the default in force. Config keys:
   *   security.trusted_github_orgs: acme-corp, ethosagent
   *   security.trusted_github_orgs: ""     # trust no org
   */
  security?: { trustedGitHubOrgs?: string[] };
  /**
   * Governed-learning nightly pass scheduler (Phase 3c E). Default-off: when
   * absent or `enabled !== true`, no timer is created and behavior is
   * unchanged. When enabled, `ethos serve` / `ethos gateway start` fire the
   * nightly pass on `cron` (default `0 3 * * *`). Config keys:
   *   nightlyPass.enabled: true
   *   nightlyPass.cron: 0 3 * * *
   */
  nightlyPass?: { enabled?: boolean; cron?: string };
  /**
   * Scheduled local snapshots of `~/.ethos` (plan agent-state-backup §3).
   * ON unless explicitly disabled: an agent's state is its memory, its
   * sessions and its personalities, and the deployment that most needs a
   * backup is the one whose operator never went looking for the setting.
   * Rotation (`keep`) bounds what that costs on disk.
   *
   * `dir` defaults to `<ethosDir>/backups`, computed in code — `${ETHOS_HOME}`
   * is NOT a token config.yaml expands (D5). A relative value resolves under
   * the data dir. `scope` names are validated where the backup runs, not here;
   * the scope roster belongs to `@ethosagent/wiring`, which this package must
   * not depend on. Config keys:
   *   backup.enabled: true
   *   backup.cron: 0 4 * * *
   *   backup.scope: identity,state
   *   backup.keep: 7
   *   backup.dir: /mnt/snapshots
   */
  backup?: {
    enabled?: boolean;
    cron?: string;
    scope?: string[];
    keep?: number;
    dir?: string;
  };
  /**
   * Proactive memory capture (memory-experience pillar B). Default-off. See
   * `MemoryCaptureConfig`. Parsed from flat `memoryCapture.<field>` keys.
   */
  memoryCapture?: MemoryCaptureConfig;
  /**
   * Bring-your-own-vault backend settings (memory-lifecycle L1). Read only
   * when `memory: vault`. See `MemoryVaultConfig`. Parsed from flat
   * `memoryVault.<field>` keys.
   */
  memoryVault?: MemoryVaultConfig;
  /**
   * Approve-before-store gate (memory-lifecycle L2). Default-off. See
   * `MemoryApprovalConfig`. Parsed from flat `memoryApproval.<field>` keys.
   */
  memoryApproval?: MemoryApprovalConfig;
  /**
   * Importance scoring + decay tuning (memory-experience pillar C). Defaults
   * applied by the nightly pass when absent. See `MemoryConsolidationConfig`.
   * Parsed from flat `memoryConsolidation.<field>` keys.
   */
  memoryConsolidation?: MemoryConsolidationConfig;
  /**
   * Weekly governed-learning digest scheduler (Phase 3e). Default-off: when
   * absent or `enabled !== true`, no timer is created and behavior is
   * unchanged. When enabled, `ethos serve` / `ethos gateway start` build the
   * digest on `cron` (default `0 9 * * 1` — Monday 9am). `recipients` is the
   * email allowlist for the optional `--email` delivery path. Config keys:
   *   weeklyDigest.enabled: true
   *   weeklyDigest.cron: 0 9 * * 1
   *   weeklyDigest.recipients: alice@example.com, bob@example.com
   */
  weeklyDigest?: { enabled?: boolean; cron?: string; recipients?: string[] };
  /**
   * Ambient channel digest (plan/phases/ambient-group-monitoring.md R3/R9/R10).
   * Default-off. Summarises what observe-mode chats recorded since the last
   * run and delivers it to the owner's DM from the bot that watched, plus the
   * in-app notifications feed.
   *
   * Seeded ONLY by `ethos gateway` and `ethos boot` — `ethos serve` runs no
   * channel adapters, and `systemJobSpecs` omits the job from serve's roster
   * rather than listing it disabled (which would delete it). Config keys:
   *   channelDigest.enabled: true
   *   channelDigest.cron: 0 8 * * *
   *   channelDigest.deliverTo: owner
   *   channelDigest.maxMessagesPerLane: 500
   *   channelDigest.maxLanesPerRun: 25
   *   channelDigest.costWarnUsdPerLane: 0.50
   */
  channelDigest?: {
    enabled?: boolean;
    cron?: string;
    /**
     * `owner` — the owner's DM *and* the notifications feed. `inApp` — the
     * feed only. The feed always gets it (R10), so this names the one delivery
     * that can be switched off, not a choice between two.
     */
    deliverTo?: 'owner' | 'inApp';
    /** Newest-N messages read per lane. Older ones are counted, not summarised. */
    maxMessagesPerLane?: number;
    /**
     * How many lanes one run may summarise — a real ceiling, unlike
     * `costWarnUsdPerLane`. A lane is a chat AND a thread, so one watched Slack
     * channel with eighty threads in a day is eighty provider calls and eighty
     * direct messages from a single nightly run. Lanes past the cap are DEFERRED,
     * not dropped: their cursors are untouched and they are attempted first on
     * the next run. See `ChannelDigestSettings.maxLanesPerRun`.
     */
    maxLanesPerRun?: number;
    /**
     * Spend NOTICE threshold for one lane's summary turn, in USD — a lane that
     * costs more is still delivered, with a footnote saying what it cost. Not
     * a ceiling: the digest is a single provider call and the USD figure only
     * exists in the `usage` chunk that arrives after billing, so nothing can
     * refuse a call already made. See `ChannelDigestSettings.costWarnUsdPerLane`.
     */
    costWarnUsdPerLane?: number;
  };
  /**
   * Replay-gated learning (plan `trust-before-reach.md` L-D8). Operator
   * settings, not identity: `PersonalityConfig` is deliberately untouched,
   * because two deployments of the same personality can reasonably disagree
   * about how much a nightly replay may spend.
   *
   * Every field is optional and absent means "the default". The defaults are
   * `LEARNING_REPLAY_DEFAULTS`; read the block through `resolveLearningReplay`
   * rather than spelling `?? 8` at each use, so the four numbers have one
   * owner. Config keys:
   *   learningReplay.enabled: true
   *   learningReplay.maxCases: 8
   *   learningReplay.maxCostUsd: 0.50
   *   learningReplay.maxCandidatesPerRun: 5
   */
  learningReplay?: {
    /**
     * `false` stops replay running at all: the nightly `replay` step is a
     * no-op and candidates wait for a human. It does NOT re-open the ungated
     * auto-apply paths replay replaced (L-D1) — a candidate with no verdict is
     * never auto-promoted.
     */
    enabled?: boolean;
    /**
     * Cases replayed per candidate, at most 3 of them target cases (L-D6).
     * The floor of 3 is the verdict rule's, not this key's: below 3 no run can
     * reach verdict `pass`, so a smaller value is refused here rather than
     * quietly making every candidate `incomplete`.
     */
    maxCases?: number;
    /**
     * USD ceiling for one candidate's replay, summed from the replay loops'
     * `usage` events (L-D7). Exceeding it stops the run with verdict
     * `incomplete`, so the gate fails closed. Grader calls are not counted in
     * dollars (`llmJudgeScorer` reports no usage); they are bounded by count.
     */
    maxCostUsd?: number;
    /** Candidates one nightly `replay` step may run (L-D9). */
    maxCandidatesPerRun?: number;
  };
  /**
   * Kanban poll loop: periodically checks the board for tasks assigned to
   * this agent's personalityId with status=ready, and enqueues a stimulus.
   * Also runs board housekeeping (promote, rollup, reclaim).
   *
   * Config format:
   *   kanbanPoll.enabled: true
   *   kanbanPoll.intervalMs: 5000
   *   kanbanPoll.boardPath: ~/.ethos/teams/myteam/board.db
   */
  /**
   * Soft-warn tiers for the agent loop's tool-call budgets. Crossing one emits
   * a one-per-turn internal-audience `tool_progress` nudge; it never stops the
   * turn — that stays the job of the hard caps in `AgentLoopConfig.options`.
   * Absent = no warn, unchanged behaviour.
   *
   * The hard caps themselves are also settable here: a warn tier set at or
   * above its cap can never fire, so `buildToolLoop` drops it. Absent = the
   * loop defaults (1000 / 25).
   *
   * Config format:
   *   toolLoop.maxToolCallsWarnAt: 40
   *   toolLoop.maxIdenticalToolCallsWarnAt: 10
   *   toolLoop.maxToolCallsPerTurn: 1000
   *   toolLoop.maxIdenticalToolCalls: 25
   */
  toolLoop?: {
    /** Total tool calls in one turn at which to nudge. Positive integer. */
    maxToolCallsWarnAt?: number;
    /** Per-tool-name repeat count at which to nudge. Positive integer. */
    maxIdenticalToolCallsWarnAt?: number;
    /** Hard cap on total tool calls in one turn. Positive integer. */
    maxToolCallsPerTurn?: number;
    /** Hard cap on per-tool-name repeats in one turn. Positive integer. */
    maxIdenticalToolCalls?: number;
  };
  /**
   * MCP client settings that belong to the machine, not to a personality or to
   * `mcp.json` (a bare array with nowhere to put a setting).
   *
   * Config format:
   *   mcp.discoveryConcurrency: 4
   */
  mcp?: {
    /**
     * Max MCP server `connect()` calls in flight at once per `McpManager`.
     * Integer 1-16; absent = `DEFAULT_DISCOVERY_CONCURRENCY` (4) in
     * `@ethosagent/tools-mcp`. Parsed by `buildMcpConfig`; pinned by
     * `__tests__/config-mcp-discovery.test.ts`.
     */
    discoveryConcurrency?: number;
  };
  /**
   * Board-wide work-in-progress caps. Distinct from `kanbanPoll` (poll cadence)
   * — these bound how many tasks may be `running` at once, enforced by
   * `KanbanStore.updateStatus` on the transition into `running`. Absent = no
   * cap, unchanged behaviour.
   *
   * Config format:
   *   kanban.maxInProgress: 5
   *   kanban.maxInProgressPerProfile: 2
   */
  kanban?: {
    /** Max tasks in `running` across the whole board. Positive integer. */
    maxInProgress?: number;
    /** Max tasks in `running` per assignee. Positive integer. */
    maxInProgressPerProfile?: number;
  };
  /**
   * Ground-truth verification — does what the agent SAID match what its tools
   * DID (plan/phases/ground-truth-verification.md). Policy lives here rather
   * than on the frozen `PersonalityConfig`: two deployments of the same
   * personality can reasonably disagree about how loud the check should be.
   *
   * Config format (values shown are the defaults):
   *   grounding.enabled: true
   *   grounding.onFinding: annotate            # annotate | correct
   *   grounding.showUnsupported: false
   *   grounding.memoryTag: false
   *   grounding.kanban.checks: true
   *   grounding.kanban.allowedCheckCommands: pnpm test, pnpm typecheck
   */
  grounding?: {
    /** Master switch. Off = no evidence collector, no auditor, no injector. */
    enabled?: boolean;
    /**
     * What a finding does. `annotate` surfaces the `_grounding` line and stops
     * there; `correct` additionally asks the next turn to open with a
     * correction.
     */
    onFinding?: 'annotate' | 'correct';
    /**
     * Surface `unsupported` verdicts even on a turn that ran a write-capable
     * tool. Off by default (R7) — on such a turn an unmatched claim is far
     * more often a gap in the pattern table than a lie.
     */
    showUnsupported?: boolean;
    /**
     * Tag a contradicted turn's memory capture `unverified` instead of
     * skipping it.
     */
    memoryTag?: boolean;
    kanban?: {
      /** Run `check:` lines from `acceptanceCriteria` before the LLM judge. */
      checks?: boolean;
      /**
       * WHOLE COMMANDS a `check: run <command> exit <n>` may name. A check's
       * command must equal an entry token for token, with nothing appended, so
       * the list being empty means no `run` check ever executes.
       *
       * Exact, not a prefix: acceptance criteria are written by the AGENT, so
       * an entry whose tail the agent fills in is not an authorization. `node`
       * as a prefix would admit `node -e '<any program>'`, and `pnpm test`
       * would admit `pnpm test --config <agent-chosen>.js`. Name each command
       * you actually want run — `pnpm test --reporter=json` is a separate
       * entry from `pnpm test`.
       *
       * The command also runs through the personality's execution posture (the
       * container at `docker`, the host `ScopedProcess` at `local`, nothing at
       * `none`), never a spawn of its own.
       */
      allowedCheckCommands?: string[];
    };
  };
  /**
   * Launch posture and Playwright timeouts for the `browser` toolset. The two
   * timeouts were hardcoded at the call sites before they became configurable,
   * so their defaults below are exactly what those literals were.
   *
   * Everything here is an OPERATOR concern — how this machine's browser is
   * launched — not personality identity. Which personality may reach the
   * stealth tier is its toolset's business, not this block's.
   *
   * Config format:
   *   browser.navigationTimeoutMs: 30000
   *   browser.commandTimeoutMs: 10000
   *   browser.headed: auto
   *   browser.idleTimeoutMs: 600000
   *   browser.stealth.enabled: false
   *   browser.profiles.enabled: true
   *   browser.proxy.server: http://proxy.example.com:3128
   *   browser.proxy.username: ethos
   *   browser.proxy.password: ${secrets:browser/proxy/password}
   */
  browser?: {
    /** Budget for one page load (`goto`/`goBack`), ms. 1000–600000. Default 30000. */
    navigationTimeoutMs?: number;
    /** Budget for one element interaction (`click`), ms. 1000–600000. Default 10000. */
    commandTimeoutMs?: number;
    /**
     * Whether a session launches with a visible window. Three-state, not a
     * boolean: `'auto'` is the operator saying "decide from the machine" —
     * headed on a desktop, headless on a server.
     *
     * `'auto'` is NOT resolved here. Answering it needs an environment probe
     * (`DISPLAY`/`WAYLAND_DISPLAY`, platform), and this layer has to parse and
     * re-serialize the same file on every machine — resolving would make
     * `writeConfig` rewrite the operator's `auto` as `true` on a laptop and
     * `false` on a VPS, so the file would stop meaning what they wrote. The
     * session factory resolves it; config carries the choice.
     *
     * Absent = the consumer's own default (`'auto'`).
     */
    headed?: boolean | 'auto';
    /** Idle sweep budget for an open session, ms. 60000–86400000. Default 600000. */
    idleTimeoutMs?: number;
    /** Stealth tier. Absent, or `enabled: false`, is OFF — nothing may read
     *  absence as on. */
    stealth?: { enabled?: boolean };
    /** Persistent per-personality browser profiles (`~/.ethos/browser-profiles/`). */
    profiles?: { enabled?: boolean };
    /**
     * Upstream proxy for browser sessions. `server` carries an explicit scheme
     * (`http:`/`https:`/`socks4:`/`socks5:`); a bare `host:port` is refused
     * rather than guessed at.
     *
     * `password` is a credential — `SECRET_FIELD_NAMES` requires it to be
     * entirely `${secrets:…}` when a resolver is configured, and it is
     * externalized on write and resolved on read like every other one.
     */
    proxy?: { server: string; username?: string; password?: string };
  };
  /**
   * Gateway-wide knobs that are not per-adapter credentials.
   *
   * `maxInboundMediaBytes` is an OVERRIDE, not a universal cap: each platform
   * adapter keeps its own default (the ceiling the platform itself imposes)
   * and only reads this when it is set. There is no central inbound-media
   * path to enforce it at — the value is threaded into each adapter at
   * construction.
   *
   * Config format:
   *   gateway.maxInboundMediaBytes: 52428800
   *   gateway.inboundSpool.maxAttempts: 3
   *   gateway.inboundSpool.maxReplayAgeMs: 86400000
   *   gateway.private_chats.telegram: -1001234567890,-1009876543210
   */
  gateway?: {
    /** Largest inbound attachment any adapter will download, bytes. 1024–134217728. */
    maxInboundMediaBytes?: number;
    /**
     * The inbound spool's operator knobs (plan reach-and-containment D2-7,
     * D2-9). Unset keys leave the gateway on its defaults: 3 attempts, 24h.
     */
    inboundSpool?: {
      /** Attempts before an owed message is dead-lettered. 1–100. */
      maxAttempts?: number;
      /** Rows older than this at replay are dead-lettered as stale, ms. 60000–2592000000. */
      maxReplayAgeMs?: number;
    };
    /**
     * Trusted rooms (plan personality-memory-boundary D9): platform → the
     * group chat ids the operator vouches for as private, from
     * `gateway.private_chats.<platform>: <chatId,...>`. Keyed on platform +
     * chat id, so every bot on that platform honours the list. Deliberately
     * NOT under `channel_filter.*`: the presence of a `channel_filter.<platform>`
     * block turns the sender filter on, and listing a room must not do that.
     *
     * Read ONCE, when the gateway is built (`buildGateway` in
     * apps/ethos/src/commands/gateway.ts → `GatewayConfig.privateChats`); a
     * change needs a gateway restart. `config-reload.ts` reports it as
     * restart-required (`UNSUPPORTED_KEYS`). Until the restart an UNLISTED room
     * stays trusted — a documented fail-open window.
     */
    privateChats?: Record<string, string[]>;
  };
  /**
   * The decision provider (plan/phases/decision-provider-jev.md §7). Absent =
   * no decision layer: every site runs today's path. Holds only the keys the
   * file states; read it through `resolveDecisionsConfig` for defaults and
   * per-site budgets. Operator-level: provider, key, endpoint, model pin,
   * budgets and thresholds. WHICH sites run is declared per personality
   * (`PersonalityConfig.decisions`) and resolved per call by
   * `resolvePersonalityDecisionSite` (./decisions); a global
   * `decisions.sites.*` line is warned about and never read (PD5).
   *
   * Config format:
   *   decisions.provider: typesafe
   *   decisions.thresholds.injection: 0.9
   */
  decisions?: DecisionsConfig;
  /**
   * Team-supervisor knobs. Named `teamSupervisor` rather than `gateway`
   * because the gateway process does not restart itself — member auto-restart
   * is owned by the supervisor that spawned them.
   *
   * Config format:
   *   teamSupervisor.restartLoopGuard.maxRestarts: 5
   *   teamSupervisor.restartLoopGuard.windowSeconds: 60
   */
  teamSupervisor?: {
    /**
     * Rolling-window brake on `auto_restart`. A member is respawned up to
     * `maxRestarts` times inside `windowSeconds`; the crash after that leaves
     * it marked failed. Unset means 5 respawns in 60 seconds — one MORE
     * respawn than the previous hardcoded guard, which gave up on the fifth
     * crash and so performed four restarts.
     */
    restartLoopGuard?: {
      /** Respawns allowed inside the window. 1–1000. Unset = 5. */
      maxRestarts?: number;
      /** Width of the rolling window, seconds. 1–86400. Default 60. */
      windowSeconds?: number;
    };
  };
  kanbanPoll?: {
    enabled?: boolean;
    /** Poll interval in milliseconds. Default 5000. */
    intervalMs?: number;
    /** Path to the board.db file. When serve is started with --team, this
     *  defaults to the team's board path. */
    boardPath?: string;
  };
  /**
   * Idle watcher: aggregates every subsystem's busy state into one answer so a
   * scale-to-zero host (Firecracker-style microVMs that pause between
   * messages) can be told "nothing is in flight, it is safe to stop this VM".
   *
   * An operator/deployment concern, NOT personality identity — two deployments
   * of the same personality trivially disagree about it (a laptop `pnpm dev`
   * wants it off, a hosted microVM wants it on), so it lives here rather than
   * on `PersonalityConfig`.
   *
   * `enabled` defaults to `false`: this must never activate by omission, since
   * an unarmed-but-wrong watcher exits a process mid-work. There is
   * deliberately NO key for the manager's instrumentation-gap check — that gate
   * is hard-coded, because letting an operator override it reintroduces the
   * silent-data-loss risk it exists to prevent.
   *
   * Config format:
   *   idleWatcher.enabled: false
   *   idleWatcher.idleThresholdMs: 120000
   *   idleWatcher.startupCooldownMs: 30000
   *   idleWatcher.checkIntervalMs: 15000
   *   idleWatcher.wakePathConfirmed: false
   */
  idleWatcher?: IdleWatcherConfig;
  world?: import('./section-types').WorldConfig; // plan world-model 4.6; read via resolveWorld
  shareLinks?: import('./section-types').ShareLinksConfig; // plan share-links D11; read via resolveShareLinks
  /**
   * Laptop tool nodes (plan laptop-tool-node D18). Off unless enabled.
   * Config format: nodes.enabled: true
   */
  nodes?: NodesConfig;
  /**
   * Pause-clock correction (plan/phases/clock-tolerance-pass.md §7) — the
   * resume-side twin of `idleWatcher`. On a snapshotting host the guest's wall
   * clock does not advance while the VM is paused, so on resume every staleness
   * gate (job-store `reclaimStale`, kanban heartbeats, the delivery ledger's
   * abandon window) reads the pause as downtime. When enabled, the process runs
   * a clock-drift detector and boot reconciliation discounts the detected pause
   * from those gates.
   *
   * An operator/deployment concern, NOT personality identity — two deployments
   * of the same personality trivially disagree about it — so it lives here and
   * has no personality-facing key.
   *
   * Config format:
   *   pauseClockCorrection.enabled: false
   *   pauseClockCorrection.thresholdMs: 60000
   */
  pauseClockCorrection?: {
    /** Default false — every non-snapshotting deployment (bare metal, docker,
     *  `pnpm dev`) has no pause to discount. */
    enabled?: boolean;
    /** Wall-clock jump, in ms, above which a tick is treated as a resume rather
     *  than scheduler slack. Default 60_000. */
    thresholdMs?: number;
  };
  /**
   * Pause/resume lifecycle notifications to an external orchestrator — an
   * operator/deployment concern, NOT personality identity, same rationale as
   * `pauseClockCorrection` above.
   *
   * Config format:
   *   pauseLifecycle.http.url: https://orchestrator.example.com/tenants/<id>/idle
   *   pauseLifecycle.http.token: ${secrets:pauseLifecycle/http/token}
   *   pauseLifecycle.http.timeoutMs: 5000
   */
  pauseLifecycle?: {
    http?: {
      /** Orchestrator endpoint to notify. */
      url?: string;
      /** Bearer credential sent with the notification. Externalize via
       *  `${secrets:<ref>}` — see `SECRET_FIELD_NAMES`. */
      token?: string;
      /** Request timeout, in ms. */
      timeoutMs?: number;
    };
  };
  /**
   * Export/observability targets (analytics-observability plan, Part E).
   * Currently one leaf: Langfuse. Off by default.
   *
   * Config format:
   *   telemetry.export.langfuse.enabled: true
   *   telemetry.export.langfuse.baseUrl: https://cloud.langfuse.com
   *   telemetry.export.langfuse.publicKey: pk-lf-...
   *   telemetry.export.langfuse.secretKey: sk-lf-...
   */
  telemetry?: TelemetryConfig;
}
