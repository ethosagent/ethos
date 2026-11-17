// Gateway configuration and contract types (GatewayConfig, GatewayBotConfig,
// Publication*, HeldNotice*, GatewayObservability and the inbound/lane result
// types), moved out of index.ts (Context Budget 3, Task 2). Types only;
// index.ts re-exports every one.

import type {
  AgentLoop,
  ChannelPresence,
  LaneVoiceModeStore,
  PrivateChatSet,
} from '@ethosagent/core';
import type { DeliveryLedger } from '@ethosagent/delivery-ledger';
import type { InboundDedupStore } from '@ethosagent/inbound-dedup';
import type { InboundSpool } from '@ethosagent/inbound-spool';
import type { ChannelFilterConfig } from '@ethosagent/safety-channel';
import type Database from '@ethosagent/sqlite';
import type {
  AttachmentCache,
  ChannelTranscriptStore,
  ClarifyResponse,
  InboundMessage,
  PersonalityVoiceConfig,
  PlatformAdapter,
  PlatformAdapterFactory,
  SessionStore,
  Storage,
  SttProviderEntry,
  SttProviderRegistry,
  TtsProviderEntry,
  TtsProviderRegistry,
} from '@ethosagent/types';
import type { VoiceMode } from '@ethosagent/voice-text';
import type {
  BotSpend,
  ChannelDigestFeedResult,
  GatewayBotConfig,
  GatewayObservability,
  HeldNoticeStore,
  PublicationSpeaksFor,
} from './gateway-types';
import type { McpLoginPort } from './mcp-login-port';
import type { GatewayQuietHours } from './quiet-hours';
import type { Transcoder } from './transcode';
import type { VoiceArtifactStore } from './voice-artifacts';

export type {
  BotSpend,
  ChannelDigestFeedResult,
  GatewayBotConfig,
  GatewayObservability,
  HandleMessageOptions,
  HeldNotice,
  HeldNoticeStore,
  InboundAcceptance,
  LaneStop,
  PublicationRefusalCode,
  PublicationRequest,
  PublicationResult,
  PublicationSpeaksFor,
  SessionRouting,
} from './gateway-types';

export interface GatewayConfig {
  /**
   * `/mcp login | code | cancel` seam (plan mcp-device-code-login §8.2). Absent in
   * tests and standalone use, where `GatewayBotConfig.mcpLogin` is the fallback;
   * with neither, `/mcp` answers "MCP sign-in is not available on this gateway."
   */
  mcpLoginFor?: (botKey: string) => McpLoginPort | undefined;
  /**
   * Multi-bot routing: one entry per bot. The Gateway keys its lane state
   * by `(platform, botKey, chatId[, threadId])` — encoded via `buildLaneKey`
   * — so concurrent conversations across bots and threads stay isolated.
   * Exactly one of `bots` / `loop` must be set; single-adapter deployments
   * may continue to pass `loop` directly.
   */
  bots?: GatewayBotConfig[];
  /** Back-compat shorthand for single-bot deployments. Ignored when
   *  `bots` is non-empty. Internally synthesized into a one-entry list
   *  with `botKey: 'default'` and binding `{ type: 'personality', name: defaultPersonality }`. */
  loop?: AgentLoop;
  /** Default personality ID for the back-compat single-bot path. */
  defaultPersonality?: string;
  /**
   * Global cap on how many turns (`runTurn`) execute simultaneously across ALL
   * lanes — the single-instance quota knob. Enforced by a semaphore around
   * turn execution: excess turns wait for a slot, and a lane whose backlog
   * reaches `maxLaneQueue` while the global budget is saturated gets a typed
   * busy rejection instead of an unbounded queue.
   *
   * When UNSET (or <= 0) the limit is unbounded — today's behavior is
   * preserved exactly, no turn ever waits. Set it only to impose a quota.
   */
  maxConcurrentSessions?: number;
  /**
   * Maximum messages queued for a single lane while turns wait on a global
   * concurrency slot. Once a lane's depth reaches this AND
   * `maxConcurrentSessions` is saturated, further messages for that lane are
   * rejected with a typed "system busy" reply rather than queued unbounded.
   * Defaults to 8. Has no effect unless `maxConcurrentSessions` is set (an
   * unbounded global budget never saturates, so lanes never back up).
   */
  maxLaneQueue?: number;
  /**
   * Size of the inbound-message dedup window. The Gateway remembers the most
   * recent N `(platform, chatId, messageId)` triples and silently drops
   * duplicates. Defaults to 1024. Set to 0 to disable dedup.
   * Adapters that don't populate `InboundMessage.messageId` are unaffected
   * (no key, no dedup possible — see plan/IMPROVEMENT.md P2-2).
   */
  dedupWindow?: number;
  /**
   * TTL for the outbound-message dedup cache (`MessageDedupCache`). Same
   * `(sessionId, content)` within this window is suppressed before reaching
   * the adapter. Defaults to 30s. Set to 0 to disable
   * (`MessageDedupCache`, `dedup.ts`).
   */
  outboundDedupTtlMs?: number;
  /**
   * Durable delivery-obligation ledger (item 9). When present, the covered
   * outbound reply paths record a `pending` obligation BEFORE the platform
   * call and mark it `delivered` only once the adapter CONFIRMS
   * (`DeliveryResult.ok === true`). `sweepPendingDeliveries()` then redelivers
   * anything left `pending` by a crash.
   *
   * Orthogonal to `outboundDedupTtlMs`: the dedup cache stops DOUBLE sends,
   * the ledger stops LOST sends. Absent → today's behavior, no durability.
   *
   * Deliberately NOT a personality concern — no personality may opt out of
   * having its replies delivered.
   */
  deliveryLedger?: DeliveryLedger;
  /**
   * U11 — operator quiet hours (`notifications.*` in config.yaml, resolved by
   * the wiring with an explicit time zone). Inside a bot's window an unprompted
   * notice — `notifyTracked` without `answersInbound`, a background-job wake —
   * is held in `heldNotices` and released by the delivery sweep once the window
   * ends. Absent → nothing is held for quiet hours (`/mute` still applies).
   */
  quietHours?: GatewayQuietHours;
  /**
   * Where held notices wait (`Gateway.noticeHoldReason`). Absent → nothing is
   * ever held: a notice inside quiet hours or a mute is sent at once rather
   * than kept only in memory, where a restart would lose it.
   */
  heldNotices?: HeldNoticeStore;
  /**
   * Period of the delivery-ledger sweep {@link Gateway.startDeliverySweep}
   * arms, so an obligation left `pending` by a transient platform failure is
   * retried on a long-running gateway rather than at the next restart.
   * Default 60s; 0 disables the timer (the boot sweep still runs).
   */
  deliverySweepIntervalMs?: number;
  /**
   * Refused redeliveries after which the sweep abandons an obligation (with
   * the reason recorded and a `gateway.delivery_abandoned` event) instead of
   * retrying it again. Default 10. Retries back off 1m, 2m, 4m … capped at 1h
   * (`deliveryRetryDelayMs`). A refusal the adapter marks `permanent` is
   * abandoned on the first attempt whatever this says.
   */
  deliveryMaxAttempts?: number;
  /**
   * "Does bot `botKey` still speak for `personalityId`?" — the binding re-check
   * {@link Gateway.deliverPublication} runs before it publishes an approved
   * outbox item (O-T5, plan/phases/trust-before-reach.md).
   *
   * botKey-level, not platform-level, on purpose. Cron's check
   * (`createCronDeliver`, `apps/ethos/src/lib/cron-deliver.ts`) asks whether
   * ANY bot on the platform is bound, which is the right question for a send
   * addressed at a platform. A publication names the exact bot that will speak,
   * approved by a human who saw that bot's name on the card; if that bot has
   * since been rebound, a platform-level "yes" would publish in a voice nobody
   * approved.
   *
   * Absent → `deliverPublication` REFUSES every publication rather than
   * assuming the binding still holds. A publication is the one send where
   * guessing costs a post to real people in the wrong agent's name, and an
   * unwired check is a deployment gap, not permission.
   */
  publicationSpeaksFor?: PublicationSpeaksFor;
  /**
   * Durable backstop for the in-memory inbound dedup `Set`
   * (plan/phases/telegram-slack-webhook-mode.md §5). Consulted only when the
   * `Set` misses, so a continuously-running process pays nothing for it.
   *
   * Absent → today's behavior: in-memory only, which a process restart
   * empties. That is the gap webhook mode + scale-to-zero turns from a rare
   * crash-time risk into a routine one.
   */
  inboundDedup?: InboundDedupStore;
  /**
   * Durable inbound spool (plan reach-and-containment §2.2–§2.4): a
   * write-ahead record of every turn this gateway owes. `acceptInbound` writes
   * a `received` row before the durable dedup sighting (see its doc), the lane
   * task marks it `processing` then `done` (drained AND answered), and
   * {@link Gateway.replayInboundSpool} replays what a crash left behind.
   *
   * Absent → today's behavior: a crash between receipt and turn completion
   * loses the message. Deliberately NOT a personality concern.
   */
  inboundSpool?: InboundSpool;
  /** Operator knobs for {@link inboundSpool}. `gateway.inboundSpool.*` in config.yaml. */
  inboundSpoolOptions?: {
    /** Attempts before a row is dead-lettered. Default 3. */
    maxAttempts?: number;
    /** Rows older than this at replay are dead-lettered as `stale`. Default 24h. */
    maxReplayAgeMs?: number;
    /** Claim identity. Default `<pid>:<uuid>` — unique per process. */
    owner?: string;
    /** Periodic replay tick after the first replay, so a requeue takes effect
     *  without a restart. Default 60s; 0 disables. */
    replayIntervalMs?: number;
  };
  /**
   * Maximum number of distinct chats kept in memory. The least-recently-used
   * idle chat is evicted (its lane, session key, personality override, and
   * usage stats are forgotten) once this cap is exceeded. Active in-flight
   * lanes are never evicted. Defaults to 4096.
   */
  maxChats?: number;
  /**
   * Per-platform sender allowlist + pairing + mention-gate + context-visibility
   * config (Chapter 1 agent safety). When absent, all messages are allowed
   * (backward compat). Keys are platform identifiers (e.g. 'telegram').
   */
  channelFilter?: ChannelFilterConfig;
  /**
   * The operator's trusted rooms, `gateway.private_chats.<platform>` (plan
   * personality-memory-boundary D9), keyed on platform + chat id across every
   * bot. Built from config by `buildGateway` (apps/ethos/src/commands/gateway.ts)
   * for both hosts, `ethos gateway start` and `ethos boot`. Read at
   * construction only: a change needs a gateway restart, and until then an
   * unlisted room stays trusted. No filter side effects — unlike a
   * `channel_filter.<platform>` block, it admits and refuses nothing.
   *
   * Read by `Gateway.audienceFor`: a listed room — and every thread in it — is
   * private.
   */
  privateChats?: PrivateChatSet;
  /**
   * Platforms this deployment has put into observe mode, for the startup check
   * below. Build it with `observeModePlatforms(config)` from
   * `@ethosagent/config`; leaving it unset disables the check, never the gate.
   *
   * It exists because observe mode fails SILENTLY without
   * {@link channelTranscript}: `handleMessage`'s observe gate returns whether
   * or not a store is wired, so a deployment that turns on observe mode and
   * forgets the sink discards every watched message while the audit trail
   * still says `channel.observed`. The gate's degrade-to-drop is deliberate —
   * this is only the light that says it is happening.
   */
  observeModePlatforms?: readonly string[];
  /**
   * Context-economy Phase 1 — static per-channel toolset narrowing. Keys are
   * platform identifiers (e.g. 'whatsapp'), values the tool names allowed on
   * that channel. Passed as `RunOptions.toolsetNarrow` on lane turns, so it
   * can only SHRINK the personality toolset (intersect-only at turn-setup) —
   * economy config, never a security boundary. MUST be resolved from static
   * config only: computing it per turn would mutate the tool list and
   * invalidate the prefix cache (plan R1). Platforms without an entry are
   * unaffected.
   */
  channelToolsets?: Record<string, string[]>;
  /**
   * SQLite database used to store pairing codes when `dmPolicy: 'pairing'` is
   * configured. Must be initialised with `initPairingDb(db)` before passing.
   * Required when any platform uses pairing; optional otherwise.
   */
  pairingDb?: Database.Database;
  /**
   * Optional observability adapter for audit events (drops, blocks, context strips).
   */
  observability?: GatewayObservability;
  /**
   * The deployment's public web UI address (`EthosConfig.webBaseUrl`,
   * `ETHOS_PUBLIC_URL` first). Read only to link a lane to the web
   * plugin-credentials page when a turn is refused for a missing plugin
   * credential (`credentialRequiredReply`, ./credential-reply.ts); absent, that
   * reply names the CLI command instead.
   */
  webBaseUrl?: string;
  /**
   * Where observe-mode messages are written. An adapter that stamps
   * `InboundMessage.recordOnly` has already decided this message gets no
   * reply; the gateway's only job is to record it and stop.
   *
   * Absent (tests, standalone, any deployment with no observed chats) → a
   * `recordOnly` message is simply dropped, which is exactly what happened
   * before observe mode existed. Never a crash: the whole feature degrades to
   * today's behaviour by leaving this out.
   */
  channelTranscript?: ChannelTranscriptStore;
  /**
   * The in-app notifications feed the channel digest posts to (R10/R12).
   *
   * A DIRECT sink rather than a `notificationRouter.route()` call, because the
   * router cannot answer the only question that matters here — whether the
   * digest actually landed. `DefaultNotificationRouter.route` returns silently
   * when no adapter is registered for the key, web-api registers adapters only
   * for chat session keys, and a lane key such as `telegram:bot-a:-100` is
   * never one of those. Routing a digest through it therefore reached nothing,
   * indistinguishably from succeeding — and under `deliverTo: 'inApp'` that
   * silence marked the lane consumed and delivered the digest nowhere.
   *
   * Absent (`ethos gateway` standalone, tests) means there is no feed, and
   * `deliverTo: 'inApp'` is refused rather than silently discarded. `ethos
   * boot` supplies `CreateWebApiResult.notifyChannelDigest`.
   *
   * It returns a RECIPIENT COUNT rather than `void`, and that is the whole
   * point of the seam. The feed that actually shipped is an ephemeral
   * multicast to browser sessions connected at that instant, so a nightly
   * digest generated with no tab open reached nobody — while a `void` return
   * read as delivery, advanced the consumption watermark, and discarded the
   * digest permanently. Zero recipients is a FAILURE here; see
   * `Gateway.runChannelDigest`.
   */
  channelDigestFeed?(entry: {
    laneKey: string;
    platform: string;
    chatId: string;
    botKey: string;
    text: string;
  }): ChannelDigestFeedResult | Promise<ChannelDigestFeedResult>;
  /**
   * Optional hook fired after a turn completes with a delivered reply (not
   * aborted, not errored, non-empty response). The caller decides what to do
   * with it — e.g. the CLI gateway command records the W4.1 funnel stamps
   * (`funnel.first_reply` / `funnel.channel_first_reply`) here, keeping
   * funnel emission in the app layer instead of this library.
   */
  onTurnComplete?: (info: { platform: string }) => void;
  /**
   * Optional hook fired when a turn STARTS, carrying the personality the turn
   * resolved to. Team-bound bots resolve no personality and never fire it.
   * The gateway holds no idle policy of its own — this is the activity signal
   * the CLI gateway command feeds to `DreamExecutor.recordUserTurn()`, which
   * owns the idle threshold, the daily cap, and cancelling an in-flight dream
   * when the user comes back. Absent (tests, standalone) → no signal, no
   * dreaming.
   */
  onUserTurn?: (info: { personalityId: string }) => void;
  /**
   * Optional hook called when a sender is approved via `/allow <code>` so the
   * caller can persist the updated allowlist back to config.yaml.
   */
  onAllowlistChange?: (
    platform: string,
    userId: string,
    action: 'add' | 'remove',
  ) => void | Promise<void>;
  /**
   * Optional inbound correlator for the clarify protocol. Runs BEFORE the
   * channel safety filter on every inbound message; when it returns a
   * `ClarifyResponse`, the gateway resolves the pending clarify on the
   * routed bot's `loop.clarifyBridge` and stops further processing (the
   * message was a force-reply / `/cancel`, not a fresh prompt to the agent).
   * Wired by `gateway.ts` from the per-bot `TelegramClarifySurface`'s
   * `correlateMessage`. See plan/phases/tool_clarity_plan.md Surface 4.
   */
  clarifyMessageCorrelator?: (message: InboundMessage) => Promise<ClarifyResponse | null>;
  /**
   * How often (ms) to run the clarify sweep across all bots' bridges. The
   * sweep clears persisted rows whose deadline has passed and notifies
   * surfaces so they can edit timed-out prompts in place. Defaults to 30s
   * per plan. Set to 0 to disable (tests).
   */
  clarifySweepIntervalMs?: number;
  /**
   * §4.6 rung 3 — how long a PRESENTED background-job question may go
   * unanswered before a "needs you" notice is pushed to the run's origin lane.
   * Defaults to 60s per the escalation ladder. Set to 0 to disable the push
   * entirely (the question still lives its normal life; only the nudge stops).
   */
  clarifyEscalationDelayMs?: number;
  /**
   * Optional card reader for `/personality rich`. When set, the gateway
   * renders a character-sheet card for the bound personality. Slack handles
   * this in its own slash handler; Telegram routes through the gateway, so
   * the reader is wired here.
   */
  personalityCardReader?: {
    read(personalityId: string): Promise<{ text: string } | null>;
  };
  /**
   * Optional greeting provider for `/start`. Returns a personality-aware
   * greeting string. When absent, `/start` returns a generic message.
   */
  greetingProvider?: {
    greet(personalityId: string): Promise<string>;
  };
  /**
   * Optional personality-directory seam for hot-reload. The gateway extension
   * holds no registry — this seam lets the app layer inject refresh + read
   * closures over every loop registry it built. `refresh()` re-loads ALL loop
   * registries in this process from disk (cheap — mtime-fingerprint cache);
   * `has()` / `list()` read the system loop's registry. Absent (tests,
   * standalone) → no refresh, legacy hardcoded `/personality list`.
   */
  personalityDirectory?: {
    refresh(): Promise<void>;
    has(id: string): boolean;
    list(): Array<{ id: string; name: string; isDefault: boolean }>;
    /**
     * The personality's `voice` block, when it declares one. Optional so the
     * seam stays backwards-compatible; absent → channel TTS falls back to the
     * global `auxiliary.tts.voice`, which is what every deployment did before
     * per-personality voice existed. Read AFTER `refresh()`, so an edited
     * `voice.tts_voice` takes effect on the next spoken reply without a
     * restart, exactly like the rest of the directory.
     */
    voice?(id: string): PersonalityVoiceConfig | undefined;
    /**
     * The personality's display identity — its `name` and `display.emoji` —
     * for the channel presence (`Gateway.presenceFor`): the reply prefix, the
     * receipt reaction and mention-by-name. Optional; absent → the presence
     * names the personality by its id and has no emoji.
     */
    identity?(id: string): ChannelPresence | undefined;
  };
  /**
   * Optional attachment cache for cleaning up cached files on session reset
   * (`/new`) and lane eviction. When absent, no cleanup is performed.
   */
  attachmentCache?: AttachmentCache;
  /**
   * Storage used to read cached attachment bytes — today only for transcribing
   * inbound voice notes, which need the audio itself and not just its path —
   * and, with `dataDir`, to persist the channel digest's per-lane watermarks.
   * Absent (with `attachmentCache` present) means audio attachments still land
   * as `(voice message)`; they are simply not transcribed.
   */
  storage?: Storage;
  /**
   * Absolute `~/.ethos/`. Needed with `storage` to place gateway-owned state
   * files — today only the channel digest's watermarks. `Storage` does not root
   * relative paths, so without this the digest keeps no watermark and falls
   * back to its fixed look-back window.
   */
  dataDir?: string;
  /**
   * Opens the session store `/fork`, `/branches` and `/branch <n>` read and
   * write (the same `sessions.db` the bots' loops use). Called only when one of
   * those commands runs, so a gateway nobody forks in never opens it; the host
   * owns and closes what it returns. Absent → the commands answer that
   * branches are unavailable.
   */
  sessionStore?: () => SessionStore;
  /**
   * One bot's USD spend since `since`, split by {@link BotSpend} — how
   * `Gateway.enqueueTurn` (replies) and `Gateway.backgroundGate` (background
   * calls) read the bot's spend today against its `GatewayBotConfig.budget`. `sessionKeyPrefix` names the bot's lane
   * sessions; `botKey` names its ledger rows, which may carry no session key at
   * all (a memory-capture job). The production host (`botSpendSince` in
   * apps/ethos/src/commands/gateway.ts) reads message rows with
   * `usageAggregate` and ledger rows with `SQLiteUsageLedger.spendSince`.
   * Absent → no daily cap is enforced, whatever the bots say.
   */
  botSpendSince?: (
    scope: { sessionKeyPrefix: string; botKey: string },
    since: Date,
  ) => Promise<BotSpend>;
  /** STT provider registry for resolving voice transcription providers by name. */
  sttProviderRegistry?: SttProviderRegistry;
  /** Name of the STT provider to use (from auxiliary.asr.provider in config). */
  sttProviderName?: string;
  /** TTS provider registry for resolving voice synthesis providers by name. */
  ttsProviderRegistry?: TtsProviderRegistry;
  /** Name of the TTS provider to use (from auxiliary.tts.provider in config). */
  ttsProviderName?: string;
  /** Config dict passed to STT provider factory (apiKey, model, etc.). */
  sttProviderConfig?: Record<string, unknown>;
  /** Config dict passed to TTS provider factory (apiKey, model, voice, etc.). */
  ttsProviderConfig?: Record<string, unknown>;
  /**
   * `voice.stt.providers.*` / `voice.tts.providers.*` — the NAMED rosters a
   * personality's `voice.stt_provider` / `voice.tts_provider` picks from.
   *
   * Absent → every personality gets the single `sttProviderName` /
   * `ttsProviderName` default, which is what every deployment did before
   * per-personality providers reached channel replies. The roster KEY is a
   * label the operator typed and is never what the egress gate keys on: the
   * shared resolver gates on the selected entry's `provider` and the
   * constructed provider's `caps.local`, so naming a cloud entry
   * `local-anything` cannot walk it past a local-only gate.
   */
  sttProviderRoster?: Readonly<Record<string, SttProviderEntry>>;
  ttsProviderRoster?: Readonly<Record<string, TtsProviderEntry>>;
  /** Secrets resolver for voice provider factories. */
  voiceSecretsResolver?: import('@ethosagent/types').SecretsResolver;
  /** Default voice mode: 'off' | 'mirror_inbound' | 'all'. Default 'mirror_inbound'. */
  defaultVoiceMode?: VoiceMode;
  /**
   * Persisted per-lane voice mode. Absent → an in-memory store seeded with
   * `defaultVoiceMode`, which is exactly the behaviour of the Map this
   * replaced: modes live for the life of the process and no further.
   */
  voiceModeStore?: LaneVoiceModeStore;
  /**
   * Synthesized-audio store. Absent → artifacts are not persisted and a failed
   * voice send cannot be redelivered (the obligation still records, so the loss
   * is visible rather than silent).
   */
  voiceArtifacts?: VoiceArtifactStore;
  /**
   * ffmpeg stage. Absent → no transcode: a synthesized format the adapter does
   * not accept is SKIPPED rather than sent wrong. Sending mp3 bytes to a sink
   * that declared opus is how audio arrives as an undownloadable document.
   */
  transcoder?: Transcoder;
  /**
   * `voice.channels.<platform>.ttsOut`. An explicit `false` silences that
   * platform regardless of lane mode — an operator decision outranks a
   * conversational one. A platform absent here inherits the lane's mode.
   */
  channelVoiceOut?: Readonly<Record<string, boolean>>;
  /** Transcode bitrate (`voice.transcode.bitrateKbps`). */
  voiceBitrateKbps?: number;
  /** Adapter lookup for agent-initiated outbound sends (send_message tool). */
  adapters?: Map<string, PlatformAdapter>;
  /**
   * The adapters `adapters` above cannot carry, keyed by the botKey each one
   * serves. `adapters` is keyed by PLATFORM and holds only the first adapter
   * per platform, so in a multi-bot-per-platform deployment the second and
   * later adapters have nowhere else to arrive.
   *
   * NOT a duplicate of `adapters`: the gateway recovers every adapter it is
   * given there on its own (each value names its bot in `adapter.id`), so this
   * only has to carry the ones a platform-keyed map physically cannot hold.
   * Absent → `listAdapters()` reports every adapter the constructor received
   * plus every hot-added one.
   */
  botAdapters?: ReadonlyMap<string, PlatformAdapter>;
  /** Plugin-contributed adapter factories. The gateway instantiates and starts
   *  each one, creating a ChannelContext that routes inbound messages through
   *  the standard handleMessage pipeline with auto-stamped botKey. */
  pluginAdapters?: Map<string, PlatformAdapterFactory>;
  /** Allowlist of plugin adapter IDs that are trusted to route. Channel
   *  adapters are high-privilege (they broker external I/O) and are
   *  default-deny — only IDs in this list will be started. When undefined
   *  (not set), all plugin adapters are allowed (backward compat / dev mode).
   *  When set (even to an empty Set), only listed IDs are started. */
  trustedChannelPlugins?: Set<string>;
  /** Trusted voice provider plugin IDs. Non-local STT/TTS providers must be
   *  in this set to be activated. Local providers (caps.local=true) are exempt. */
  trustedVoicePlugins?: ReadonlySet<string>;
  /** Resolves (platform, platformUserId) -> internal userId for per-user profiles. */
  resolveUserId?: (
    platform: string,
    platformUserId: string,
    displayLabel?: string,
  ) => Promise<string>;
  /** Plugin loader for dispatching plugin-registered slash commands. */
  pluginLoader?: {
    getSlashHandler(
      name: string,
    ):
      | ((args: string, ctx: import('@ethosagent/types').SlashCommandContext) => Promise<string>)
      | undefined;
    getAllSlashCommands(): { name: string; description: string; usage: string }[];
  };
  /** Notification router for delivering process completion alerts to channels. */
  notificationRouter?: import('@ethosagent/types').NotificationRouter;
  /**
   * Streaming draft-edit config (W3.1). When enabled for a chat and the
   * adapter can edit messages, a turn's reply is delivered as throttled
   * `editMessage` updates that grow in place (the first throttled chunk is the
   * first message — there is NO turn-start placeholder). Sourced from
   * `display.streaming_edits` in `~/.ethos/config.yaml` (NOT PersonalityConfig,
   * which is frozen). Defaults: DMs on, group chats off, since draft edits
   * multiply API calls per turn.
   */
  streamingEdits?: { dm?: boolean; group?: boolean };
  /**
   * Minimum ms between successive draft edits (the first send is never
   * throttled). Defaults to 2500 (~1 edit / 2.5s). Set to 0 in tests to flush
   * every chunk.
   */
  streamingEditIntervalMs?: number;
  /**
   * H1 (plan ux-feedback-and-config-clarity, UD3) — ms of silence on a
   * NON-streaming lane before the one untracked "_working on it …_" ack.
   * Sourced from `display.slow_turn_notice_ms` (`EthosConfig.
   * displaySlowTurnNoticeMs`, wired in `buildGateway`). Absent → 8000; `0`
   * disables the notice — and with it H2's non-streaming fallback message,
   * which shares the same once-per-turn latch (see ./turn-feedback.ts).
   * Email lanes never get it (UD9). Pinned by
   * `__tests__/slow-turn-notice.test.ts`.
   */
  slowTurnNoticeMs?: number;
  /**
   * V2-RT-3 — ms a mid-turn voice note's transcription may take while it is
   * being built into a steer. Every later message on the lane waits behind it
   * in the steer order (`steerOrder`), and STT is called without a deadline,
   * so a hung provider would hold the whole lane. On expiry the voice note is
   * steered as its placeholder text, and the transcription is recorded as
   * `gateway.steer_transcription_timeout`. Absent → 60000. Pinned by
   * `__tests__/steer-mid-turn.test.ts` ('a hung STT').
   */
  steerTranscribeTimeoutMs?: number;
}
