import { randomUUID } from 'node:crypto';
import type { ChannelPresence, ChannelPresenceResolver } from '@ethosagent/core';
import {
  buildLaneKey,
  type ClarifyNoticeTarget,
  DEFAULT_ESCALATION_DELAY_MS,
  deriveBotKey,
  forkSession,
  forkSessionKey,
  haltNotice,
  isIncognitoSession,
  LaneVoiceModeStore,
  listBranches,
  MAX_TOKENS_REPLY_NOTICE,
  type PrivateChatSet,
  sweepClarifyEscalations as runClarifyEscalationSweep,
  type SttProviderForPersonality,
  stripAnsiEscapes,
  type TtsProviderForPersonality,
} from '@ethosagent/core';
import type { DeliveryLedger, DeliveryObligation } from '@ethosagent/delivery-ledger';
import type { InboundDedupStore } from '@ethosagent/inbound-dedup';
import type { InboundSpool, SpoolRow } from '@ethosagent/inbound-spool';
import { isJobRef } from '@ethosagent/job-runner';
import type { ChannelFilterConfig } from '@ethosagent/safety-channel';
import {
  checkMessage,
  claimDeclineSlot,
  consumeAndAllow,
  getApprovedSenders,
  isSenderAllowed,
  revokeApproval,
} from '@ethosagent/safety-channel';
import { shortPatternCheck, wrapUntrusted } from '@ethosagent/safety-injection';
import { redactPii } from '@ethosagent/safety-redact';
import type { SessionLane } from '@ethosagent/session-lane';
import type Database from '@ethosagent/sqlite';
import {
  createEventTranslator,
  describeChatError,
  formatBranchList,
  pickBranch,
  shouldSurfaceProgress,
} from '@ethosagent/surface-kit';
import type {
  AttachmentCache,
  BackgroundJob,
  ChannelContext,
  ChannelTranscriptStore,
  ClarifyResponse,
  DeliveryResult,
  InboundMessage,
  InitiativeDigest,
  OutboundMessage,
  PersonalityVoiceConfig,
  PlatformAdapter,
  SessionStore,
  SteerEntry,
  Storage,
  SttProviderEntry,
  SttProviderRegistry,
  TtsProviderEntry,
  TtsProviderRegistry,
  TurnAudience,
  UsageGateRequest,
  UsageGateVerdict,
  VoiceTurnOrigin,
} from '@ethosagent/types';
import { answerSuffix, resolveModelDisplay } from '@ethosagent/types';
import {
  DEFAULT_VOICE_MODE,
  detectLanguage,
  shouldReplyWithVoice,
  type VoiceMode,
} from '@ethosagent/voice-text';
import { GatewayAudience } from './audience';
import { handleBudgetCommand } from './budget-command';
import {
  CHANNEL_DIGEST_LOCK_FILE,
  CHANNEL_DIGEST_WATERMARK_FILE,
  type ChannelDigestReport,
  type ChannelDigestSettings,
  runChannelDigest,
} from './channel-digest';
import { credentialRequiredReply } from './credential-reply';
import { DailySpend } from './daily-spend';
import { MessageDedupCache } from './dedup';
import { beginDelivery, confirmDelivery, type DeliveryBinding, endDelivery } from './delivery';
import { DeliveryLedgerSweep } from './delivery-ledger-sweep';
import type {
  BotSpend,
  GatewayBotConfig,
  GatewayConfig,
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
} from './gateway-config';
import {
  ABORT_GRACE_MS,
  ABSORBED_STEER_ACK,
  adapterHandle,
  BACKGROUND_MAX_JOBS_PER_ROOT,
  botKeyOfAdapterId,
  botKeyOfLaneKey,
  CHANNEL_EXCLUDED_TOOLS,
  CLARIFY_ESCALATION_POLL_MS,
  commandForThisBot,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DELIVERY_DEFAULT_MAX_ATTEMPTS,
  DELIVERY_SWEEP_DEFAULT_INTERVAL_MS,
  dailyCapNotice,
  EMPTY_COMPLETION_CODE,
  EMPTY_REPLY_NOTICE,
  emptyCompletionNotice,
  INCOGNITO_REFUSED_TEXT,
  initiatorFor,
  isClarifySurfaceType,
  isRetryText,
  LEARN_SHARED_ROOM_REPLY,
  laneKeyOf,
  mcpSettlementText,
  NOT_INCOGNITO_BRANCH_TEXT,
  noopLogger,
  PLATFORM_COMMANDS,
  platformOfAdapterId,
  queuedTurnAck,
  REVIEW_TURN_PREAMBLE,
  replyDedupScope,
  SPOOL_DEFAULT_MAX_ATTEMPTS,
  SPOOL_DEFAULT_MAX_REPLAY_AGE_MS,
  SPOOL_DEFAULT_REPLAY_INTERVAL_MS,
  type SpoolTurnState,
  type SpoolTurnTarget,
  type SteerOrigin,
  SYSTEM_BUSY_MESSAGE,
  senderIsOwner,
  serializeInbound,
  servedBotKey,
  spoolMessageId,
  type TurnAudienceOptions,
  TurnSemaphore,
  transcriptTimestamp,
  type WakeReview,
} from './gateway-pure';
import { isInitiativeCardAdapter } from './initiative-card';
import { activeLaneJobSummary, parseJobCommand, runJobCommand, stopJobByRef } from './job-commands';
import { LaneManager } from './lane-manager';
import { LaneSessionFiles } from './lane-sessions';
import type { McpLoginPort } from './mcp-login-port';
import { handleMuteCommand } from './mute-command';
import { OutboundSend } from './outbound-send';
import { type GatewayQuietHours, inQuietHours, quietWindowFor } from './quiet-hours';
import { applyReplyPrefix } from './reply-prefix';
import { RoomGateway } from './room-gateway';
import { answerWithCapNotice, shouldSuppressSilentReply } from './silent-reply';
import { SpoolReplay } from './spool-replay';
import { SpoolTurns } from './spool-turns';
import { createSteerSink, type GatewaySteerSink } from './steer-sink';
import { DraftStreamer } from './streaming';
import type { Transcoder } from './transcode';
import { TurnFeedback } from './turn-feedback';
import type { VoiceArtifactStore } from './voice-artifacts';
import { hasAudioAttachments } from './voice-pipeline';
import { VoiceReply } from './voice-reply';
import { WakeReviews } from './wake-review';

export { SessionLane } from '@ethosagent/session-lane';
export {
  buildDigestPrompt,
  type ChannelDigestBot,
  type ChannelDigestDeps,
  type ChannelDigestReport,
  type ChannelDigestSettings,
  formatDigest,
  runChannelDigest,
  summarizeChannelDigest,
} from './channel-digest';
export { MessageDedupCache } from './dedup';
export { beginDelivery, confirmDelivery, type DeliveryBinding, endDelivery } from './delivery';
export { DreamExecutor } from './dream-executor';
export type {
  BotSpend,
  ChannelDigestFeedResult,
  GatewayBotConfig,
  GatewayConfig,
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
} from './gateway-config';
export {
  ABSORBED_STEER_ACK,
  ATTACHMENT_NOT_RECOVERED_NOTE,
  adapterRegistries,
  CHANNEL_EXCLUDED_TOOLS,
  deadLetteredNotice,
  EMPTY_REPLY_NOTICE,
  INTERRUPTED_RETRY_NOTICE,
  LEARN_SHARED_ROOM_REPLY,
  PLATFORM_COMMANDS,
  queuedTurnAck,
  transcriptTimestamp,
  VOICE_FAILURE_NOTICE,
} from './gateway-pure';
export type { McpLoginPort, McpLoginSettlement, McpLoginStart } from './mcp-login-port';
export {
  attachmentsFromStructured,
  decodeDataUrl,
  isOutboundMediaSource,
  OUTBOUND_MEDIA_MAX_BYTES,
  type OutboundMediaCaps,
  type OutboundMediaSource,
} from './media';
export {
  type GatewayQuietHours,
  inQuietHours,
  MAX_MUTE_MS,
  minuteOfDay,
  parseMuteDuration,
  type QuietHoursWindow,
  quietWindowFor,
} from './quiet-hours';
export * from './room-exports';
export {
  closeUnbalancedMarkup,
  DraftStreamer,
  parseRetryAfterSeconds,
  type StreamAdapter,
} from './streaming';
export {
  createFfmpegTranscoder,
  type FfmpegTranscoderOptions,
  type TranscodeRequest,
  type TranscodeResult,
  type Transcoder,
  type TranscodeStageEvent,
} from './transcode';
export {
  createVoiceArtifactStore,
  type VoiceArtifactStore,
  type VoiceArtifactStoreOptions,
} from './voice-artifacts';
export { type CapturingAdapter, createCapturingAdapter } from './webhook-adapter';
export { type DeliveryTargetConfig, type RelayResult, relayToTargets } from './webhook-relay';

/**
 * How long `shutdown()` waits for the turns it aborted to unwind — drained
 * turn-end tails included — before returning anyway. The same budget as
 * `DISPOSE_BEFORE_EXIT_GRACE_MS` (apps/ethos/src/lib/dispose-before-exit.ts),
 * which is what the callers spend next disposing each bot's loop: a turn still
 * running when its loop is disposed is working against a torn-down runtime.
 * `AgentLoop` promises no deadline for observing an abort, so the wait is
 * bounded rather than exact. Overridable per call (`shutdown({ drainTimeoutMs })`).
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

/**
 * What `Gateway.notifyTrackedOutcome` reports. `owed` is an unconfirmed send whose `pending` ledger
 * row is durable, so the delivery sweep re-sends it and the caller must not retry; `failed` wrote
 * nothing durable (refused, no ledger, or the ledger write failed).
 */
export type NotifyOutcome = 'confirmed' | 'held' | 'owed' | 'failed';

export class Gateway {
  /** Bot routing table keyed by `botKey`. Mutable so `addAdapter` /
   *  `removeAdapter` can reconcile a live config change (Phase A of
   *  plan/phases/gateway-live-reload.md) without a process restart. */
  private bots: Map<string, GatewayBotConfig>;
  private readonly webBaseUrl: string | undefined;
  /** The botKey used when `InboundMessage.botKey` is absent (single-bot
   *  deployments). When the config supplies multiple bots, this is null
   *  and a message without `botKey` is treated as an unknown route.
   *  Recomputed by `addAdapter`/`removeAdapter`: hot-adding a second bot
   *  turns a single-bot deployment into a multi-bot one, and a stale
   *  default would keep routing unstamped messages to the first bot. */
  private defaultBotKey: string | null;
  /**
   * Bots whose `removeAdapter` has started but whose existing work is still
   * draining.
   *
   * A retiring bot keeps its routing-table entry and its loop wiring for the
   * whole drain — work accepted under that infrastructure has to RUN under it
   * — so "stop accepting" cannot be expressed by deleting the entry. This set
   * is that gate: `handleMessage` refuses new inbound for a retiring botKey
   * while everything already queued keeps resolving normally.
   */
  private readonly retiringBots = new Set<string>();
  /**
   * Set at the very start of `shutdown()` and never cleared: from then on
   * `handleMessage` starts no turn and pushes into no steer sink (see
   * `refuseWhileClosing`). Adapters keep delivering until the callers stop
   * them, AFTER `shutdown()` returns, so without this an inbound during the
   * drain started a turn on a loop about to be disposed, or was "↩ noted" into
   * an aborted turn nobody reads. `notify` is shutdown's own resend text.
   * Distinct from `retiringBots`, which gates one bot during `removeAdapter`.
   */
  private closing: { notify?: string } | null = null;
  private readonly lanes = new Map<string, SessionLane>();
  /**
   * Effective session key per lane (allows /new, /fork and /branch to move a
   * lane off its default session). Persisted per bot through `laneFiles`
   * (D28) and restored by `restoreLaneSessions` before any turn can run.
   */
  private readonly sessionKeys = new Map<string, string>();
  /** The durable copy of `sessionKeys`; absent without `storage` + `dataDir`. */
  private readonly laneFiles: LaneSessionFiles | undefined;
  /**
   * A bot added live (`addBot`) whose lane file is still being read. Every
   * reader and writer of that bot's `sessionKeys` awaits it first
   * (`pendingLaneRestore`): `dispatchInbound` before the retry/slash-command
   * paths, `runTurn` before it resolves the session, `persistLaneSessions`
   * before it rewrites the file — so neither a turn (a spool replay or a
   * `wake_review` included) nor a `/new` can run on, or overwrite, lanes the
   * file already held. Entries delete themselves once settled.
   */
  private readonly laneRestores = new Map<string, Promise<void>>();
  /** See `GatewayConfig.sessionStore`. */
  private readonly sessionStoreFor: (() => SessionStore) | undefined;
  /** See `GatewayConfig.botSpendSince`. */
  private readonly botSpendSince: GatewayConfig['botSpendSince'];
  /** Today's spend per bot (`dailySpendKey`), read through `botSpendSince` at
   *  most once per `DAILY_SPEND_REFRESH_MS` and advanced in between by the
   *  `usage` events this process's own turns yield (`addDailySpend`). */
  private readonly dailySpend = new Map<string, { day: string; spend: BotSpend; readAt: number }>();
  /** Per-lane active personality (overrideable via /personality). */
  private readonly personalityIds = new Map<string, string>();
  /** Per-lane usage accumulator. */
  private readonly usageStore = new Map<
    string,
    { inputTokens: number; outputTokens: number; costUsd: number }
  >();
  /** Bounded LRU of recently-seen inbound-message keys. */
  private readonly seenMessages = new Set<string>();
  private readonly dedupWindow: number;
  /** Durable dedup backstop. Absent → in-memory only. */
  private readonly inboundDedup: InboundDedupStore | undefined;
  private readonly inboundSpool: InboundSpool | undefined;
  private readonly spoolOwner: string;
  private readonly spoolMaxAttempts: number;
  private readonly spoolMaxReplayAgeMs: number;
  private readonly spoolReplayIntervalMs: number;
  /** True while `replayInboundSpool` is queueing rows: a live message is then
   *  spooled unclaimed and left for the replay's re-list (plan D2-5). */
  private replaying = false;
  private replayInFlight: Promise<{ replayed: number; deferred: number; dead: number }> | undefined;
  private spoolReplayTimer: ReturnType<typeof setInterval> | undefined;
  private orphansRecovered = false;
  private readonly deliverySweepIntervalMs: number;
  private readonly deliveryMaxAttempts: number;
  private deliverySweepTimer: ReturnType<typeof setInterval> | undefined;
  /** The sweep running now, shared by every caller so two never overlap. */
  private deliverySweepInFlight: Promise<{ redelivered: number; failed: number }> | undefined;
  /** Spool bookkeeping for the turn running on each lane (steer absorption). */
  private readonly spoolTurns = new Map<string, SpoolTurnState>();
  /**
   * Lanes that may hold an `interrupted` spool row waiting on `retry` (plan
   * D5). Only a GATE for the durable lookup (`findInterrupted`) — so a lane
   * with nothing interrupted pays no SQLite read per message. Seeded from the
   * spool by the first replay; a stale entry just costs one read, then goes.
   */
  private readonly interruptedLanes = new Set<string>();
  /** Outbound-message dedup cache. Suppresses `(sessionId, content)` within TTL. */
  private readonly outboundDedup: MessageDedupCache;
  /**
   * UBP-014 — the gateway-assigned inbound id of a message that has neither a
   * spool row nor a platform `messageId` (`replyDedupScope`). Keyed on the
   * message object, so the hook-claim path and the turn path of one message
   * read the same id; a new message object is a new inbound message.
   */
  private readonly localInboundIds = new WeakMap<InboundMessage, string>();
  private localInboundSeq = 0;
  /** `sendThrough` sends in flight, by target + body: a concurrent identical
   *  send awaits the first one's outcome instead of reporting success for a
   *  send that may yet fail (V-GC-1). */
  private readonly inFlightSends = new Map<string, Promise<{ ok: boolean; error?: string }>>();
  /** Durable delivery-obligation ledger (item 9). Absent → no durability. */
  private readonly deliveryLedger: DeliveryLedger | undefined;
  /** See `GatewayConfig.quietHours` / `heldNotices` (U11). */
  private readonly quietHours: GatewayQuietHours | undefined;
  private readonly heldNotices: HeldNoticeStore | undefined;
  /** Per-lane `/mute` expiry (epoch ms), persisted beside the lane's session
   *  key in its lane file (`LaneSessionEntry.mutedUntil`). */
  private readonly laneMutes = new Map<string, number>();
  /** Lanes running incognito (plan incognito-sessions D5/D6/§7.2). Keyed by lane,
   *  so `/personality` (which rotates the session key) keeps membership. Persisted
   *  beside the lane's session key (`LaneSessionEntry.incognito`) and read by
   *  `runTurn`, so a restart or a spool replay still runs the message incognito. */
  private readonly incognitoLanes = new Set<string>();
  /**
   * `deliver: 'parent'` reviews waiting out a hold (U11), by job id. Not
   * persisted: a parked job's delivery claim is never taken, so after a restart
   * `sweepUndeliveredJobs` re-owes it. See {@link admitWakeReview}.
   */
  private readonly parkedReviews = new Map<
    string,
    { bot: GatewayBotConfig; job: BackgroundJob; laneKey: string }
  >();
  /** Binding re-check for {@link deliverPublication}. Absent → it refuses. */
  private readonly publicationSpeaksFor: PublicationSpeaksFor | undefined;
  /** Accumulated host-pause duration discounted from the stale-obligation
   *  abandon window. See `applyPauseOffset`. */
  private pauseOffsetMs = 0;
  /** Streaming draft edits enabled for DMs / group chats (W3.1). */
  private readonly streamingDm: boolean;
  private readonly streamingGroup: boolean;
  /** Minimum ms between draft edits. */
  private readonly streamingEditIntervalMs: number;
  /** See `GatewayConfig.slowTurnNoticeMs` (H1). 0 = disabled. */
  private readonly slowTurnNoticeMs: number;
  /** See `GatewayConfig.steerTranscribeTimeoutMs` (V2-RT-3). */
  private readonly steerTranscribeTimeoutMs: number;
  /** Chats (`${platform}:${chatId}`) where streaming was disabled after
   *  repeated flood-waits — future turns there fall back to non-streaming. */
  private readonly streamingDisabledChats = new Set<string>();
  /** Active turns by laneKey — used by graceful shutdown to notify users.
   *  `answered` flips once the turn's TEXT final (or the error note standing
   *  in for it) is confirmed delivered — before any voice note (`markAnswered`
   *  in `runTurn`); shutdown's resend notice skips those. */
  private readonly activeTurns = new Map<
    string,
    { adapter: PlatformAdapter; chatId: string; threadId?: string; answered?: boolean }
  >();
  /** Active steer sinks by laneKey — inbound messages during a turn push here. */
  private readonly activeSinks = new Map<string, GatewaySteerSink<SteerOrigin>>();
  /**
   * V-GC-4 — per lane, the settle of the last mid-turn message still building
   * its steer (a voice note's STT, attachment reads). A later message on the
   * lane waits for it before it pushes or enqueues, so a quick text never
   * overtakes a voice note sent before it. A voice note's STT is bounded by
   * `steerTranscribeTimeoutMs`, so a hung provider cannot hold the lane
   * (V2-RT-3). Pinned by `__tests__/steer-mid-turn.test.ts` ('arrival order',
   * 'a hung STT').
   */
  private readonly steerOrder = new Map<string, Promise<void>>();
  /**
   * V-GC-4 — one transcription per inbound voice note, by message and text. A
   * mid-turn voice note is transcribed to become a steer; if the turn ended
   * meanwhile it runs as its own turn, and `runTurn` reuses this result
   * instead of paying for STT twice. Weak, so it lives as long as the message.
   */
  private readonly voiceTranscripts = new WeakMap<
    InboundMessage,
    Map<string, Promise<{ text: string; providerId: string | undefined }>>
  >();
  /** Buffered notifications for sessions whose turn has ended. */
  private readonly unreadNotifications = new Map<string, string[]>();
  /**
   * Routing for an in-flight turn, keyed by `sessionKey`. Populated when the
   * turn is enqueued (where `adapter`, `chatId`, and `threadId` are all in
   * scope) and consumed by the `session_start` hook below, which is the only
   * place `sessionId` becomes known. `activeTurns` is keyed by `laneKey`,
   * not `sessionKey`, so it can't serve this — hence a parallel map.
   */
  private readonly sessionRouting = new Map<string, SessionRouting>();
  /**
   * `sessionId → routing` — the bridge a `before_tool_call` approval hook
   * needs. The hook only has `sessionId`; the adapter/chat/thread live on the
   * inbound message. The gateway is the one component that knows both halves,
   * so it owns the mapping. Populated by the `session_start` hook (which
   * carries both ids), cleared when the turn ends.
   */
  private readonly approvalRoutes = new Map<string, SessionRouting>();
  /**
   * `sessionKey → sessionId`, recorded by the `session_start` hook. The
   * gateway never computes `sessionId` itself (the AgentLoop does), so this
   * is how turn-end cleanup — which only knows `sessionKey` — finds the
   * `approvalRoutes` entry to evict.
   */
  private readonly sessionIdByKey = new Map<string, string>();
  /** Told when a user's `/stop` aborts a lane (UBP-046, see `onLaneStop`). */
  private readonly laneStopListeners = new Set<(stop: LaneStop) => void>();
  private readonly maxChats: number;
  /** Optional clarify correlator — see GatewayConfig.clarifyMessageCorrelator. */
  private readonly clarifyCorrelator:
    | ((message: InboundMessage) => Promise<ClarifyResponse | null>)
    | undefined;
  /** Live timer running the periodic clarify sweep, cleared on shutdown. */
  private clarifySweepTimer: ReturnType<typeof setInterval> | undefined;
  /** §4.6 rung 3 — timer running the unanswered-question escalation sweep. */
  private clarifyEscalationTimer: ReturnType<typeof setInterval> | undefined;
  private readonly clarifyEscalationDelayMs: number;
  /** Chapter 1 safety: per-platform sender allowlist + pairing config.
   *  Not `readonly` — Phase B of plan/phases/gateway-live-reload.md replaces
   *  it live. No setter ships until that phase's fail-closed-per-adapter
   *  redesign is signed off. */
  private channelFilter: ChannelFilterConfig | undefined;
  /** `GatewayConfig.privateChats`, fixed at construction (restart to change). */
  private readonly privateChats: PrivateChatSet | undefined;
  /** Static per-channel toolset narrowing (platform → allowed tool names). */
  private readonly channelToolsets: Record<string, string[]> | undefined;
  /** Per-room prompt/policy collaborator (room-gateway.ts); owns the policy table and lane notes. */
  private readonly rooms: RoomGateway;
  /** SQLite DB for pairing codes. */
  private readonly pairingDb: Database.Database | undefined;
  /** Observability adapter for audit events. */
  private readonly observability: GatewayObservability | undefined;
  private readonly channelTranscript: ChannelTranscriptStore | undefined;
  private readonly channelDigestFeed: GatewayConfig['channelDigestFeed'];
  /** Hook fired after a turn completes with a delivered reply. */
  private readonly onTurnComplete: ((info: { platform: string }) => void) | undefined;
  /** Hook fired at turn start with the resolved personality (activity signal). */
  private readonly onUserTurn: ((info: { personalityId: string }) => void) | undefined;
  /** Global limiter on simultaneous turns (`maxConcurrentSessions` quota). */
  private readonly concurrency: TurnSemaphore;
  /** Per-lane queue cap — beyond this, saturated lanes get a busy rejection. */
  private readonly maxLaneQueue: number;
  /** Hook called when the allowlist changes via /allow or /deny. */
  private readonly onAllowlistChange:
    | ((platform: string, userId: string, action: 'add' | 'remove') => void | Promise<void>)
    | undefined;
  /** Optional card reader for `/personality rich`. */
  private readonly personalityCardReader:
    | { read(personalityId: string): Promise<{ text: string } | null> }
    | undefined;
  /** Optional greeting provider for `/start`. */
  private readonly greetingProvider: { greet(personalityId: string): Promise<string> } | undefined;
  /** Optional personality-directory seam for hot-reload (refresh + read). */
  private readonly personalityDirectory: GatewayConfig['personalityDirectory'];
  private readonly mcpLoginFor: GatewayConfig['mcpLoginFor'];
  /** The pending `/mcp login` flow per lane: id plus the port that owns it. Cleared on settlement. */
  private readonly mcpFlows = new Map<string, { flowId: string; port: McpLoginPort }>();
  /** Optional attachment cache for cleanup on /new and lane eviction. */
  private readonly attachmentCache: AttachmentCache | undefined;
  /** Optional storage for reading cached attachment bytes (voice-note STT). */
  private readonly storage: Storage | undefined;
  /** Absolute `~/.ethos/`, for gateway-owned state files. See GatewayConfig. */
  private readonly dataDir: string | undefined;
  /** STT provider registry for resolving voice transcription providers by name. */
  private readonly sttProviderRegistry: SttProviderRegistry | undefined;
  /** Name of the STT provider to use (from auxiliary.asr.provider in config). */
  private readonly sttProviderName: string | undefined;
  /**
   * Resolved STT providers, ONE PER ROSTER ENTRY — not one per gateway.
   *
   * A single memoized provider is what made `voice.stt_provider` a
   * browser-talk-mode-only setting: whichever personality spoke first bound the
   * whole process. The key is the selected roster entry (or the default
   * entry), so two personalities naming the same entry still share one
   * constructed provider, and the promise is memoized rather than the settled
   * value so two concurrent turns cannot race into two factory calls.
   */
  private readonly sttProviders = new Map<string, Promise<SttProviderForPersonality>>();
  /** TTS provider registry for resolving voice synthesis providers by name. */
  private readonly ttsProviderRegistry: TtsProviderRegistry | undefined;
  /** Name of the TTS provider to use (from auxiliary.tts.provider in config). */
  private readonly ttsProviderName: string | undefined;
  /** Resolved TTS providers, one per roster entry. See {@link sttProviders}. */
  private readonly ttsProviders = new Map<string, Promise<TtsProviderForPersonality>>();
  /** Config dict passed to STT provider factory. */
  private readonly sttProviderConfig: Record<string, unknown>;
  /** Config dict passed to TTS provider factory. */
  private readonly ttsProviderConfig: Record<string, unknown>;
  /** `voice.stt.providers.*` — the named roster a personality can pick from. */
  private readonly sttProviderRoster: Readonly<Record<string, SttProviderEntry>> | undefined;
  /** `voice.tts.providers.*` — the named roster a personality can pick from. */
  private readonly ttsProviderRoster: Readonly<Record<string, TtsProviderEntry>> | undefined;
  /** Secrets resolver for voice provider factories. */
  private readonly voiceSecretsResolver: import('@ethosagent/types').SecretsResolver | undefined;
  /**
   * Per-lane voice mode, and the only place the default now lives — the store
   * owns it, so there is no second copy on the Gateway to drift from it.
   * Durable when a storage-backed store was injected.
   */
  private readonly voiceModeStore: LaneVoiceModeStore;
  /** Synthesized-audio store backing voice redelivery. Absent → no artifacts. */
  private readonly voiceArtifacts: VoiceArtifactStore | undefined;
  /** ffmpeg stage. Absent → only already-accepted formats are sent. */
  private readonly transcoder: Transcoder | undefined;
  /** Per-platform TTS-out overrides from `voice.channels.<platform>.ttsOut`. */
  private readonly channelVoiceOut: Readonly<Record<string, boolean>> | undefined;
  /** Transcode bitrate in kbps; undefined leaves the transcoder's own default. */
  private readonly voiceBitrateKbps: number | undefined;
  /** Tracks whether the most recent inbound message per lane had audio. */
  private readonly lastInboundHadAudio = new Map<string, boolean>();
  /** Adapter lookup for agent-initiated outbound sends (send_message tool).
   *  Keyed by PLATFORM (`telegram`, `slack`, ...), not by botKey: a
   *  multi-bot deployment registers the FIRST adapter per platform and
   *  every cross-platform send resolves through that one. */
  private adapterRegistry: Map<string, PlatformAdapter>;
  /**
   * THE authoritative adapter registry: every adapter this gateway knows,
   * keyed by the botKey it serves. `listAdapters()` is this map's values and
   * `removeAdapter(botKey)` resolves through it; `adapterRegistry` above is a
   * derived one-per-platform view of the same adapters, maintained from here
   * by `addAdapter` / `removeAdapter`.
   *
   * Seeded at construction from every adapter the constructor receives — the
   * values of `GatewayConfig.adapters` (each names its own bot in `adapter.id`)
   * and the plugin-contributed adapters this constructor builds itself — plus
   * `GatewayConfig.botAdapters` for the ones a platform-keyed map cannot carry.
   */
  private readonly botAdapters: Map<string, PlatformAdapter>;
  /** Adapters `removeAdapter` has stopped — see `hasStopped`. */
  private readonly stoppedAdapters = new WeakSet<PlatformAdapter>();
  /**
   * Per-bot teardown callbacks (the `session_start` hook registration and the
   * background-completion subscription). `removeAdapter` runs them so a
   * removed bot's loop stops feeding this gateway's routing tables.
   */
  private readonly botCleanups = new Map<string, Array<() => void>>();
  /**
   * Callbacks waiting for a turn to end, fired from `runTurn`'s `finally`.
   * `removeAdapter` parks here rather than polling: the drain has to be exact
   * ("this adapter's turns are done"), and a poll interval is either a
   * needless delay or a race depending on which side of it the turn lands.
   */
  private readonly drainWaiters = new Set<() => void>();
  /** Every `runTurn` in flight — what `shutdown()` waits on after aborting. */
  private readonly inflightTurns = new Set<Promise<void>>();
  private readonly resolveUserIdFn:
    | ((platform: string, platformUserId: string, displayLabel?: string) => Promise<string>)
    | undefined;
  private readonly trustedVoicePlugins: ReadonlySet<string> | undefined;
  // NO `resolvedSttProviderId` / `resolvedTtsProviderId` fields. They used to
  // hold "the" provider id, which was honest only while one provider served the
  // whole process. With per-personality resolution a remembered id is a
  // last-writer-wins global, and a turn stamping it into its own telemetry
  // would name whichever personality spoke most recently. Each resolution now
  // returns its id and the caller stamps THAT.
  /** Why a configured provider did not resolve (refusal, unknown, init fail). */
  private readonly voiceProviderErrors: { stt?: string; tts?: string } = {};
  private readonly pluginLoader: GatewayConfig['pluginLoader'];
  private readonly notificationRouter: GatewayConfig['notificationRouter'];
  /** Completion notices waiting for their lane to go idle. laneKey -> items. */
  private readonly pendingWakes = new Map<
    string,
    Array<{ job: BackgroundJob; bot: GatewayBotConfig }>
  >();
  /** job.id of every wake already delivered (or claimed for delivery) — exactly-once. */
  private readonly deliveredWakes = new Set<string>();
  /** Periodic timer retrying deferred wakes whose lane may since have gone idle. */
  private bgWakeSweepTimer: ReturnType<typeof setInterval> | undefined;
  /** Room-audience decisions (`./audience`); reads the fields above live. */
  private readonly audience: GatewayAudience;
  /** Lane table, eviction and lane-session persistence (`./lane-manager`); state stays on the fields above. */
  private readonly laneManager: LaneManager;
  /** Per-bot daily spend cap (`./daily-spend`); the cache stays on `dailySpend` above. */
  private readonly spend: DailySpend;
  /** STT/TTS resolution, transcription, voice replies and artifact pruning (`./voice-reply`). */
  private readonly voice: VoiceReply;
  /** Inbound-spool replay (`./spool-replay`); replay state stays on the fields above. */
  private readonly spoolReplay: SpoolReplay;
  /** A spooled turn's row lifecycle and unread steers (`./spool-turns`); state stays on the fields above. */
  private readonly spoolLifecycle: SpoolTurns;
  /** Background-job wakes and wake reviews (`./wake-review`); state stays on the fields above. */
  private readonly wake: WakeReviews;
  /** Agent-initiated outbound sends (`./outbound-send`); shares outboundDedup + inFlightSends. */
  private readonly outbound: OutboundSend;
  /** Delivery-ledger redelivery (`./delivery-ledger-sweep`); state stays on the fields above. */
  private readonly deliverySweep: DeliveryLedgerSweep;

  constructor(config: GatewayConfig) {
    // The two construction shapes are mutually exclusive. Silent
    // precedence would let a caller wire both and not notice that
    // `loop` was ignored — a debugging nightmare three years out.
    if (config.bots && config.bots.length > 0 && config.loop !== undefined) {
      throw new Error(
        'Gateway: pass either `bots: [...]` (multi-bot) or `loop` (single-bot back-compat), not both.',
      );
    }
    const botEntries: GatewayBotConfig[] =
      config.bots && config.bots.length > 0
        ? config.bots
        : config.loop !== undefined
          ? [
              {
                // Back-compat: synthesize a one-entry routing table from the
                // legacy `loop` + `defaultPersonality` shorthand. `default`
                // is the lane-key segment for these messages.
                botKey: 'default',
                loop: config.loop,
                binding: {
                  type: 'personality',
                  name: config.defaultPersonality ?? 'default',
                  // The legacy single-bot path used to allow /personality
                  // switching freely. Preserve that.
                  allowSlashSwitch: true,
                },
              },
            ]
          : [];
    if (botEntries.length === 0) {
      throw new Error('Gateway: provide either `bots: [...]` or `loop` in GatewayConfig.');
    }
    this.bots = new Map(botEntries.map((b) => [b.botKey, b]));
    if (this.bots.size !== botEntries.length) {
      throw new Error('Gateway: duplicate botKey in GatewayConfig.bots.');
    }
    this.defaultBotKey = botEntries.length === 1 ? botEntries[0].botKey : null;

    this.dedupWindow = config.dedupWindow ?? 1024;
    this.inboundDedup = config.inboundDedup;
    this.inboundSpool = config.inboundSpool;
    this.spoolOwner = config.inboundSpoolOptions?.owner ?? `${process.pid}:${randomUUID()}`;
    this.spoolMaxAttempts = config.inboundSpoolOptions?.maxAttempts ?? SPOOL_DEFAULT_MAX_ATTEMPTS;
    this.spoolMaxReplayAgeMs =
      config.inboundSpoolOptions?.maxReplayAgeMs ?? SPOOL_DEFAULT_MAX_REPLAY_AGE_MS;
    this.spoolReplayIntervalMs =
      config.inboundSpoolOptions?.replayIntervalMs ?? SPOOL_DEFAULT_REPLAY_INTERVAL_MS;
    this.deliverySweepIntervalMs =
      config.deliverySweepIntervalMs ?? DELIVERY_SWEEP_DEFAULT_INTERVAL_MS;
    this.deliveryMaxAttempts = Math.max(
      1,
      config.deliveryMaxAttempts ?? DELIVERY_DEFAULT_MAX_ATTEMPTS,
    );
    this.maxChats = config.maxChats ?? 4096;
    this.channelFilter = config.channelFilter;
    this.privateChats = config.privateChats;
    this.channelToolsets = config.channelToolsets;
    this.pairingDb = config.pairingDb;
    this.observability = config.observability;
    this.webBaseUrl = config.webBaseUrl;
    this.channelTranscript = config.channelTranscript;
    this.channelDigestFeed = config.channelDigestFeed;
    this.onTurnComplete = config.onTurnComplete;
    this.onUserTurn = config.onUserTurn;
    // Global turn budget. Unset / non-positive => Infinity permits (unbounded,
    // preserving today's behavior). A positive value is the enforced quota.
    this.concurrency = new TurnSemaphore(
      config.maxConcurrentSessions && config.maxConcurrentSessions > 0
        ? config.maxConcurrentSessions
        : Number.POSITIVE_INFINITY,
    );
    this.maxLaneQueue = config.maxLaneQueue ?? 8;
    // ttlMs <= 0 disables dedup inside the cache itself (shouldSend always returns true).
    // onDrop surfaces every genuine duplicate suppression to observability
    // (read lazily, so it sees the observability set on the line above).
    this.outboundDedup = new MessageDedupCache({
      ttlMs: config.outboundDedupTtlMs ?? 30_000,
      onDrop: (info) => {
        this.observability?.recordSafetyBlock({
          code: 'gateway.dedup_drop',
          details: {
            sessionId: info.sessionId,
            contentHash: info.contentHash,
            contentLength: info.contentLength,
          },
        });
      },
    });
    this.deliveryLedger = config.deliveryLedger;
    this.quietHours = config.quietHours;
    this.heldNotices = config.heldNotices;
    this.publicationSpeaksFor = config.publicationSpeaksFor;
    // Streaming draft edits: DMs on, groups off, unless config overrides.
    this.streamingDm = config.streamingEdits?.dm ?? true;
    this.streamingGroup = config.streamingEdits?.group ?? false;
    this.streamingEditIntervalMs = config.streamingEditIntervalMs ?? 2500;
    this.slowTurnNoticeMs = config.slowTurnNoticeMs ?? 8000;
    this.steerTranscribeTimeoutMs = config.steerTranscribeTimeoutMs ?? 60_000;
    this.onAllowlistChange = config.onAllowlistChange;
    this.clarifyCorrelator = config.clarifyMessageCorrelator;
    this.clarifyEscalationDelayMs = config.clarifyEscalationDelayMs ?? DEFAULT_ESCALATION_DELAY_MS;
    this.personalityCardReader = config.personalityCardReader;
    this.greetingProvider = config.greetingProvider;
    this.personalityDirectory = config.personalityDirectory;
    this.mcpLoginFor = config.mcpLoginFor;
    this.attachmentCache = config.attachmentCache;
    this.storage = config.storage;
    this.dataDir = config.dataDir;
    this.laneFiles =
      config.storage && config.dataDir
        ? new LaneSessionFiles(config.storage, config.dataDir)
        : undefined;
    this.sessionStoreFor = config.sessionStore;
    this.botSpendSince = config.botSpendSince;
    this.sttProviderRegistry = config.sttProviderRegistry;
    this.sttProviderName = config.sttProviderName;
    this.ttsProviderRegistry = config.ttsProviderRegistry;
    this.ttsProviderName = config.ttsProviderName;
    this.sttProviderConfig = config.sttProviderConfig ?? {};
    this.ttsProviderConfig = config.ttsProviderConfig ?? {};
    this.sttProviderRoster = config.sttProviderRoster;
    this.ttsProviderRoster = config.ttsProviderRoster;
    this.voiceSecretsResolver = config.voiceSecretsResolver;
    // No store injected → an in-memory one. `LaneVoiceModeStore` with no
    // `storage` is exactly the Map this replaced, so a standalone/test gateway
    // behaves as it always did while a wired one persists across restarts. An
    // injected store carries its OWN default (the wiring builds it from
    // `voice.defaultMode`), so `config.defaultVoiceMode` seeds only the
    // fallback — one default, in one place, either way.
    this.voiceModeStore =
      config.voiceModeStore ??
      new LaneVoiceModeStore({ defaultMode: config.defaultVoiceMode ?? DEFAULT_VOICE_MODE });
    this.voiceArtifacts = config.voiceArtifacts;
    this.transcoder = config.transcoder;
    this.channelVoiceOut = config.channelVoiceOut;
    this.voiceBitrateKbps = config.voiceBitrateKbps;
    this.trustedVoicePlugins = config.trustedVoicePlugins;
    this.adapterRegistry = config.adapters ?? new Map();
    // Seed the authoritative registry from EVERY adapter handed to this
    // constructor, not just from the optional `botAdapters` map: each value of
    // `config.adapters` names its own bot in `adapter.id`, so a caller that
    // passed only the platform-keyed map still gets an honest
    // `listAdapters()` rather than an empty one.
    // Keyed by the botKey each adapter DECLARES where it declares one — see
    // `servedBotKey` — because tracked sends resolve through this map by bot.
    this.botAdapters = new Map();
    for (const [key, adapter] of config.botAdapters ?? []) {
      this.botAdapters.set(servedBotKey(adapter, key), adapter);
    }
    for (const adapter of this.adapterRegistry.values()) {
      const botKey = servedBotKey(adapter, botKeyOfAdapterId(adapter.id));
      if (!this.botAdapters.has(botKey)) this.botAdapters.set(botKey, adapter);
    }
    for (const [botKey, adapter] of this.botAdapters) this.bindPresence(adapter, botKey);
    this.resolveUserIdFn = config.resolveUserId;
    this.pluginLoader = config.pluginLoader;
    this.notificationRouter = config.notificationRouter;

    // Collaborators, built before any plugin adapter starts or any bot is
    // wired, so a synchronous inbound message during `start()` never reaches an
    // unbuilt one. Construction reads no field: every dep is a live getter or a
    // closure over `gw`, evaluated only when a collaborator method runs, so a
    // field assigned later in this constructor is still seen.
    const gw = this;
    this.rooms = new RoomGateway(config.roomPolicies, {
      observability: () => gw.observability,
      sessionStoreFor: () => gw.sessionStoreFor,
      privateChats: () => gw.privateChats,
      isOwner: (message) => gw.isOwner(message),
    });
    this.audience = new GatewayAudience({
      get privateChats() {
        return gw.privateChats;
      },
      get channelFilter() {
        return gw.channelFilter;
      },
      get sessionStoreFor() {
        return gw.sessionStoreFor;
      },
    });
    this.deliverySweep = new DeliveryLedgerSweep({
      adapterForBot: (botKey, platform) => gw.adapterForBot(botKey, platform),
      get bots() {
        return gw.bots;
      },
      get closing() {
        return gw.closing;
      },
      get deliveryLedger() {
        return gw.deliveryLedger;
      },
      get deliveryMaxAttempts() {
        return gw.deliveryMaxAttempts;
      },
      get deliverySweepInFlight() {
        return gw.deliverySweepInFlight;
      },
      set deliverySweepInFlight(value) {
        gw.deliverySweepInFlight = value;
      },
      get deliverySweepIntervalMs() {
        return gw.deliverySweepIntervalMs;
      },
      get deliverySweepTimer() {
        return gw.deliverySweepTimer;
      },
      set deliverySweepTimer(value) {
        gw.deliverySweepTimer = value;
      },
      get localInboundIds() {
        return gw.localInboundIds;
      },
      get localInboundSeq() {
        return gw.localInboundSeq;
      },
      set localInboundSeq(value) {
        gw.localInboundSeq = value;
      },
      get observability() {
        return gw.observability;
      },
      get outboundDedup() {
        return gw.outboundDedup;
      },
      releaseHeldNotices: () => gw.releaseHeldNotices(),
      releaseParkedReviews: () => gw.releaseParkedReviews(),
      get voiceArtifacts() {
        return gw.voiceArtifacts;
      },
    });
    this.outbound = new OutboundSend({
      adapterForBot: (botKey, platform) => gw.adapterForBot(botKey, platform),
      get adapterRegistry() {
        return gw.adapterRegistry;
      },
      get botAdapters() {
        return gw.botAdapters;
      },
      get inFlightSends() {
        return gw.inFlightSends;
      },
      get observability() {
        return gw.observability;
      },
      get outboundDedup() {
        return gw.outboundDedup;
      },
    });
    this.wake = new WakeReviews({
      get activeSinks() {
        return gw.activeSinks;
      },
      get activeTurns() {
        return gw.activeTurns;
      },
      adapterForBot: (botKey, platform) => gw.adapterForBot(botKey, platform),
      get bots() {
        return gw.bots;
      },
      closeSpool: (spoolId) => gw.closeSpool(spoolId),
      get deliveredWakes() {
        return gw.deliveredWakes;
      },
      get deliveryLedger() {
        return gw.deliveryLedger;
      },
      enqueueTurn: (laneKey, lane, bot, message, adapter, text, threadId, spoolId, review) =>
        gw.enqueueTurn(laneKey, lane, bot, message, adapter, text, threadId, spoolId, review),
      getOrCreateLane: (key) => gw.getOrCreateLane(key),
      get heldNotices() {
        return gw.heldNotices;
      },
      holdNotice: (notice) => gw.holdNotice(notice),
      get inboundSpool() {
        return gw.inboundSpool;
      },
      noticeHoldReason: (botKey, laneKey, now) => gw.noticeHoldReason(botKey, laneKey, now),
      get observability() {
        return gw.observability;
      },
      get outboundDedup() {
        return gw.outboundDedup;
      },
      get parkedReviews() {
        return gw.parkedReviews;
      },
      get pendingWakes() {
        return gw.pendingWakes;
      },
      recordSpoolUpdateFailed: (stage, err) => gw.recordSpoolUpdateFailed(stage, err),
      reviewAudience: (job) => gw.reviewAudience(job),
      sendTracked: (target, message) => gw.sendTracked(target, message),
      get sessionKeys() {
        return gw.sessionKeys;
      },
      get spoolOwner() {
        return gw.spoolOwner;
      },
    });
    this.spoolLifecycle = new SpoolTurns({
      adapterForBot: (botKey, platform) => gw.adapterForBot(botKey, platform),
      get attachmentCache() {
        return gw.attachmentCache;
      },
      get closing() {
        return gw.closing;
      },
      get deliveryLedger() {
        return gw.deliveryLedger;
      },
      enqueueTurn: (laneKey, lane, bot, message, adapter, text, threadId, spoolId, review) =>
        gw.enqueueTurn(laneKey, lane, bot, message, adapter, text, threadId, spoolId, review),
      holdNotice: (notice) => gw.holdNotice(notice),
      get inboundSpool() {
        return gw.inboundSpool;
      },
      get interruptedLanes() {
        return gw.interruptedLanes;
      },
      notifyTracked: (target, text) => gw.notifyTracked(target, text),
      get observability() {
        return gw.observability;
      },
      get outboundDedup() {
        return gw.outboundDedup;
      },
      get personalityIds() {
        return gw.personalityIds;
      },
      reviveSpooledMessage: (row) => gw.reviveSpooledMessage(row),
      routedBotKey: (message) => gw.routedBotKey(message),
      sendTracked: (target, message) => gw.sendTracked(target, message),
      get sessionKeys() {
        return gw.sessionKeys;
      },
      get spoolMaxAttempts() {
        return gw.spoolMaxAttempts;
      },
      get spoolOwner() {
        return gw.spoolOwner;
      },
      get steerTranscribeTimeoutMs() {
        return gw.steerTranscribeTimeoutMs;
      },
      get storage() {
        return gw.storage;
      },
      transcribeVoiceNote: (message, text, personalityId, io) =>
        gw.transcribeVoiceNote(message, text, personalityId, io),
    });
    this.spoolReplay = new SpoolReplay({
      adapterForBot: (botKey, platform) => gw.adapterForBot(botKey, platform),
      get attachmentCache() {
        return gw.attachmentCache;
      },
      get bots() {
        return gw.bots;
      },
      get closing() {
        return gw.closing;
      },
      deliverReviewFallback: (spoolId, target, text, reason) =>
        gw.deliverReviewFallback(spoolId, target, text, reason),
      get deliveryLedger() {
        return gw.deliveryLedger;
      },
      enqueueReview: (bot, adapter, message, spoolId, review, laneKey) =>
        gw.enqueueReview(bot, adapter, message, spoolId, review, laneKey),
      foldAbsorbed: (spool, row, message) => gw.foldAbsorbed(spool, row, message),
      handleMessage: (message, adapter, opts) => gw.handleMessage(message, adapter, opts),
      get inboundSpool() {
        return gw.inboundSpool;
      },
      get interruptedLanes() {
        return gw.interruptedLanes;
      },
      notifyDeadLettered: (spoolId, reason, target) =>
        gw.notifyDeadLettered(spoolId, reason, target),
      notifyInterrupted: (spoolId, target) => gw.notifyInterrupted(spoolId, target),
      notifyTracked: (target, text) => gw.notifyTracked(target, text),
      get observability() {
        return gw.observability;
      },
      get orphansRecovered() {
        return gw.orphansRecovered;
      },
      set orphansRecovered(value) {
        gw.orphansRecovered = value;
      },
      recordSpoolDeadLettered: (spoolId, reason) => gw.recordSpoolDeadLettered(spoolId, reason),
      recordSpoolUpdateFailed: (stage, err) => gw.recordSpoolUpdateFailed(stage, err),
      get replayInFlight() {
        return gw.replayInFlight;
      },
      set replayInFlight(value) {
        gw.replayInFlight = value;
      },
      get replaying() {
        return gw.replaying;
      },
      set replaying(value) {
        gw.replaying = value;
      },
      reviewAudience: (job) => gw.reviewAudience(job),
      get spoolMaxAttempts() {
        return gw.spoolMaxAttempts;
      },
      get spoolMaxReplayAgeMs() {
        return gw.spoolMaxReplayAgeMs;
      },
      get spoolOwner() {
        return gw.spoolOwner;
      },
      get spoolReplayIntervalMs() {
        return gw.spoolReplayIntervalMs;
      },
      get spoolReplayTimer() {
        return gw.spoolReplayTimer;
      },
      set spoolReplayTimer(value) {
        gw.spoolReplayTimer = value;
      },
      get storage() {
        return gw.storage;
      },
    });
    this.voice = new VoiceReply({
      get bots() {
        return gw.bots;
      },
      get channelVoiceOut() {
        return gw.channelVoiceOut;
      },
      deliveryBinding: (botKey, platform, inboundRef) =>
        gw.deliveryBinding(botKey, platform, inboundRef),
      get deliveryLedger() {
        return gw.deliveryLedger;
      },
      get observability() {
        return gw.observability;
      },
      get pauseOffsetMs() {
        return gw.pauseOffsetMs;
      },
      set pauseOffsetMs(value) {
        gw.pauseOffsetMs = value;
      },
      get personalityDirectory() {
        return gw.personalityDirectory;
      },
      get sttProviderConfig() {
        return gw.sttProviderConfig;
      },
      get sttProviderName() {
        return gw.sttProviderName;
      },
      get sttProviderRegistry() {
        return gw.sttProviderRegistry;
      },
      get sttProviderRoster() {
        return gw.sttProviderRoster;
      },
      get sttProviders() {
        return gw.sttProviders;
      },
      get transcoder() {
        return gw.transcoder;
      },
      get trustedVoicePlugins() {
        return gw.trustedVoicePlugins;
      },
      get ttsProviderConfig() {
        return gw.ttsProviderConfig;
      },
      get ttsProviderName() {
        return gw.ttsProviderName;
      },
      get ttsProviderRegistry() {
        return gw.ttsProviderRegistry;
      },
      get ttsProviderRoster() {
        return gw.ttsProviderRoster;
      },
      get ttsProviders() {
        return gw.ttsProviders;
      },
      get voiceArtifacts() {
        return gw.voiceArtifacts;
      },
      get voiceBitrateKbps() {
        return gw.voiceBitrateKbps;
      },
      get voiceProviderErrors() {
        return gw.voiceProviderErrors;
      },
      get voiceSecretsResolver() {
        return gw.voiceSecretsResolver;
      },
      get voiceTranscripts() {
        return gw.voiceTranscripts;
      },
    });
    this.spend = new DailySpend({
      get adapterRegistry() {
        return gw.adapterRegistry;
      },
      get botAdapters() {
        return gw.botAdapters;
      },
      get botSpendSince() {
        return gw.botSpendSince;
      },
      get bots() {
        return gw.bots;
      },
      get dailySpend() {
        return gw.dailySpend;
      },
      get defaultBotKey() {
        return gw.defaultBotKey;
      },
      get observability() {
        return gw.observability;
      },
    });
    this.laneManager = new LaneManager({
      get activeTurns() {
        return gw.activeTurns;
      },
      get attachmentCache() {
        return gw.attachmentCache;
      },
      get bots() {
        return gw.bots;
      },
      get incognitoLanes() {
        return gw.incognitoLanes;
      },
      get laneFiles() {
        return gw.laneFiles;
      },
      get laneMutes() {
        return gw.laneMutes;
      },
      get laneRestores() {
        return gw.laneRestores;
      },
      get lanes() {
        return gw.lanes;
      },
      get lastInboundHadAudio() {
        return gw.lastInboundHadAudio;
      },
      get maxChats() {
        return gw.maxChats;
      },
      get observability() {
        return gw.observability;
      },
      get outboundDedup() {
        return gw.outboundDedup;
      },
      get personalityIds() {
        return gw.personalityIds;
      },
      get sessionKeys() {
        return gw.sessionKeys;
      },
      get usageStore() {
        return gw.usageStore;
      },
    });

    // --- Plugin-contributed adapters (Channel SDK) ---
    if (config.pluginAdapters) {
      for (const [name, factory] of config.pluginAdapters) {
        // Default-deny: only start trusted channel plugins when the allowlist is set.
        // When trustedChannelPlugins is undefined, all plugins are allowed (backward compat).
        if (config.trustedChannelPlugins) {
          const pluginId = name.includes('/') ? (name.split('/')[0] ?? '') : name;
          if (!config.trustedChannelPlugins.has(pluginId)) {
            continue;
          }
        }
        const adapter = factory({});
        const adapterBotKey = deriveBotKey(name);
        const ctx: ChannelContext = {
          botKey: adapterBotKey,
          onMessage: async (msg: InboundMessage) => {
            // Pin unconditionally: a plugin adapter represents exactly one bot
            // (`adapterBotKey`), so a caller-supplied `botKey` must never be
            // allowed to address a different bot's loop.
            const stamped = { ...msg, botKey: adapterBotKey };
            await this.handleMessage(stamped, adapter);
          },
          logger: noopLogger,
        };
        if (adapter.startWithContext) {
          adapter.startWithContext(ctx).catch(() => {});
        } else {
          adapter.onMessage((msg: InboundMessage) => {
            // Pin unconditionally — see the startWithContext path above.
            const stamped = { ...msg, botKey: adapterBotKey };
            // Nobody awaits this call, so a failed turn would otherwise be an
            // unhandled rejection. Same record as `addAdapter`'s inbound path.
            void this.handleMessage(stamped, adapter).catch((err: unknown) => {
              this.observability?.recordSafetyBlock({
                code: 'gateway.inbound_error',
                cause: 'inbound message handling threw',
                details: {
                  platform: msg.platform,
                  botKey: adapterBotKey,
                  error: err instanceof Error ? err.message : String(err),
                },
              });
            });
          });
          adapter.start().catch(() => {});
        }
        this.adapterRegistry.set(name, adapter);
        // A plugin adapter is a live adapter — `listAdapters()` would be
        // lying if it left them out.
        this.botAdapters.set(adapterBotKey, adapter);
      }
    }

    // Per-bot loop wiring — the `session_start` bridge and the
    // background-completion subscription. One method, called here for every
    // configured bot and again from `addAdapter` for every hot-added one, so
    // the two paths can never drift.
    for (const bot of botEntries) this.wireBotLoop(bot);
    // Periodic retry for deferred wakes: a turn that was in flight when a job
    // finished won't always fire the turn-end flush for the RIGHT lane (a wake
    // may arrive between turns), so sweep every lane with pending items.
    this.bgWakeSweepTimer = setInterval(() => {
      for (const laneKey of [...this.pendingWakes.keys()]) void this.flushWakes(laneKey);
    }, 15_000);
    this.bgWakeSweepTimer.unref?.();

    // Clarify sweep — fires on a single timer for all bots' bridges so a
    // multi-bot deployment doesn't pile up N timers. Each bridge owns its own
    // expiry logic; we just tick them in parallel.
    // ARMED ON THE SETTING, NOT ON THE CONSTRUCTION-TIME BRIDGE LIST. The tick
    // already reads the LIVE routing table, but gating the timer's CREATION on
    // `bridges.length > 0` meant a process that booted with no clarify bridge
    // never started one — so the first bot hot-added with a bridge was never
    // swept, for the life of the process. An empty tick costs one
    // `Promise.all([])`.
    const sweepMs = config.clarifySweepIntervalMs ?? 30_000;
    if (sweepMs > 0) {
      this.clarifySweepTimer = setInterval(() => {
        // Read from the LIVE routing table, not the construction-time
        // snapshot, so a hot-added bot's bridge is swept too.
        void Promise.all(this.clarifyBridges().map((b) => b.sweep())).catch(() => {});
      }, sweepMs);
      // `unref()` lets the process exit when only the sweep timer remains.
      this.clarifySweepTimer.unref?.();
    }

    // §4.6 rung 3 — its own timer, not the 30s clarify sweep's: a 60s rung
    // polled every 30s fires anywhere between 60s and 90s, and the ladder's
    // whole claim is that the push lands when the silence has actually lasted
    // a minute. Its own cadence keeps the fire window at 60–65s. Armed on the
    // setting alone, for the same hot-add reason as the sweep above.
    if (this.clarifyEscalationDelayMs > 0) {
      this.clarifyEscalationTimer = setInterval(() => {
        void this.sweepClarifyEscalations().catch(() => {});
      }, CLARIFY_ESCALATION_POLL_MS);
      this.clarifyEscalationTimer.unref?.();
    }

    // Seed in-memory allowlists from DB-persisted approved senders
    if (config.pairingDb && config.channelFilter) {
      for (const [platform, cfg] of Object.entries(config.channelFilter)) {
        const approved = getApprovedSenders(config.pairingDb, platform);
        if (approved.length > 0) {
          if (!cfg.recipientAllowlist) cfg.recipientAllowlist = [];
          for (const id of approved) {
            if (!cfg.recipientAllowlist.includes(id)) cfg.recipientAllowlist.push(id);
          }
        }
      }
    }

    // Observe mode with nowhere to record to. The gate in `handleMessage`
    // returns unconditionally, so this deployment is dropping every watched
    // message AND writing `channel.observed` for each one — the audit trail
    // says the opposite of what is happening, which is why silence here is
    // worse than the misconfiguration. Reported once, at construction, through
    // the same observability seam the gate itself uses: this package has no
    // console, and an audit record is what an operator can actually go and
    // find. It changes no behaviour.
    if (!config.channelTranscript && (config.observeModePlatforms?.length ?? 0) > 0) {
      this.observability?.recordSafetyBlock({
        code: 'channel.observe_without_store',
        cause:
          'observe mode is configured but no channel transcript store is wired — ' +
          'observed messages are being recorded nowhere and are lost',
        details: { platforms: [...(config.observeModePlatforms ?? [])] },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Live adapter reconciliation (plan/phases/gateway-live-reload.md Phase A)
  // ---------------------------------------------------------------------------

  /**
   * Register the per-bot loop subscriptions this gateway owns, and record how
   * to undo them.
   *
   * `session_start` bridges `sessionId → routing`. It fires inside
   * `loop.run()` (AgentLoop step 2) and is the only hook carrying BOTH
   * `sessionId` and `sessionKey`, so by the time a `before_tool_call` approval
   * hook fires later in the same turn the gateway can resolve the sessionId
   * back to its adapter/chat/thread.
   *
   * The background-completion subscription delivers a finished job's notice to
   * its originating chat — never while a turn is in flight on that lane (see
   * `flushWakes`). A bot whose loop has no durable executor contributes none.
   */
  private wireBotLoop(bot: GatewayBotConfig): void {
    const undos: Array<() => void> = [
      bot.loop.hooks.registerVoid('session_start', async (payload) => {
        const routing = this.sessionRouting.get(payload.sessionKey);
        if (routing) {
          this.approvalRoutes.set(payload.sessionId, routing);
          this.sessionIdByKey.set(payload.sessionKey, payload.sessionId);
        }
      }),
    ];
    if (bot.backgroundExecutor) {
      undos.push(
        bot.backgroundExecutor.onComplete((job) => this.onBackgroundJobComplete(bot, job)),
      );
    }
    this.botCleanups.set(bot.botKey, undos);
  }

  /** Every live adapter, in registration order. */
  listAdapters(): PlatformAdapter[] {
    return [...this.botAdapters.values()];
  }

  /** Every bot in the routing table, in registration order. */
  listBots(): GatewayBotConfig[] {
    return [...this.bots.values()];
  }

  /**
   * Whether an access-control filter for `platform` is INSTALLED in this
   * running gateway — as opposed to merely present in `config.yaml`.
   *
   * `channelFilter` is assigned once, at construction, and Phase B (live
   * `channel_filter` edits) is deliberately not implemented: nothing replaces
   * it while the process runs. So a `channel_filter.<platform>` block an
   * operator adds to the file is NOT in force, and a hot-added bot on that
   * platform would otherwise go live under access control that was never
   * installed. `hotAddRefusalReason` in `apps/ethos/src/config-reload.ts` asks
   * THIS, not the parsed file, and refuses the addition until a restart
   * installs the filter.
   *
   * Read-only and additive (plan/phases/gateway-live-reload.md §5.3);
   * installing a filter live stays Phase B's job.
   */
  hasChannelFilterFor(platform: string): boolean {
    return this.channelFilter?.[platform] !== undefined;
  }

  /** Live clarify bridges across every registered bot. */
  private clarifyBridges(): NonNullable<GatewayBotConfig['loop']['clarifyBridge']>[] {
    return [...this.bots.values()]
      .map((b) => b.loop.clarifyBridge)
      .filter((b): b is NonNullable<typeof b> => b !== undefined);
  }

  /**
   * Register one bot in the routing table, live, with NO adapter of its own.
   *
   * That is not a degenerate case: a generic inbound webhook route
   * (`webhooks.<hookId>` in `config.yaml`) is a first-class bot here — the
   * wiring builds it a personality-bound loop and stamps `webhook:<hookId>` on
   * every inbound — but its transport is the webhook server's per-request
   * capturing adapter, not a long-lived `PlatformAdapter`. Without this, a
   * route added live would be SERVED and then dropped at `no_bot_available`.
   *
   * `addAdapter` is this plus the adapter-side registration, so the
   * duplicate-botKey guard and the loop wiring are defined in exactly one
   * place (plan/phases/gateway-live-reload.md Phase C).
   */
  addBot(bot: GatewayBotConfig): void {
    if (this.bots.has(bot.botKey)) {
      throw new Error(`Gateway: botKey "${bot.botKey}" is already registered.`);
    }
    this.bots.set(bot.botKey, bot);
    this.defaultBotKey = this.bots.size === 1 ? bot.botKey : null;
    this.wireBotLoop(bot);
    // A bot added after boot missed `restoreLaneSessions`: read its lane file
    // now, and gate its lanes on the read (`laneRestores`). Without this its
    // lanes started on their defaults and the first `/new` or `/fork`
    // rewrote the file from that empty map, erasing every other lane's branch.
    // Pinned by `__tests__/lane-sessions.test.ts` ('a bot added live').
    if (this.laneFiles) {
      const restore = this.restoreBotLaneSessions(bot.botKey);
      this.laneRestores.set(bot.botKey, restore);
      void restore.then(() => {
        if (this.laneRestores.get(bot.botKey) === restore) this.laneRestores.delete(bot.botKey);
      });
    }
  }

  private pendingLaneRestore(botKey: string | undefined): Promise<void> | undefined {
    return this.laneManager.pendingLaneRestore(botKey);
  }

  /**
   * Register one already-constructed adapter and its bot, live.
   *
   * The caller is responsible for `adapter.start()` AFTER this returns — the
   * inbound handler has to be wired before the adapter can deliver anything,
   * and (for webhook-mode adapters) the route mount is only possible once
   * `start()` has resolved.
   *
   * The duplicate-botKey check the constructor performs fires exactly once, at
   * construction; this is the same rule enforced as a runtime guard, so a diff
   * that re-adds a bot which is still registered is refused rather than
   * silently replacing a live routing-table entry.
   */
  addAdapter(adapter: PlatformAdapter, bot: GatewayBotConfig): void {
    const platform = platformOfAdapterId(adapter.id);
    this.addBot(bot);
    // ONE derivation with the constructor's seeding: the botKey the adapter
    // DECLARES wins (it is what it stamps on every inbound), falling back to
    // the bot it is being registered for. See `servedBotKey`.
    this.botAdapters.set(servedBotKey(adapter, bot.botKey), adapter);
    this.bindPresence(adapter, servedBotKey(adapter, bot.botKey));
    // First-adapter-per-platform, matching how the wiring builds
    // `GatewayConfig.adapters`. A hot-added second Telegram bot must not
    // repoint every agent-initiated `send_message` at itself.
    if (!this.adapterRegistry.has(platform)) this.adapterRegistry.set(platform, adapter);
    // ONE inbound wiring path. The adapter stamps its own `botKey` (exactly as
    // it does on the cold-boot path in `apps/ethos/src/commands/boot.ts`), so
    // nothing is pinned here — unlike the plugin-adapter path in the
    // constructor, where the factory-built adapter has no botKey of its own.
    adapter.onMessage((message: InboundMessage) => {
      void this.handleMessage(message, adapter).catch((err: unknown) => {
        this.observability?.recordSafetyBlock({
          code: 'gateway.inbound_error',
          cause: 'inbound message handling threw',
          details: {
            platform,
            botKey: bot.botKey,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      });
    });
  }

  /**
   * Deregister one bot and stop its adapter, leaving every other bot running.
   *
   * THE ORDER IS THE WHOLE POINT, and it is not "deregister, then drain".
   * Queued work was accepted under this bot's routing entry and its loop
   * wiring — the `session_start` bridge that lets an approval resolve back to
   * this chat, the background-completion subscription — so tearing those out
   * first would leave the drain running turns that no longer have the
   * infrastructure they were admitted under. Instead the bot is marked
   * RETIRING: `handleMessage` refuses new inbound for it immediately, while
   * everything already queued keeps routing normally until it finishes.
   *
   * Only once the bot is idle does the teardown run: loop hooks, routing
   * entry, lanes, and finally the transport. `shutdown()` cannot be reused for
   * any of this — it assumes the whole process is going down and aborts every
   * lane on the gateway.
   *
   * `drainTimeoutMs` bounds the wait so one wedged turn cannot block a config
   * reconcile forever. On expiry the turn is ABORTED and then awaited (bounded
   * by `abortGraceMs`, default {@link ABORT_GRACE_MS}) before the adapter
   * stops — `SessionLane.abort()` only raises a signal, so stopping the
   * transport the instant it is raised would tear the adapter out from under a
   * turn that is still writing to it.
   *
   * IF THE ABORT GRACE ALSO EXPIRES, NOTHING IS TORN DOWN. The drain guarantee
   * this method claims is not "wait a bit, then tear down anyway": a
   * cancellation still running when its hooks, lanes, routing entry and
   * transport are deleted is a use-after-stop — late `adapter.send` calls onto
   * a stopped transport, approvals routing through a `session_start` bridge
   * that no longer exists. So the bot is left QUARANTINED instead: it keeps its
   * routing entry, its lanes and its loop wiring, it stays in `retiringBots`
   * (so `handleMessage` admits no new inbound for it), its adapter is NOT
   * stopped, and this rejects. The caller's applied-state ledger therefore
   * never marks the unit retired, and the next config-reload poll calls this
   * again — by which time the turn has almost always unwound and the teardown
   * completes. The alternative — making cancellation awaitable and simply
   * waiting — has no bound at all: `AgentLoop` promises no deadline for
   * observing its abort signal, so one wedged turn would block every later
   * reconcile forever. Retry-on-a-later-poll is the same discipline the rest
   * of the reconciler already runs on.
   */
  async removeAdapter(
    botKey: string,
    opts: { drainTimeoutMs?: number; abortGraceMs?: number } = {},
  ): Promise<void> {
    const adapter = this.botAdapters.get(botKey);
    const known = this.bots.has(botKey) || adapter !== undefined;
    if (!known) return;

    this.retiringBots.add(botKey);
    let drained = await this.drainAdapter(
      adapter,
      botKey,
      opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
    );
    if (!drained) {
      // Wedged. Tell it to stop, then wait for it to actually stop — an
      // aborted turn still has to unwind, and its last `adapter.send` must
      // not land after `adapter.stop()`.
      for (const [laneKey, lane] of this.lanes) {
        if (botKeyOfLaneKey(laneKey) === botKey) lane.abort();
      }
      drained = await this.drainAdapter(adapter, botKey, opts.abortGraceMs ?? ABORT_GRACE_MS);
    }
    if (!drained) {
      // Quarantined, not retired. Everything stays exactly as it is — see the
      // doc comment above — and the botKey stays in `retiringBots`, so the bot
      // accepts no new work while its cancellation finishes.
      this.observability?.recordSafetyBlock({
        code: 'gateway.retirement_deferred',
        cause: 'the bot was still busy after the abort grace',
        details: { botKey },
      });
      throw new Error(
        `Gateway: bot "${botKey}" is still busy after the abort grace — retirement deferred. ` +
          'It accepts no new inbound; teardown is retried on the next reconcile.',
      );
    }

    this.retiringBots.delete(botKey);
    // Idle — NOW the bot stops existing.
    this.bots.delete(botKey);
    this.botAdapters.delete(botKey);
    for (const undo of this.botCleanups.get(botKey) ?? []) undo();
    this.botCleanups.delete(botKey);
    this.defaultBotKey = this.bots.size === 1 ? ([...this.bots.keys()][0] ?? null) : null;
    // Drop this bot's lanes so a later re-add of the same botKey starts
    // clean instead of inheriting a stale queue.
    for (const [laneKey, lane] of [...this.lanes]) {
      if (botKeyOfLaneKey(laneKey) !== botKey) continue;
      lane.abort();
      this.lanes.delete(laneKey);
    }
    // An adapterless bot (a generic webhook route — see `addBot`) is fully
    // deregistered at this point: there is no transport to unregister from a
    // platform and nothing to stop.
    if (!adapter) return;
    for (const [platform, registered] of [...this.adapterRegistry]) {
      if (registered !== adapter) continue;
      // This adapter WAS the platform's outbound representative. If a sibling
      // bot on the same platform is still live, promote it — otherwise every
      // agent-initiated `send_message` to that platform would start failing
      // because one of its bots left.
      const survivor = [...this.botAdapters.values()].find(
        (a) => platformOfAdapterId(a.id) === platform,
      );
      if (survivor) this.adapterRegistry.set(platform, survivor);
      else this.adapterRegistry.delete(platform);
    }
    // Recorded BEFORE the call, so a `stop()` that throws is still not
    // attempted a second time by the host's shutdown (`hasStopped`).
    this.stoppedAdapters.add(adapter);
    await adapter.stop();
  }

  /**
   * Whether `removeAdapter` has already called this adapter's `stop()`. A host
   * keeps its own list of the adapters it built, and a retired one stays in
   * it; its shutdown asks here so the adapter is not stopped a second time
   * (`everyStartedAdapter` in apps/ethos/src/commands/gateway-adapters.ts, pinned by
   * apps/ethos/src/__tests__/every-started-adapter.test.ts).
   */
  hasStopped(adapter: PlatformAdapter): boolean {
    return this.stoppedAdapters.has(adapter);
  }

  /**
   * Resolve once no turn is in flight for `adapter` and no message is queued
   * on any of `botKey`'s lanes. `SessionLane.length` counts the processing
   * item as well as the queue, so a lane at zero has genuinely finished.
   *
   * Returns whether it actually went idle: `false` means the timeout won, and
   * the caller still has live work to deal with.
   */
  private async drainAdapter(
    adapter: PlatformAdapter | undefined,
    botKey: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const busy = (): boolean => {
      // An adapterless bot has no turn to match on `adapter`; its work is
      // visible on its lanes, which the loop below covers either way.
      if (adapter) {
        for (const turn of this.activeTurns.values()) if (turn.adapter === adapter) return true;
      }
      for (const [laneKey, lane] of this.lanes) {
        if (botKeyOfLaneKey(laneKey) === botKey && lane.length > 0) return true;
      }
      return false;
    };
    if (!busy()) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.drainWaiters.delete(check);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      const check = (): void => {
        if (busy()) return;
        this.drainWaiters.delete(check);
        clearTimeout(timer);
        resolve(true);
      };
      this.drainWaiters.add(check);
    });
  }

  /** Fired from `runTurn`'s `finally` — see {@link drainWaiters}. */
  private notifyDrainWaiters(): void {
    if (this.drainWaiters.size === 0) return;
    // Deferred by one macrotask on purpose. `SessionLane` flips `processing`
    // to false only after the turn's promise settles and its queue is empty,
    // so a check run inside the turn's own `finally` — or in any microtask
    // chained off it — would still see `lane.length > 0` and never resolve.
    const timer = setTimeout(() => {
      for (const waiter of [...this.drainWaiters]) waiter();
    }, 0);
    timer.unref?.();
  }

  private personalityVoice(personalityId?: string): PersonalityVoiceConfig | undefined {
    return this.voice.personalityVoice(personalityId);
  }

  voiceProviderStatus(): Promise<{
    stt: string | undefined;
    tts: string | undefined;
    sttError: string | undefined;
    ttsError: string | undefined;
  }> {
    return this.voice.voiceProviderStatus();
  }

  /**
   * The in-memory dedup key for a message, or `undefined` when the message is
   * not deduped at all: dedup is off (`dedupWindow: 0` disables both layers —
   * "no dedup", not "no in-memory dedup"), it has no `messageId` (we can't
   * dedup what isn't keyed), or it is an edit (edits intentionally re-use the
   * original `messageId` with different content).
   *
   * The key is platform-, bot-, chat-, and message-scoped: the same
   * `messageId` arriving through two different bots is two distinct inbounds,
   * not a duplicate. (Without the botKey segment, multi-bot routing would
   * silently drop one of them.)
   */
  private dedupKeyFor(message: InboundMessage, botKey: string): string | undefined {
    if (this.dedupWindow <= 0 || !message.messageId || message.isEdit) return undefined;
    return buildLaneKey(message.platform, botKey, message.chatId, message.messageId);
  }

  /**
   * Record a sighting durably, then in memory, and report whether the durable
   * layer had already seen this key — from this process or a previous one.
   * Called only on an in-memory `Set` miss.
   *
   * TWO LAYERS, both keyed identically. The in-memory `Set` is the fast path
   * and answers alone whenever it hits. Only on a miss — and only when a
   * durable store is configured — does this touch SQLite, because a process
   * restart empties the `Set` and a platform redelivery arriving at the fresh
   * process would otherwise be fully reprocessed and re-billed. Under webhook
   * mode with scale-to-zero that restart is routine rather than rare.
   *
   * DURABLE FIRST, THEN THE SET, AND THAT ORDER IS LOAD-BEARING. `seen()` is a
   * synchronous SQLite write and can throw (lock contention past the busy
   * timeout, a corrupt or unwritable file). Recording the key in memory first
   * meant a throw left the process holding a sighting that was never durably
   * stored: this delivery fails, and then every platform retry for the rest of
   * the process's life short-circuits on the `Set` and is dropped as a
   * duplicate. The retry is the platform's attempt to save the message the
   * failure lost, and the poisoned entry is what silently discarded it.
   * Letting the throw propagate with the Set untouched fails open instead: the
   * retry is reprocessed.
   *
   * Synchronous on purpose: the durable store is synchronous too
   * (`@ethosagent/sqlite` has no async API), and awaiting here would reorder
   * the inbound pipeline for every message to pay for a cold-start edge.
   */
  private recordSighting(message: InboundMessage, botKey: string, key: string): boolean {
    const duplicate =
      this.inboundDedup && message.messageId
        ? this.inboundDedup.seen(message.platform, botKey, message.chatId, message.messageId)
        : false;
    this.rememberSeen(key);
    return duplicate;
  }

  /** Add a key to the in-memory `Set`, bounded to `dedupWindow` entries. */
  private rememberSeen(key: string): void {
    this.seenMessages.add(key);
    if (this.seenMessages.size > this.dedupWindow) {
      const first = this.seenMessages.values().next().value;
      if (first !== undefined) this.seenMessages.delete(first);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API — adapters call this for every inbound message
  // ---------------------------------------------------------------------------

  /**
   * The synchronous dedup + spool step for one inbound message, split out of
   * `handleMessage` so the inbound wiring can run it BEFORE the platform's
   * webhook is acknowledged (plan reach-and-containment §2.5): an adapter's
   * `onMessage` callback runs inside the platform framework's request handler
   * (grammy's `webhookCallback`, Bolt's `HTTPReceiver`), so whatever this
   * does synchronously is on disk before that framework writes its 200.
   *
   * ORDER (plan openclaw-9.5-adoption item 2): the in-memory `Set` first, then
   * the spool row, and only THEN the durable dedup sighting. The two durable
   * writes are separate files (`inbound-spool.db`, `inbound-dedup.db`) and
   * cannot share a transaction, so the order decides what a crash between them
   * leaves behind:
   *
   *  - Sighting first (the order this replaced): a crash after the sighting and
   *    before the row lost the message — no row to replay, and the platform's
   *    retry was dropped as a duplicate.
   *  - Row first (this order): a crash after the row and before the sighting
   *    leaves a row that `replayInboundSpool` answers, and the retry is dropped
   *    by the spool's own `UNIQUE (platform, bot_key, chat_id, message_id)` key
   *    (`accept` → `fresh: false`). Never lost, never billed twice.
   *
   * The sighting is still recorded after the row, and a sighting the spool did
   * not know about (a message a spool-write failure let through undurably, or
   * one a pre-spool build saw) closes the fresh row and drops the message: that
   * is a platform retry of something already answered. Pinned by
   * `__tests__/inbound-spool.test.ts` ('dedup ordering').
   *
   * Never throws for a spoolable message. A spool write that fails is recorded
   * (`gateway.spool_write_failed`) and the message falls back to the dedup-only
   * path WITHOUT a row — fail-open. Returning a 500 instead would buy nothing:
   * the message would be refused while the gateway is up, which is worse than
   * answering it undurably.
   *
   * While shutting down it records nothing (`handleMessage` then refuses the
   * message before any sighting, as it always has).
   */
  acceptInbound(message: InboundMessage): InboundAcceptance {
    if (this.closing) return { fresh: true };
    // Drop duplicates BEFORE any work — billing-relevant. See OpenClaw #71761
    // (channel messages injected twice → 2× cost). Use the resolved botKey
    // (message.botKey or the synthesized default) so multi-bot routing
    // doesn't accidentally cross-dedupe. Edited messages (`isEdit: true`)
    // bypass dedup because they intentionally re-use the same `messageId`
    // with different content.
    // NOTE (GWA-008): dedup/clarify are intentionally keyed on this
    // pre-resolution `dedupBotKey`, not the authoritative `bot.botKey`
    // resolved further below. Dedup must run BEFORE any work (billing) and
    // before the safety filter can rewrite `message`, so it cannot wait on
    // full resolution. Adapters stamp `botKey` consistently, so the two agree
    // in practice; single-bot has one loop, so a stale/foreign botKey here has
    // no cross-bot effect. The namespace divergence is deliberate, not a bug.
    // The durable backstop (`inboundDedup`) is keyed on the same `dedupBotKey`,
    // so adding it changed nothing about when dedup runs relative to botKey
    // resolution or the safety filter.
    const dedupBotKey = message.botKey ?? this.defaultBotKey ?? '';
    const dedupKey = this.dedupKeyFor(message, dedupBotKey);
    if (dedupKey && this.seenMessages.has(dedupKey)) return { fresh: false };

    // Observe-mode records are not spooled: they owe no turn, their durable
    // record IS the channel transcript, and they arrive on the hot inbound path
    // that store runs at `synchronous = NORMAL` for (CLAUDE.md durability table)
    // — two FULL commits per watched message would undo that.
    // Nor is a message no replay could ever answer: one whose bot has no
    // adapter on its platform (`adapterForBot` — exactly what
    // `replaySpoolRow` resolves). That is every message handed in with a
    // per-request capturing adapter: a watcher wake (`platform: 'watcher'`) and
    // a generic inbound webhook route (`webhook:<hookId>`, adapterless by
    // design). Their reply goes to that one request — an HTTP response, a
    // watcher's forward — which a restart has already lost, so a row would be
    // owed work nobody can deliver: counted `deferred` on every sweep, never
    // dead-lettered, never pruned. The webhook's caller retries its own POST,
    // and a watcher re-detects on its next tick. Pinned by
    // `__tests__/inbound-spool.test.ts` ('capturing adapters').
    const spool = this.inboundSpool;
    const spooled =
      spool && !message.recordOnly && this.replayable(message)
        ? this.spoolInbound(spool, message)
        : null;
    if (spooled) {
      if (!spooled.fresh) {
        // Already spooled: a platform redelivery (plan §2.5). The spool's
        // UNIQUE key is the dedup answer restated — except with dedup switched
        // off (`dedupWindow: 0`), where it must not become dedup by the back
        // door: the message runs, without a row.
        if (dedupKey) this.rememberSeen(dedupKey);
        return { fresh: this.dedupWindow <= 0 };
      }
      if (dedupKey) {
        let duplicate = false;
        try {
          duplicate = this.recordSighting(message, dedupBotKey, dedupKey);
        } catch (err) {
          // The row is on disk and IS this message's dedup record from here
          // on, so a failed sighting costs nothing: record it and go on. (The
          // `Set` poisoning `recordSighting` guards against cannot lose this
          // message — it is spooled.)
          this.rememberSeen(dedupKey);
          this.observability?.recordSafetyBlock({
            code: 'gateway.dedup_write_failed',
            cause: 'inbound dedup sighting failed after the spool row was written',
            details: {
              platform: message.platform,
              chatId: message.chatId,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
        if (duplicate) {
          this.closeSpool(spooled.id);
          return { fresh: false };
        }
      }
      return { fresh: true, spoolId: spooled.id, claimed: spooled.claimed };
    }

    // No spool (or not spoolable, or its write failed): dedup alone.
    if (dedupKey && this.recordSighting(message, dedupBotKey, dedupKey)) return { fresh: false };
    return { fresh: true };
  }

  /** Whether `replaySpoolRow` could resolve an adapter for this message's row. */
  private replayable(message: InboundMessage): boolean {
    return this.adapterForBot(this.routedBotKey(message), message.platform) !== undefined;
  }

  /**
   * Write one message's spool row, keyed and routed exactly as the turn will
   * be: the routed botKey (`routedBotKey`, the one derivation
   * `refuseWhileClosing` shares) and the lane key built from it. `null` when
   * the write threw (recorded as `gateway.spool_write_failed`).
   */
  private spoolInbound(
    spool: InboundSpool,
    message: InboundMessage,
  ): { id: string; fresh: boolean; claimed: boolean } | null {
    const botKey = this.routedBotKey(message);
    const threadId = message.threadId ? message.threadId : undefined;
    const laneKey = laneKeyOf(message.platform, botKey, message.chatId, threadId);
    const claimed = !this.replaying;
    try {
      const { id, fresh } = spool.accept({
        platform: message.platform,
        botKey,
        chatId: message.chatId,
        ...(threadId ? { threadId } : {}),
        messageId: spoolMessageId(message),
        laneKey,
        payload: serializeInbound(message),
        claimedBy: claimed ? this.spoolOwner : null,
      });
      return { id, fresh, claimed };
    } catch (err) {
      this.observability?.recordSafetyBlock({
        code: 'gateway.spool_write_failed',
        cause: 'inbound spool accept failed — message processed without a durable row',
        details: {
          platform: message.platform,
          chatId: message.chatId,
          botKey,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return null;
    }
  }

  async handleMessage(
    message: InboundMessage,
    adapter: PlatformAdapter,
    opts: HandleMessageOptions = {},
  ): Promise<void> {
    // Shutting down: nothing new starts. Checked BEFORE dedup on purpose — a
    // refused message is never recorded as seen, so a platform that redelivers
    // it to the next process gets it processed rather than dropped as a dupe.
    // A message that already HAS a spool row (replayed, or accepted before the
    // shutdown began) stays owed: the next boot answers it, so it is refused
    // without the "please resend" notice that would contradict that.
    if (this.closing) {
      const spooled = opts.replaySpoolId ?? opts.accepted?.spoolId;
      opts.onQueued?.();
      await this.refuseWhileClosing(message, adapter, spooled ? {} : this.closing);
      return;
    }

    let spoolId: string | undefined;
    if (opts.replaySpoolId) {
      spoolId = opts.replaySpoolId;
    } else {
      const accepted = opts.accepted ?? this.acceptInbound(message);
      if (!accepted.fresh) {
        opts.onQueued?.();
        return;
      }
      spoolId = accepted.spoolId;
      // Arrived mid-replay: spooled unclaimed and NOT run here. The replay's
      // re-list picks it up behind the older rows of its lane (plan D2-5).
      if (spoolId && accepted.claimed === false) {
        opts.onQueued?.();
        return;
      }
    }

    // Every path through `dispatchInbound` that does not hand the message to a
    // turn (or fold it into a running one) closes its row here — so an early
    // return added to that function later cannot leak a `received` row that
    // replays on every boot. Pinned by `__tests__/inbound-spool.test.ts`.
    let handedOff = false;
    const handOff = (): void => {
      handedOff = true;
      opts.onQueued?.();
    };
    try {
      await this.dispatchInbound(message, adapter, spoolId, handOff, {
        replay: opts.replaySpoolId !== undefined,
      });
    } finally {
      if (spoolId && !handedOff) this.closeSpool(spoolId);
      opts.onQueued?.();
    }
  }

  /**
   * `handleMessage`'s body past dedup and the spool write. `ctx.replay` marks
   * a spool-replay re-entry: the H3 queued/absorbed acks stay silent there —
   * replay was ack-silent before H3, and a reconnect that greets the user
   * with "⏳ queued (2nd)…" per recovered row is noise, not feedback. Pinned
   * by `__tests__/inbound-spool.test.ts` ('replay sends no H3 acks').
   */
  private async dispatchInbound(
    message: InboundMessage,
    adapter: PlatformAdapter,
    spoolId: string | undefined,
    handOff: () => void,
    ctx: { replay: boolean },
  ): Promise<void> {
    // Pre-resolution botKey — see the GWA-008 note in `acceptInbound`.
    const dedupBotKey = message.botKey ?? this.defaultBotKey ?? '';

    // --- Interrupted-message `retry` (plan openclaw-9.5-adoption D5) ---
    // Looked up FIRST, acted on LATER. The lookup is here because an exact
    // `retry` for a lane holding an interrupted row must skip the clarify
    // correlator below: a clarify the crashed turn left pending would
    // otherwise swallow it as that dead question's answer. The row is only
    // retried — or, for any other message, discarded — after the safety filter
    // and bot resolution (`settleInterrupted`), so a sender the filter drops
    // can neither re-run nor cancel someone's interrupted actions, and a
    // slash command (`/new`, `/stop`) counts as "any other message". Observe-
    // mode records never touch it: they are not addressed to the agent.
    const interrupted = message.recordOnly ? null : this.pendingInterrupted(message);
    const retryRequested =
      interrupted !== null && isRetryText(message.text, adapterHandle(adapter));

    // --- Clarify correlator: short-circuit force-reply + `/cancel` ---
    // Runs BEFORE the safety filter's mention gate so an approved sender's
    // force-reply isn't treated as a fresh agent prompt (the agent is
    // already paused inside `clarify()` waiting on this answer). But we
    // still gate on the *allowlist* portion of the safety filter — a
    // non-allowlisted sender in a group chat must NOT be able to resolve
    // the bot's pending clarify (that would be an authentication bypass,
    // not just a routing shortcut).
    if (this.clarifyCorrelator && !retryRequested) {
      const platformCfg = this.channelFilter?.[message.platform];
      if (isSenderAllowed(message, platformCfg)) {
        const resp = await this.clarifyCorrelator(message).catch(() => null);
        if (resp) {
          const bot = this.bots.get(dedupBotKey);
          await bot?.loop.clarifyBridge?.respond(resp);
          return;
        }
      }
    }

    // --- Observe mode: record and stop (plan R1/R2) ---
    // The adapter has already run `evaluateChannelMode` and told us this room
    // is watched, not answered. Recording is the whole of the work.
    //
    // WHERE THIS SITS IS THE DECISION:
    //
    //  * AFTER dedup, so a platform re-delivery does not re-audit the same
    //    message. (The store upserts on `(lane_key, message_id)`, so the row
    //    itself would survive a double write — the audit event would not.)
    //
    //  * BEFORE `checkMessage`. R2: observe mode records EVERY message the
    //    platform delivers, allowlisted sender or not. That is not a hole in
    //    the sender allowlist — recording runs no turn, calls no tool and
    //    sends nothing, so there is no capability for a stranger to reach.
    //    The allowlist exists to stop strangers from *driving the agent*; the
    //    boundary for this data moves downstream to the digest turn, which
    //    reads the transcript with an empty toolset (R9). Filtering here
    //    instead would produce a transcript of a group conversation with
    //    every non-owner's half missing — a digest of nothing.
    //
    //  * AFTER the clarify correlator above, and that IS a hole in the
    //    transcript — a known one, left open deliberately. A message in a
    //    watched room that answers a clarify the agent is already blocked on
    //    is consumed by `clarifyCorrelator` and returns before it reaches this
    //    block, so it is never recorded. Reaching it needs a clarify pending
    //    in this very chat (the correlator matches on the pending route's
    //    chatId, and only on Telegram and WhatsApp — see
    //    `registerGatewayClarifySurfaces` in apps/ethos/src/commands/gateway),
    //    which observe mode normally makes impossible: the agent never speaks
    //    in a watched room, so the realistic path is a room switched from
    //    respond to observe with a clarify still outstanding.
    //
    //    Recording first and correlating second would close it, and was not
    //    done: the message would then be kept for `retention.channelTranscript`
    //    AND summarised into the owner's digest DM, so the fix retains more
    //    third-party text and delivers it further than the hole does. Nothing
    //    enforces the ordering beyond the two blocks' position in this
    //    function; there is no test pinning it either way.
    //
    // Returns unconditionally: with no store wired, a `recordOnly` message is
    // dropped, which is what happened before observe mode existed.
    if (message.recordOnly) {
      // This process's own clock, so it needs no guard — and it is also the
      // fallback the adapter-supplied `sentAt` falls back TO, which is why it
      // is read once rather than twice.
      const recordedAt = Date.now();
      try {
        await this.channelTranscript?.record({
          platform: message.platform,
          botKey: dedupBotKey,
          chatId: message.chatId,
          ...(message.threadId ? { threadId: message.threadId } : {}),
          senderId: message.userId ?? '',
          ...(message.username ? { senderName: message.username } : {}),
          text: message.text,
          ...(message.messageId ? { messageId: message.messageId } : {}),
          // The substitution is HERE, at the call site, and not hidden behind a
          // default in the store: `sentAt` is optional on the wire, and a row
          // whose timestamp is our clock reading must be a visible choice.
          //
          // `??` alone was not enough, and the gap cost a message. `NaN` is
          // not nullish, so an adapter forwarding a platform field that parsed
          // badly — `new Date(undefined).getTime()`, a missing
          // `createdTimestamp` — passed straight through into a STRICT
          // `INTEGER NOT NULL` column and ABORTED the insert. The observed
          // message was then gone, with only a `channel.observed_failed`
          // event to show for it. See `transcriptTimestamp`.
          sentAt: transcriptTimestamp(message.sentAt) ?? recordedAt,
          recordedAt,
        });
        this.observability?.recordSafetyBlock({
          code: 'channel.observed',
          details: {
            platform: message.platform,
            chatId: message.chatId,
            userId: message.userId ?? '',
          },
        });
      } catch (err: unknown) {
        // A full disk or a locked database must not take the inbound path
        // down — and must not fall through to a turn either. The message is
        // lost; the event is how the operator finds out (the UI turns this
        // into a persistent "recording stopped" row).
        this.observability?.recordSafetyBlock({
          code: 'channel.observed_failed',
          cause: 'channel transcript write failed',
          details: {
            platform: message.platform,
            chatId: message.chatId,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
      return;
    }

    // --- Chapter 1: before_inbound channel safety filter ---
    if (this.channelFilter) {
      const platformCfg = this.channelFilter[message.platform];
      const filterResult = checkMessage(message, platformCfg, this.pairingDb);

      if (filterResult.action === 'drop') {
        // Emit audit event for observability
        this.observability?.recordSafetyBlock({
          code: message.isDm ? 'channel.allowlist.blocked' : 'channel.mention_gate',
          details: {
            platform: message.platform,
            chatId: message.chatId,
            userId: message.userId ?? '',
            isDm: message.isDm,
            isGroupMention: message.isGroupMention,
          },
        });
        return;
      }

      if (filterResult.action === 'pairing_reply') {
        this.recordPairing(message, 'issued');
        await adapter
          .send(message.chatId, {
            text: filterResult.reply ?? '',
            // H6 — into the thread it was asked in, like every other ack.
            ...(message.threadId ? { threadId: message.threadId } : {}),
          })
          .catch(() => {});
        return;
      }

      if (filterResult.action === 'decline_reply') {
        // `dmPolicy: decline` (plan hermes-0.22-hardening §6.2/§6.3). One fixed
        // refusal per sender per window, never a turn, never a ledger obligation:
        // the send is untracked like the slash-ack class (D17), so a refusal lost
        // to a crash is lost rather than redelivered hours later.
        // Pinned by `extensions/gateway/src/__tests__/dm-decline.test.ts`.
        const laneKey = laneKeyOf(message.platform, dedupBotKey, message.chatId, message.threadId);
        const reply = filterResult.reply ?? '';
        const outcome = this.declineOutcome(message, dedupBotKey, laneKey);
        // No message text and no reply text in the audit row.
        this.observability?.recordSafetyBlock({
          code: 'channel.allowlist.blocked',
          details: {
            platform: message.platform,
            chatId: message.chatId,
            userId: message.userId ?? '',
            isDm: true,
            decline: outcome,
          },
        });
        if (outcome === 'sent' && this.outboundDedup.shouldSend(laneKey, reply)) {
          await adapter
            .send(message.chatId, {
              text: reply,
              ...(message.threadId ? { threadId: message.threadId } : {}),
            })
            .catch(() => {});
        }
        // Not handed off: `handleMessage`'s finally closes the spool row.
        return;
      }

      // 'allow' — if context was stripped, use stripped text for the turn
      if (filterResult.strippedText !== undefined) {
        this.observability?.recordSafetyBlock({
          code: 'channel.context_stripped',
          details: {
            platform: message.platform,
            chatId: message.chatId,
            userId: message.userId ?? '',
            replyToId: message.replyToId,
          },
        });
        message = { ...message, text: filterResult.strippedText };
      }

      // …and the same for the channel-history block the adapter attached.
      // Empty means nothing survived the allowlist: drop the field outright
      // rather than prepend an empty wrapper to the turn.
      if (filterResult.strippedPriorContext !== undefined) {
        this.observability?.recordSafetyBlock({
          code: 'channel.prior_context_stripped',
          details: {
            platform: message.platform,
            chatId: message.chatId,
            userId: message.userId ?? '',
            dropped: filterResult.strippedPriorContext === '',
          },
        });
        message = {
          ...message,
          priorContext:
            filterResult.strippedPriorContext === ''
              ? undefined
              : filterResult.strippedPriorContext,
          priorContextEntries: undefined,
        };
      }
    }

    // Resolve which bot this message is for. `message.botKey` wins when
    // adapters populate it; single-bot deployments fall back to the
    // synthesized default. The degrade-to-default fallback below is
    // reachable in SINGLE-BOT mode ONLY: `this.defaultBotKey` is null in
    // multi-bot deployments (see constructor), so a multi-bot message with
    // an unknown botKey is dropped at `no_bot_available` rather than routed
    // to another bot's loop — cross-bot isolation is preserved.
    const claimedBotKey = message.botKey ?? this.defaultBotKey ?? '';
    const botKey = this.routedBotKey(message);
    if (botKey !== claimedBotKey) {
      // Graceful fallback (single-bot only — `defaultBotKey` is null in
      // multi-bot): an unknown botKey degrades to the sole bot rather than
      // silently dropping. The observability event lets operators spot a
      // misconfigured adapter that is stamping the wrong botKey.
      this.observability?.recordSafetyBlock({
        code: 'gateway.unknown_botKey',
        details: {
          platform: message.platform,
          chatId: message.chatId,
          botKey: message.botKey,
          fallback: this.defaultBotKey,
        },
      });
    }
    const bot = botKey ? this.bots.get(botKey) : undefined;
    if (!bot) {
      this.observability?.recordSafetyBlock({
        code: 'gateway.no_bot_available',
        details: { platform: message.platform, chatId: message.chatId, botKey },
      });
      return;
    }

    // Retiring (`removeAdapter` is draining it): the routing entry and the
    // loop wiring are deliberately still here so work accepted BEFORE the
    // removal finishes under them — but nothing new may be admitted, or the
    // drain would chase a queue that keeps refilling.
    if (this.retiringBots.has(bot.botKey)) {
      this.observability?.recordSafetyBlock({
        code: 'gateway.bot_retiring',
        details: { platform: message.platform, chatId: message.chatId, botKey: bot.botKey },
      });
      return;
    }

    // Fix 5 (pi-delegation.md D7) — an ordinary inbound message establishes
    // presence too, not just answering a clarify (the clarify surfaces'
    // `correlateMessage`/`handleAction` paths above already record it for
    // that case). Otherwise a background job's later question only ever
    // routes to wherever the human last happened to answer a clarify, never
    // to wherever they're just casually chatting.
    if (isClarifySurfaceType(message.platform)) {
      bot.loop.clarifyBridge?.recordPresence(message.platform, {
        chatId: message.chatId,
        botKey: bot.botKey,
        ...(message.threadId ? { threadId: message.threadId } : {}),
      });
    }

    // Adapters that surface a thread identifier (currently only Slack, via
    // `thread_ts`) get a per-thread lane so concurrent threads in the same
    // channel never share session state. Adapters without thread semantics
    // omit `threadId` and the key degrades to the unthreaded form.
    //
    // Empty-string `threadId` is treated as no thread: the contract is
    // `threadId?: string`, but an empty string carries no routing signal,
    // and admitting it would mean a misbehaving adapter could quietly
    // build a thread lane keyed on `''` — distinct from the unthreaded
    // root but holding only its mistakes.
    const threadId = message.threadId ? message.threadId : undefined;
    const laneKey = threadId
      ? buildLaneKey(message.platform, bot.botKey, message.chatId, threadId)
      : buildLaneKey(message.platform, bot.botKey, message.chatId);
    // A bot added live may still be reading its lane file (`laneRestores`).
    const restoring = this.pendingLaneRestore(bot.botKey);
    if (restoring) await restoring;
    const lane = this.getOrCreateLane(laneKey);
    const rawText = message.text?.trim() ?? '';
    // `/cmd@this_bot` reads as `/cmd` in every lookup below; `/cmd@other_bot`
    // is another bot's command and is dropped here, BEFORE the interrupted-row
    // settlement, so it neither answers nor discards anything
    // (`commandForThisBot`).
    const text = commandForThisBot(
      bot.piiRedaction ? redactPii(rawText) : rawText,
      adapterHandle(adapter),
    );
    if (text === null) {
      this.observability?.recordSafetyBlock({
        code: 'gateway.command_for_other_bot',
        details: { platform: message.platform, chatId: message.chatId, botKey: bot.botKey },
      });
      return;
    }

    // --- Interrupted-message `retry` / discard (see the lookup at the top) ---
    if (interrupted) {
      const settled = await this.settleInterrupted(
        interrupted,
        retryRequested && isRetryText(rawText, adapterHandle(adapter)),
      );
      if (settled === 'consumed') return;
      if (settled) {
        // The `retry` message itself is consumed here; the interrupted turn runs
        // under its new row through the ordinary path — the safety filter above
        // already passed for THIS sender, and the replayed payload is filtered
        // again as its own message.
        if (spoolId) this.closeSpool(spoolId);
        handOff();
        await this.handleMessage(settled.message, adapter, { replaySpoolId: settled.spoolId });
        return;
      }
    }

    // --- Gateway-level slash command handling ---

    const cmdToken = text.split(/\s+/)[0] ?? '';
    const cmdType = PLATFORM_COMMANDS[cmdToken.toLowerCase()];

    if (cmdType === 'stop') {
      // H6 — `✓ Stopped.` only when something is actually running or queued
      // on this lane. `lane.length` counts the running turn (the lane task is
      // `processing`) plus everything queued behind it; `activeSinks` /
      // `activeTurns` cover the turn-end tail, where the sink is unhooked but
      // the turn still holds the lane.
      const running =
        lane.length > 0 || this.activeSinks.has(laneKey) || this.activeTurns.has(laneKey);
      const stopRef = text.split(/\s+/)[1];
      let laneRows: BackgroundJob[] | undefined;
      if (stopRef && isJobRef(stopRef)) {
        // `/stop <id>` ends one background job of THIS lane (D9, D13); a ref
        // that names none falls through to the plain lane stop below.
        const stopped = await stopJobByRef(
          this.jobCommandContext(bot, message, threadId, adapter),
          stopRef,
        );
        if (stopped.reply !== null) {
          await adapter.send(message.chatId, { text: stopped.reply, threadId }).catch(() => {});
          return;
        }
        laneRows = stopped.rows;
      }
      if (running) {
        lane.abort();
        // UBP-046 — a turn parked on an approval card does not see the abort
        // until the card settles; tell the approval surface so it settles now.
        this.notifyLaneStop(this.sessionKeys.get(laneKey) ?? laneKey);
        await adapter.send(message.chatId, { text: '✓ Stopped.', threadId }).catch(() => {});
      } else {
        // D9 — a plain /stop never touches jobs (they outlive turns), but when
        // the lane has active ones, say so and how to stop one.
        const jobs = await activeLaneJobSummary(
          this.jobCommandContext(bot, message, threadId, adapter),
          laneRows,
        ).catch(() => '');
        await adapter
          .send(message.chatId, {
            text: jobs
              ? `nothing is running — background: ${jobs} · /stop <id> to stop one`
              : 'nothing is running',
            threadId,
          })
          .catch(() => {});
      }
      return;
    }

    if (cmdType === 'new') {
      lane.abort();
      const previousSession = this.sessionKeys.get(laneKey) ?? laneKey;
      // The abort only raises a signal: let the aborted turn finish writing
      // before the scrub, or its partial reply lands after the blanking.
      if (this.incognitoLanes.has(laneKey)) await this.settleAbortedLane(laneKey, lane);
      const wasIncognito = this.incognitoLanes.delete(laneKey);
      this.rotateLaneSession(laneKey, previousSession);
      this.usageStore.delete(laneKey);
      this.personalityIds.delete(laneKey); // reset to default personality
      // Voice mode deliberately SURVIVES /new: it is a durable per-lane
      // preference ("talk to me out loud in this chat"), not session state, and
      // a preference a /new wipes is not durable in any sense the user would
      // recognise. `lastInboundHadAudio` IS per-turn state and still clears.
      this.lastInboundHadAudio.delete(laneKey);
      await this.persistLaneSessions(laneKey);
      const ack = wasIncognito
        ? (await this.scrubEndedIncognito(laneKey, previousSession))
          ? 'Incognito off. That chat’s history was cleared. New session started.'
          : 'Incognito off. New session started. That chat’s history could not be cleared just now; it is cleared within 24 h.'
        : '✓ New session started.';
      await adapter.send(message.chatId, { text: ack, threadId }).catch(() => {});
      return;
    }

    if (cmdType === 'incognito') {
      if (this.incognitoRefused(message)) {
        await adapter
          .send(message.chatId, { text: INCOGNITO_REFUSED_TEXT, threadId })
          .catch(() => {});
        return;
      }
      if (this.incognitoLanes.has(laneKey)) {
        await adapter
          .send(message.chatId, {
            text: 'Already incognito. Send /new to end it and clear this chat’s history.',
            threadId,
          })
          .catch(() => {});
        return;
      }
      lane.abort();
      this.rotateLaneSession(laneKey, this.sessionKeys.get(laneKey) ?? laneKey);
      this.incognitoLanes.add(laneKey);
      await this.persistLaneSessions(laneKey);
      await adapter
        .send(message.chatId, {
          text: 'Incognito on. Nothing from this chat is remembered or learned from. History is cleared when you send /new, or 24 h after each message.',
          threadId,
        })
        .catch(() => {});
      return;
    }

    if (cmdType === 'fork' || cmdType === 'branches' || cmdType === 'branch') {
      await this.handleBranchCommand(cmdType, text, laneKey, lane, bot, message, adapter, threadId);
      return;
    }

    if (cmdType === 'help') {
      const current = this.activePersonalityFor(laneKey, bot);
      const personalityLines = this.personalitySwitchAllowed(bot)
        ? [
            `/personality — show current personality (${current})`,
            `/personality list — available personalities`,
            `/personality <id> — switch personality`,
          ]
        : [`/personality — show current binding (${current}; switching disabled)`];
      let helpText =
        `/new — start a fresh session\n` +
        `/incognito — keep nothing from this chat in memory or learning\n` +
        `/fork — branch this session (same history, new session)\n` +
        `/branches — list this session's branches\n` +
        `/branch <n> — switch to branch <n>\n` +
        `/stop — abort current response\n` +
        `${personalityLines.join('\n')}\n` +
        `/usage — token and cost stats\n` +
        `/status — usage plus personality · model · session\n` +
        `/channel [show] — this room's prompt policy (show: owner, in a DM)\n` +
        `/budget [reset] — session spend against its cap\n` +
        `/compact [focus] — compress older context now\n` +
        `/voice — set voice reply mode (off|mirror_inbound|all)\n` +
        `/mute <30m|2h|1d|off> — hold notices in this chat for a while\n` +
        `/help — this message`;
      const pluginCmds = this.pluginLoader?.getAllSlashCommands() ?? [];
      if (pluginCmds.length > 0) {
        const pluginLines = pluginCmds
          .map((c) => `/${c.name} — ${c.description} [plugin]`)
          .join('\n');
        helpText += `\n\n${pluginLines}`;
      }
      await adapter
        .send(message.chatId, {
          text: helpText,
          threadId,
        })
        .catch(() => {});
      return;
    }

    if (cmdType === 'start') {
      const personalityId = this.activePersonalityFor(laneKey, bot);
      if (this.greetingProvider) {
        const greeting = await this.greetingProvider.greet(personalityId).catch(() => null);
        if (greeting) {
          await adapter.send(message.chatId, { text: greeting, threadId }).catch(() => {});
          return;
        }
      }
      await adapter
        .send(message.chatId, {
          text: `Hello! I'm running as *${personalityId}*. Send a message to get started, or try /help for available commands.`,
          threadId,
        })
        .catch(() => {});
      return;
    }

    if (cmdType === 'personality') {
      // Refresh from disk before resolving so a newly dropped or edited
      // personality is visible to this command. Seam absent → no-op. Fail-open:
      // a refresh that throws (e.g. malformed personality YAML on disk) must not
      // abort the command — the seam impl logs; we proceed with the last-good
      // registry (stale-but-alive beats a dead command).
      await this.personalityDirectory?.refresh().catch(() => {});
      const arg = text.split(/\s+/).slice(1).join(' ').trim();
      const current = this.activePersonalityFor(laneKey, bot);

      if (!arg) {
        await adapter
          .send(message.chatId, { text: `Current personality: ${current}`, threadId })
          .catch(() => {});
        return;
      }

      // `/personality rich` — full character sheet. Works for personality
      // bindings even when switching is disabled; team bindings fall through
      // to the compact view.
      if (
        arg.toLowerCase() === 'rich' &&
        this.personalityCardReader &&
        bot.binding.type === 'personality'
      ) {
        const card = await this.personalityCardReader.read(current).catch(() => null);
        if (card) {
          await adapter.send(message.chatId, { text: card.text, threadId }).catch(() => {});
          return;
        }
      }

      // Identity-bound bots reject the switch — the bot's external
      // identity is the routing contract. The user sees a clear pointer
      // to the right surface to switch to. Team-bots reject regardless
      // of allowSlashSwitch because the coordinator is structurally part
      // of the loop, not a runtime hat.
      if (!this.personalitySwitchAllowed(bot)) {
        await adapter
          .send(message.chatId, {
            text:
              `This bot is bound to ${bot.binding.type} '${bot.binding.name}'. ` +
              `Switching personalities is disabled for identity-bound bots. ` +
              `To talk to a different agent, message that agent's bot.`,
            threadId,
          })
          .catch(() => {});
        return;
      }

      if (arg === 'list') {
        const dir = this.personalityDirectory;
        const listText = dir
          ? `${dir
              .list()
              .map((p) => `${p.id} — ${p.name}${p.isDefault ? ' (default)' : ''}`)
              .join('\n')}\n\nUse /personality <id> to switch.`
          : 'Built-in personalities: researcher · engineer · reviewer · coach · operator\n\nUse /personality <id> to switch.';
        await adapter.send(message.chatId, { text: listText, threadId }).catch(() => {});
        return;
      }

      // A switch is lane-wide: in a group it changes the agent for people who
      // did not ask, so only the configured owner may make it (plan D20). A
      // group on a platform with no `ownerUserId` refuses outright (D21) —
      // there is no one to trust. DMs keep the old behavior: the requester is
      // the only human in the lane. The read-only forms above stay open.
      // Pinned by extensions/gateway/src/__tests__/personality-switch-owner.test.ts.
      if (!message.isDm && !this.isOwner(message)) {
        const text =
          this.channelFilter?.[message.platform]?.ownerUserId === undefined
            ? `Switching personalities in a group needs an owner. ` +
              `Set channel_filter.${message.platform}.ownerUserId in config.yaml.`
            : `Only the bot owner can switch personalities in a group.`;
        await adapter.send(message.chatId, { text, threadId }).catch(() => {});
        return;
      }

      // Validate against the registry before storing the id. Unknown ids must
      // never be stored — turn-setup's `?? getDefault()` would then silently run
      // the default personality. With the seam wired, validate against the
      // just-refreshed seam registry; without it (standalone/test), fall back to
      // this bot's own loop registry so validation is never skipped. If neither
      // can validate, treat the id as unknown (surface not-found, store nothing)
      // rather than storing an unverified id.
      const known = this.personalityDirectory
        ? this.personalityDirectory.has(arg)
        : typeof bot.loop.getPersonalityIds === 'function'
          ? bot.loop.getPersonalityIds().includes(arg)
          : false;
      if (!known) {
        await adapter
          .send(message.chatId, {
            text: `Personality '${arg}' not found — /personality list to see what's available.`,
            threadId,
          })
          .catch(() => {});
        return;
      }

      // Switch personality — also start a fresh session so the new identity takes effect immediately
      const previousSession = this.sessionKeys.get(laneKey) ?? laneKey;
      // An incognito lane keeps its flag across this rotation, so the session
      // it leaves would never be scrubbed by a later `/new` (which scrubs only
      // the current key): stop its turn, let it settle, and scrub it now.
      const leavingIncognito = this.incognitoLanes.has(laneKey);
      if (leavingIncognito) {
        lane.abort();
        await this.settleAbortedLane(laneKey, lane);
      }
      this.outboundDedup.clearSession(previousSession);
      void this.attachmentCache?.clear(previousSession).catch(() => {});
      this.personalityIds.set(laneKey, arg);
      const fresh = `${laneKey}:${Date.now()}`;
      this.sessionKeys.set(laneKey, fresh);
      await this.persistLaneSessions(laneKey);
      if (leavingIncognito) await this.scrubEndedIncognito(laneKey, previousSession);
      await adapter
        .send(message.chatId, {
          text: `✓ Switched to ${arg} personality. New session started.`,
          threadId,
        })
        .catch(() => {});
      return;
    }

    if (cmdType === 'usage') {
      const u = this.usageStore.get(laneKey) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      await adapter
        .send(message.chatId, {
          text: `Tokens: ${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out\nCost: $${u.costUsd.toFixed(5)}`,
          threadId,
        })
        .catch(() => {});
      return;
    }

    // H6/UD5 — a DISTINCT command, not an alias: `/usage` stays the numbers,
    // `/status` adds where you are (personality · model · session).
    if (cmdType === 'status') {
      const u = this.usageStore.get(laneKey) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      const personalityId = this.activePersonalityFor(laneKey, bot);
      // The personality's configured model (a role or registry alias) — the
      // gateway never resolves provider rungs itself. Stub loops in tests
      // (and team bindings) fall back to `default`.
      let model = 'default';
      try {
        if (typeof bot.loop.resolvePersonality === 'function') {
          model = resolveModelDisplay(
            bot.loop.resolvePersonality(bot.binding.type === 'team' ? undefined : personalityId)
              .model,
            'default',
          );
        }
      } catch {
        // Unknown personality id — keep the fallback label.
      }
      const sessionKey = this.sessionKeys.get(laneKey) ?? laneKey;
      await adapter
        .send(message.chatId, {
          text:
            `Tokens: ${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out\n` +
            `Cost: $${u.costUsd.toFixed(5)}\n` +
            `${personalityId} · ${model} · ${sessionKey}` +
            (this.incognitoLanes.has(laneKey) ? '\nIncognito: on' : ''),
          threadId,
        })
        .catch(() => {});
      return;
    }

    if (cmdType === 'channel') {
      await this.rooms.handleChannelCommand(text, message, adapter, threadId);
      return;
    }

    if (cmdType === 'budget') {
      const ownerUserId = this.channelFilter?.[message.platform]?.ownerUserId;
      const personalityId =
        bot.binding.type === 'team'
          ? undefined
          : (this.personalityIds.get(laneKey) ?? bot.binding.name);
      const deps = {
        sessionKey: this.sessionKeys.get(laneKey) ?? laneKey,
        ownerUserId,
        isOwner: this.isOwner(message),
        personalityId,
        spentToday: () => this.spentToday(bot, message.platform),
      };
      await handleBudgetCommand(deps, text, bot, message, adapter, threadId);
      return;
    }

    if (cmdType === 'mcp') {
      await this.handleMcpCommand(message, adapter, bot, laneKey, threadId, text);
      return;
    }

    if (cmdType === 'allow') {
      const code = text.split(/\s+/)[1]?.toUpperCase() ?? '';
      if (!code || !this.pairingDb || !this.channelFilter) {
        await adapter
          .send(message.chatId, { text: '✗ Pairing not configured or no code given.', threadId })
          .catch(() => {});
        return;
      }

      // Verify the caller is the configured owner for the code's platform before consuming.
      // This prevents allowlisted non-owners from approving pairings.
      const codeRow = this.pairingDb
        .prepare('SELECT platform FROM pairing_codes WHERE code = ?')
        .get(code) as { platform: string } | undefined;

      if (codeRow) {
        const codePlatformCfg = this.channelFilter[codeRow.platform];
        if (!senderIsOwner(message, codePlatformCfg?.ownerUserId)) {
          this.recordPairing(message, 'not_owner', codeRow.platform);
          await adapter
            .send(message.chatId, { text: '✗ Only the owner may approve pairings.', threadId })
            .catch(() => {});
          return;
        }
      }

      const result = consumeAndAllow(this.pairingDb, code, message.userId);
      if (!result.ok) this.recordPairing(message, result.reason, codeRow?.platform);
      if (result.ok) {
        // Update in-memory cache
        const platformCfg = this.channelFilter[result.platform];
        if (platformCfg) {
          if (!platformCfg.recipientAllowlist) platformCfg.recipientAllowlist = [];
          if (!platformCfg.recipientAllowlist.includes(result.senderId)) {
            platformCfg.recipientAllowlist.push(result.senderId);
          }
        }
        this.observability?.recordChannelAllow({
          code: 'channel.pairing.approved',
          details: {
            approvedUserId: result.senderId,
            approvedPlatform: result.platform,
            byUserId: message.userId,
          },
        });
        await this.onAllowlistChange?.(result.platform, result.senderId, 'add');
        await adapter
          .send(message.chatId, { text: `✓ ${result.senderId} approved.`, threadId })
          .catch(() => {});
      } else if (result.reason === 'owner_paused') {
        await adapter
          .send(message.chatId, {
            text: '✗ Too many invalid attempts. Pairing paused for 24h.',
            threadId,
          })
          .catch(() => {});
      } else {
        await adapter
          .send(message.chatId, { text: '✗ Invalid or expired code.', threadId })
          .catch(() => {});
      }
      return;
    }

    if (cmdType === 'deny') {
      const targetUserId = text.split(/\s+/)[1] ?? '';
      const cleanTarget = targetUserId.replace(/^@/, '');
      if (!cleanTarget || !this.channelFilter) {
        await adapter
          .send(message.chatId, { text: '✗ Usage: /deny <userId>', threadId })
          .catch(() => {});
        return;
      }

      let removed = false;
      for (const [platform, cfg] of Object.entries(this.channelFilter)) {
        // Only the owner can remove senders.
        if (!senderIsOwner(message, cfg.ownerUserId)) continue;

        let removedOnPlatform = false;

        // Remove from in-memory list.
        const list = cfg.recipientAllowlist;
        if (list) {
          const idx = list.indexOf(cleanTarget);
          if (idx !== -1) {
            list.splice(idx, 1);
            removedOnPlatform = true;
          }
        }

        // Revoke from persistent DB — idempotent, catches pairing-approved senders.
        if (this.pairingDb && revokeApproval(this.pairingDb, cleanTarget, platform)) {
          removedOnPlatform = true;
        }

        if (removedOnPlatform) {
          removed = true;
          this.observability?.recordChannelDeny({
            code: 'channel.allowlist.removed',
            details: { removedUserId: cleanTarget, platform, byUserId: message.userId },
          });
          await this.onAllowlistChange?.(platform, cleanTarget, 'remove');
        }
      }

      if (removed) {
        await adapter
          .send(message.chatId, { text: `✓ ${cleanTarget} removed.`, threadId })
          .catch(() => {});
      } else {
        await adapter
          .send(message.chatId, { text: `✗ ${cleanTarget} not found in any allowlist.`, threadId })
          .catch(() => {});
      }
      return;
    }

    if (cmdType === 'communications') {
      if (!this.pairingDb || !this.channelFilter) {
        await adapter
          .send(message.chatId, { text: 'Pairing not configured.', threadId })
          .catch(() => {});
        return;
      }

      const platformCfg = this.channelFilter[message.platform];
      if (!senderIsOwner(message, platformCfg?.ownerUserId)) {
        await adapter
          .send(message.chatId, { text: '✗ Only the owner may use /communications.', threadId })
          .catch(() => {});
        return;
      }

      const subCmd = text.split(/\s+/)[1]?.toLowerCase();

      if (subCmd === 'approve-all') {
        // Scope to platforms where the caller is the configured owner.
        const ownedPlatforms = new Set(
          Object.entries(this.channelFilter)
            .filter(([, cfg]) => senderIsOwner(message, cfg.ownerUserId))
            .map(([p]) => p),
        );

        const pending = this.pairingDb
          .prepare(`SELECT code, platform FROM pairing_codes WHERE status = 'pending'`)
          .all() as { code: string; platform: string }[];

        let approvedCount = 0;
        for (const { code, platform } of pending) {
          if (!ownedPlatforms.has(platform)) continue;
          const result = consumeAndAllow(this.pairingDb, code, message.userId);
          if (result.ok) {
            approvedCount++;
            const cfg = this.channelFilter[result.platform];
            if (cfg) {
              if (!cfg.recipientAllowlist) cfg.recipientAllowlist = [];
              if (!cfg.recipientAllowlist.includes(result.senderId)) {
                cfg.recipientAllowlist.push(result.senderId);
              }
            }
            // Same row as a single `/allow` approval, one per approved sender.
            this.observability?.recordChannelAllow({
              code: 'channel.pairing.approved',
              details: {
                approvedUserId: result.senderId,
                approvedPlatform: result.platform,
                byUserId: message.userId,
              },
            });
            await this.onAllowlistChange?.(result.platform, result.senderId, 'add');
          }
        }

        await adapter
          .send(message.chatId, { text: `✓ Approved ${approvedCount} sender(s).`, threadId })
          .catch(() => {});
        return;
      }

      // Default: list pending codes
      const pending = this.pairingDb
        .prepare(`SELECT code, sender_id, platform FROM pairing_codes WHERE status = 'pending'`)
        .all() as { code: string; sender_id: string; platform: string }[];

      if (pending.length === 0) {
        await adapter
          .send(message.chatId, { text: 'No pending pairing requests.', threadId })
          .catch(() => {});
        return;
      }

      const lines = pending.map((r) => `${r.sender_id} (${r.platform}) — /allow ${r.code}`);
      const reply = `${pending.length} pending pairing request(s):\n${lines.join('\n')}`;
      await adapter.send(message.chatId, { text: reply, threadId }).catch(() => {});
      return;
    }

    // --- /background command ---
    if (cmdType === 'background') {
      const bgText = text.slice('/background '.length).trim();
      if (!bgText) {
        await adapter
          .send(message.chatId, {
            text: '✗ Usage: /background <prompt> | list | steer <id> <text> | stop <id> | tail <id>',
            threadId,
          })
          .catch(() => {});
        return;
      }
      const jobStore = bot.jobStore;
      const executor = bot.backgroundExecutor;
      // Background disabled for this bot (e.g. one-shot / team-bound loop) — the
      // durable engine isn't wired. Reply gracefully instead of crashing.
      if (!jobStore || !executor) {
        await adapter
          .send(message.chatId, {
            text: '✗ Background jobs are not enabled for this bot.',
            threadId,
          })
          .catch(() => {});
        return;
      }
      // `list|steer|stop|tail <ref>` act on this lane's jobs (D13); anything
      // else — including `steer the boat`, no ref — is a prompt, as before.
      const jobCmd = parseJobCommand(bgText);
      if (jobCmd) {
        await runJobCommand(jobCmd, this.jobCommandContext(bot, message, threadId, adapter));
        return;
      }
      const root = this.sessionKeys.get(laneKey) ?? laneKey;
      // Per-root concurrency cap parity with the durable engine (default 3).
      const cap = BACKGROUND_MAX_JOBS_PER_ROOT;
      if ((await jobStore.countActiveByRoot(root)) >= cap) {
        await adapter
          .send(message.chatId, {
            text: `⚠ Background queue full (max ${cap}). Wait for a task to finish.`,
            threadId,
          })
          .catch(() => {});
        return;
      }
      const personalityId =
        bot.binding.type === 'team' ? undefined : this.activePersonalityFor(laneKey, bot);
      const short = randomUUID().slice(0, 8);
      const job = await jobStore.create({
        owner: executor.owner,
        parentSessionKey: root,
        rootSessionKey: root,
        childSessionKey: `${root}:bgcmd:${short}`,
        ...(personalityId ? { personalityId } : {}),
        depth: 0,
        prompt: bgText,
        originPlatform: message.platform,
        originBotKey: bot.botKey,
        originChatId: message.chatId,
        ...(threadId ? { originThreadId: threadId } : {}),
        ...(message.userId ? { originUserId: message.userId } : {}),
        // G1-6: a job launched from a group — or a non-owner DM (D8) — runs
        // shared (`jobRoomAudience`, extensions/job-runner).
        roomAudience: this.jobAudienceFor(message),
      });
      executor.nudge();
      // The id is the whole point of the ack: without it the user has nothing to
      // correlate the launch to — not the completion notice (which prints the
      // same short id), not `task_logs`. The full id is what task_* tools take.
      await adapter
        .send(message.chatId, {
          text: `⏳ Background task started — job ${job.id}`,
          threadId,
        })
        .catch(() => {});
      return;
    }

    if (cmdType === 'mute') {
      const ownerUserId = this.channelFilter?.[message.platform]?.ownerUserId;
      const persist = () => this.persistLaneSessions(laneKey);
      const deps = {
        laneMutes: this.laneMutes,
        ownerUserId,
        isOwner: this.isOwner(message),
        persist,
      };
      await handleMuteCommand(deps, text, laneKey, message, adapter, threadId);
      return;
    }

    if (cmdType === 'voice') {
      const arg = text.split(/\s+/).slice(1).join(' ').trim().toLowerCase();
      const validModes: VoiceMode[] = ['off', 'mirror_inbound', 'all'];
      if (arg && validModes.includes(arg as VoiceMode)) {
        await this.voiceModeStore.set(laneKey, arg as VoiceMode);
        await adapter
          .send(message.chatId, { text: `✓ Voice mode: ${arg}`, threadId })
          .catch(() => {});
      } else if (!arg) {
        const current = await this.voiceModeStore.get(laneKey);
        await adapter
          .send(message.chatId, {
            text: `Voice mode: ${current}\nUsage: /voice off|mirror_inbound|all`,
            threadId,
          })
          .catch(() => {});
      } else {
        await adapter
          .send(message.chatId, {
            text: `Unknown voice mode "${arg}". Options: off, mirror_inbound, all`,
            threadId,
          })
          .catch(() => {});
      }
      return;
    }

    if (cmdType === 'compact') {
      const focus = text.split(/\s+/).slice(1).join(' ').trim();
      if (focus.toLowerCase() === 'status') {
        await adapter
          .send(message.chatId, {
            text: 'Context anatomy is available in the CLI: `ethos sessions show <id>`.',
            threadId,
          })
          .catch(() => {});
        return;
      }
      const sessionKey = this.sessionKeys.get(laneKey) ?? laneKey;
      const personalityId = this.activePersonalityFor(laneKey, bot);
      const result = await bot.loop
        .compact(sessionKey, {
          personalityId,
          ...(focus ? { instructions: focus } : {}),
        })
        .catch(() => null);
      let reply: string;
      if (!result?.ok) {
        reply = '✗ Not enough history to compact yet.';
      } else {
        const saved = Math.max(0, result.preTotalTokens - result.postTotalTokens);
        reply =
          `✓ Compacted ${result.droppedCount} earlier message(s) (${result.engineName}): ` +
          `${result.preTotalTokens.toLocaleString()} → ${result.postTotalTokens.toLocaleString()} tok (−${saved.toLocaleString()}).`;
        if (!result.summariesEnabled) {
          reply +=
            '\nSummaries disabled — set auxiliary.compression.model to enable summarized compaction.';
        }
      }
      await adapter.send(message.chatId, { text: reply, threadId }).catch(() => {});
      return;
    }

    // --- /queue command ---
    if (cmdType === 'queue') {
      const queueText = text.slice('/queue '.length).trim();
      if (!queueText) {
        await adapter
          .send(message.chatId, { text: '✗ Usage: /queue <message>', threadId })
          .catch(() => {});
        return;
      }
      if (this.activeSinks.has(laneKey)) {
        void this.enqueueTurn(laneKey, lane, bot, message, adapter, queueText, threadId, spoolId);
        handOff();
        // One wording for one concept: the same H3 ack the plain busy-lane
        // enqueue sends (`queuedTurnAck` — the running turn counts, so the
        // first queued message is "2nd").
        await adapter
          .send(message.chatId, { text: queuedTurnAck(lane.length), threadId })
          .catch(() => {});
        return;
      }
    }

    // --- /learn command ---
    if (!cmdType && /^\/learn(?:\s|$)/i.test(text)) {
      // D17 — learning writes private memory, which a shared room never
      // touches: say where it works and run no turn. Pinned by
      // `__tests__/learn-command.test.ts`.
      if (this.audienceFor(message) === 'shared') {
        await adapter
          .send(message.chatId, { text: LEARN_SHARED_ROOM_REPLY, threadId })
          .catch(() => {});
        return;
      }
      const { parseLearnArgs, buildLearnPrompt } = await import('@ethosagent/core');
      const learnText = text.slice('/learn'.length).trim();
      const parsed = parseLearnArgs(learnText);
      const personalityId = this.activePersonalityFor(laneKey, bot);
      const learnSessionKey = this.sessionKeys.get(laneKey) ?? laneKey;
      const prompt = buildLearnPrompt({
        hint: parsed.hint,
        description: parsed.description,
        personalityId,
        sessionKey: learnSessionKey,
        surface: 'gateway',
      });
      const learnTurn = this.enqueueTurn(
        laneKey,
        lane,
        bot,
        message,
        adapter,
        prompt,
        threadId,
        spoolId,
      );
      handOff();
      await learnTurn;
      return;
    }

    // --- Plugin slash commands ---
    if (!cmdType && text.startsWith('/')) {
      const cmdName = text.split(/\s+/)[0]?.slice(1).toLowerCase();
      const pluginHandler = cmdName ? this.pluginLoader?.getSlashHandler(cmdName) : undefined;
      if (pluginHandler) {
        const cmdArgs = text.split(/\s+/).slice(1).join(' ');
        const sessionId = this.sessionKeys.get(laneKey) ?? laneKey;
        const personalityId = this.activePersonalityFor(laneKey, bot);
        const ctx: import('@ethosagent/types').SlashCommandContext = {
          sessionId,
          personalityId,
          platform: message.platform,
          sender: {
            userId: message.userId ?? '',
            isOwner: this.isOwner(message),
            isDm: message.isDm,
          },
          send: async (t: string) => {
            await adapter.send(message.chatId, { text: t, threadId }).catch(() => {});
          },
        };
        try {
          const result = await pluginHandler(cmdArgs, ctx);
          if (result)
            await adapter.send(message.chatId, { text: result, threadId }).catch(() => {});
        } catch (err) {
          await adapter
            .send(message.chatId, { text: `Plugin command error: ${String(err)}`, threadId })
            .catch(() => {});
        }
        return;
      }
    }

    // --- Deterministic pre-LLM shortcut: gateway_message claiming hook ---
    // Fired after the bot/lane is resolved and every built-in / plugin slash
    // command has had its shot, but BEFORE any session/turn cost (steer,
    // backpressure, enqueue) — a claimed message never starts an agent turn
    // and never steers into a running one. No handler registered →
    // fireClaiming returns { handled: false } and behavior is unchanged.
    // The stub-loop guard (`typeof … === 'function'`) keeps loops without a
    // full HookRegistry (tests) on the unchanged path.
    if (typeof bot.loop.hooks?.fireClaiming === 'function') {
      const claim = await bot.loop.hooks
        .fireClaiming('gateway_message', {
          platform: message.platform,
          chatId: message.chatId,
          botKey: bot.botKey,
          ...(message.userId !== undefined ? { userId: message.userId } : {}),
          text,
          isDm: message.isDm,
        })
        .catch((): { handled: boolean; reply?: string } => ({ handled: false }));
      if (claim.handled) {
        this.observability?.recordSafetyBlock({
          code: 'gateway.message_claimed',
          details: {
            platform: message.platform,
            chatId: message.chatId,
            botKey: bot.botKey,
            hasReply: typeof claim.reply === 'string' && claim.reply.length > 0,
          },
        });
        const reply = claim.reply;
        if (typeof reply === 'string' && reply.length > 0) {
          // Same outbound path as normal turn replies: session-keyed dedup
          // gate, then the ledger-wrapped adapter send — on the prefixed text
          // (plan personality-presence-and-initiative §3), which is what the
          // chat receives. The voice decision below speaks the bare reply.
          const claimSessionKey = this.sessionKeys.get(laneKey) ?? laneKey;
          const claimPersonalityId = this.turnPersonalityFor(laneKey, bot);
          const prefixedReply = bot.replyPrefix
            ? applyReplyPrefix(reply, bot.replyPrefix, this.presenceOf(claimPersonalityId, bot))
            : reply;
          if (
            this.outboundDedup.shouldSend(
              claimSessionKey,
              prefixedReply,
              replyDedupScope(spoolId, message, this.localInboundId(message)),
            )
          ) {
            const claimDelivered = await this.sendTracked(
              {
                adapter,
                botKey: bot.botKey,
                platform: message.platform,
                chatId: message.chatId,
                sessionKey: claimSessionKey,
              },
              { text: prefixedReply, threadId },
            );
            // A claimed reply is still a reply, so it goes through the SAME
            // voice decision the agent path does — otherwise a lane in `all`
            // mode falls silent the moment a hook answers for the agent, which
            // is exactly the "voice-in gets text-out" drift this lane closes.
            // The claim runs BEFORE transcription, so the audio signal is the
            // raw attachment list and there is no transcript to detect a
            // language from.
            if (
              claimDelivered &&
              shouldReplyWithVoice({
                mode: await this.voiceModeStore.get(laneKey),
                inboundHadAudio: hasAudioAttachments(message.attachments),
              })
            ) {
              await this.deliverVoiceReply({
                adapter,
                botKey: bot.botKey,
                platform: message.platform,
                chatId: message.chatId,
                threadId,
                sessionKey: claimSessionKey,
                text: reply,
                personalityId: claimPersonalityId,
                language: undefined,
              });
            }
          }
        }
        return;
      }
    }

    // --- Auto-steer: if a turn is already running, push into its steer sink ---
    const runningSink = this.activeSinks.get(laneKey);
    // UBP-012 — the steer carries the message's attachments: image/PDF bytes as
    // blocks, a voice note transcribed into its text (`steerEntryFor`). Built
    // before the push, so the turn may have ended meanwhile; the message then
    // takes the ordinary enqueue path below.
    //
    // V-GC-4 — building is async and a text-only steer is not, so the message
    // takes its place in the lane's steer order (`steerOrder`) at arrival and
    // waits for the one before it after building. The slot is released as soon
    // as the wait is over: what follows — the push, or the overflow / plain
    // `enqueueTurn` below — is synchronous up to its first await, and a waiter
    // resumes only on a later microtask, so push order is arrival order.
    const priorSteer = this.steerOrder.get(laneKey);
    let releaseSteerSlot = (): void => {};
    if (runningSink || priorSteer) {
      const slot = new Promise<void>((resolve) => {
        releaseSteerSlot = resolve;
      });
      const settled = priorSteer ? priorSteer.then(() => slot) : slot;
      this.steerOrder.set(laneKey, settled);
      void settled.then(() => {
        if (this.steerOrder.get(laneKey) === settled) this.steerOrder.delete(laneKey);
      });
    }
    let steer: SteerEntry | undefined;
    try {
      steer = runningSink ? await this.steerEntryFor(message, text, laneKey, bot) : undefined;
      if (priorSteer) await priorSteer;
    } finally {
      releaseSteerSlot();
    }
    const activeSink =
      runningSink && this.activeSinks.get(laneKey) === runningSink ? runningSink : undefined;
    if (activeSink && steer) {
      const accepted = activeSink.pushEntry(steer, {
        message,
        adapter,
        text,
        threadId,
        spoolId,
      });
      if (accepted) {
        // Folded into the running turn: its row shares THAT turn's fate.
        const absorbing = spoolId ? this.spoolTurns.get(laneKey) : undefined;
        if (spoolId && absorbing) {
          if (!this.linkAbsorbed(spoolId, absorbing)) absorbing.absorbed.push(spoolId);
          handOff();
        }
        if (!ctx.replay && !this.rooms.isSilent(message, threadId)) {
          await adapter
            .send(message.chatId, { text: ABSORBED_STEER_ACK, threadId })
            .catch(() => {});
        }
        return;
      }
      // H3 — the steer sink is full. This message used to be dropped with no
      // ack at all; queue it as its own turn instead and say where it went.
      // The row (when spooled) follows the queued turn like any plain enqueue —
      // NOT `markAbsorbed`: nothing absorbed it. The ack is untracked (an
      // ack, not a reply); the queued turn's reply rides the tracked path.
      const overflowTurn = this.enqueueTurn(
        laneKey,
        lane,
        bot,
        message,
        adapter,
        text,
        threadId,
        spoolId,
      );
      handOff();
      if (!ctx.replay && !this.rooms.isSilent(message, threadId)) {
        await adapter
          .send(message.chatId, { text: queuedTurnAck(lane.length), threadId })
          .catch(() => {});
      }
      await overflowTurn;
      return;
    }

    // --- Agent turn ---

    const turnText = cmdType === 'queue' ? text.slice('/queue '.length).trim() : text;

    // Backpressure: when the global turn budget is saturated AND this lane has
    // already queued its cap, reject with a typed busy reply rather than
    // growing an unbounded backlog or dropping silently. An unset
    // (Infinity-permit) budget never saturates, so this never trips.
    if (this.concurrency.saturated && lane.length >= this.maxLaneQueue) {
      this.observability?.recordSafetyBlock({
        code: 'gateway.session_busy',
        details: {
          platform: message.platform,
          chatId: message.chatId,
          botKey: bot.botKey,
          laneDepth: lane.length,
          maxLaneQueue: this.maxLaneQueue,
        },
      });
      await adapter.send(message.chatId, { text: SYSTEM_BUSY_MESSAGE, threadId }).catch(() => {});
      return;
    }

    // H3 — a lane that is already busy says so: whenever something is running
    // or queued ahead of this message, ack where it landed. Ordinal from the
    // lane depth AFTER enqueue (the running turn counts, so the first queued
    // message is "2nd"). Idle lane → no ack, the reply itself is the feedback.
    const laneBusy = lane.length > 0;
    const turn = this.enqueueTurn(
      laneKey,
      lane,
      bot,
      message,
      adapter,
      turnText,
      threadId,
      spoolId,
    );
    handOff();
    if (laneBusy && !ctx.replay && !this.rooms.isSilent(message, threadId)) {
      await adapter
        .send(message.chatId, { text: queuedTurnAck(lane.length), threadId })
        .catch(() => {});
    }
    await turn;
  }

  /**
   * Enqueue a turn on `lane`, gated by the global concurrency semaphore. The
   * permit is acquired INSIDE the lane task (so lane ordering is preserved)
   * but BEFORE `runTurn` marks the lane active — so while a turn waits for a
   * global slot, further inbound messages for the lane enqueue (and hit the
   * per-lane cap) instead of steering into a turn that hasn't started.
   *
   * Leak-free: the permit is released in `finally`; an abort before a slot
   * frees resolves `acquire` to `false` (no permit held, nothing to release,
   * `runTurn` never runs so there is no lane state to unwind).
   *
   * With a `spoolId` the row follows the turn (plan reach-and-containment
   * §2.3): `processing` once the slot is held, `done` only after `runTurn`
   * returns — the iterator drained AND the answer joined — never on the `done`
   * event. See {@link finishSpoolTurn} for the failure and shutdown outcomes.
   */
  private enqueueTurn(
    laneKey: string,
    lane: SessionLane,
    bot: GatewayBotConfig,
    message: InboundMessage,
    adapter: PlatformAdapter,
    text: string,
    threadId: string | undefined,
    spoolId?: string,
    review?: WakeReview,
  ): Promise<void> {
    let started = false;
    const queued = lane.enqueue(async (signal) => {
      started = true;
      // D5 — the bot's daily cap, checked when the turn reaches the front of
      // its lane (so the turns queued ahead of it have already counted) and
      // before it takes a global slot. A refused turn never runs the loop: its
      // row closes like any consumed message, and a review turn hands the user
      // the plain wake notice instead (`settleUnstartedSpool`), so a completion
      // is never swallowed. Pinned by `__tests__/budget-halt.test.ts`.
      const overCap = await this.dailyCapReached(bot, message.platform);
      if (overCap) {
        this.observability?.recordSafetyBlock({
          code: 'gateway.daily_budget_refused',
          details: {
            platform: message.platform,
            botKey: bot.botKey,
            chatId: message.chatId,
            spentUsd: overCap.spentUsd,
            capUsd: overCap.capUsd,
          },
        });
        if (review) {
          if (spoolId) await this.settleUnstartedSpool(spoolId, review, bot, message, threadId);
          return;
        }
        if (spoolId) this.closeSpool(spoolId);
        await adapter
          .send(message.chatId, { text: dailyCapNotice(overCap), threadId })
          .catch(() => {});
        return;
      }
      const slotHeld = await this.concurrency.acquire(signal);
      if (!slotHeld) {
        if (spoolId) await this.settleUnstartedSpool(spoolId, review, bot, message, threadId);
        return;
      }
      const spoolTurn = this.inboundSpool ? this.beginSpoolTurn(spoolId, review) : undefined;
      if (spoolTurn) this.spoolTurns.set(laneKey, spoolTurn);
      const target: SpoolTurnTarget = {
        botKey: bot.botKey,
        platform: message.platform,
        chatId: message.chatId,
        threadId,
        laneKey,
      };
      // Computed when the turn runs, from the message itself — a spool replay
      // (the hint is serialised with it) and a steer/queue/overflow turn get
      // the same answer as the original. A review takes its job's audience.
      const audience: TurnAudienceOptions = review
        ? { roomAudience: review.roomAudience, initiator: 'system', skipPersonalityMemory: false }
        : {
            roomAudience: this.audienceFor(message),
            initiator: initiatorFor(message),
            skipPersonalityMemory: this.withholdsPersonalityMemory(message),
          };
      const turn = this.runTurn(
        laneKey,
        lane,
        bot,
        message,
        adapter,
        text,
        threadId,
        signal,
        audience,
        spoolTurn,
      );
      // What `shutdown()` waits on is the turn AND its row's settlement: the
      // settle can send a notice (a retry notice, a review's plain wake notice)
      // that must land — or at least reach the ledger — before the adapters
      // stop and the row is closed.
      const settled = turn.then(
        async () => {
          if (spoolTurn) await this.finishSpoolTurn(spoolTurn, signal, undefined, target);
        },
        async (err: unknown) => {
          if (spoolTurn) await this.finishSpoolTurn(spoolTurn, signal, err, target);
          throw err;
        },
      );
      this.inflightTurns.add(settled);
      try {
        await settled;
      } finally {
        if (spoolTurn && this.spoolTurns.get(laneKey) === spoolTurn)
          this.spoolTurns.delete(laneKey);
        this.inflightTurns.delete(settled);
        this.concurrency.release();
      }
    });
    // Dropped from the lane before it ever ran (`SessionLane.abort` rejects
    // everything queued behind the running task).
    if (spoolId) {
      queued.catch(() => {
        if (!started) void this.settleUnstartedSpool(spoolId, review, bot, message, threadId);
      });
    }
    return queued;
  }

  private closeSpool(spoolId: string): void {
    this.spoolLifecycle.closeSpool(spoolId);
  }

  private recordSpoolUpdateFailed(stage: string, err: unknown): void {
    this.spoolLifecycle.recordSpoolUpdateFailed(stage, err);
  }

  private settleUnstartedSpool(
    spoolId: string,
    review: WakeReview | undefined,
    bot: GatewayBotConfig,
    message: InboundMessage,
    threadId: string | undefined,
  ): Promise<void> {
    return this.spoolLifecycle.settleUnstartedSpool(spoolId, review, bot, message, threadId);
  }

  private beginSpoolTurn(spoolId: string | undefined, review?: WakeReview): SpoolTurnState {
    return this.spoolLifecycle.beginSpoolTurn(spoolId, review);
  }

  /** @see SpoolTurns.linkAbsorbed in ./spool-turns.ts */
  private linkAbsorbed(spoolId: string, state: SpoolTurnState): boolean {
    return this.spoolLifecycle.linkAbsorbed(spoolId, state);
  }

  /** @see SpoolTurns.foldAbsorbed in ./spool-turns.ts */
  private foldAbsorbed(
    spool: InboundSpool,
    row: SpoolRow,
    message: InboundMessage,
  ): Promise<InboundMessage> {
    return this.spoolLifecycle.foldAbsorbed(spool, row, message);
  }

  /** @see SpoolTurns.markSpoolToolStarted in ./spool-turns.ts */
  private markSpoolToolStarted(state: SpoolTurnState): void {
    this.spoolLifecycle.markSpoolToolStarted(state);
  }

  private finishSpoolTurn(
    state: SpoolTurnState,
    signal: AbortSignal,
    err: unknown,
    target: SpoolTurnTarget,
  ): Promise<void> {
    return this.spoolLifecycle.finishSpoolTurn(state, signal, err, target);
  }

  private notifyInterrupted(spoolId: string, target: SpoolTurnTarget): Promise<void> {
    return this.spoolLifecycle.notifyInterrupted(spoolId, target);
  }

  /** @see SpoolTurns.notifyDeadLettered in ./spool-turns.ts */
  private notifyDeadLettered(
    spoolId: string,
    reason: string,
    target: SpoolTurnTarget,
  ): Promise<void> {
    return this.spoolLifecycle.notifyDeadLettered(spoolId, reason, target);
  }

  private deliverReviewFallback(
    spoolId: string,
    target: SpoolTurnTarget,
    text: string,
    reason: string,
  ): Promise<void> {
    return this.spoolLifecycle.deliverReviewFallback(spoolId, target, text, reason);
  }

  private sendReviewFallback(
    target: SpoolTurnTarget,
    text: string,
    inboundRef: string | undefined,
  ): Promise<boolean> {
    return this.spoolLifecycle.sendReviewFallback(target, text, inboundRef);
  }

  private pendingInterrupted(message: InboundMessage): SpoolRow | null {
    return this.spoolLifecycle.pendingInterrupted(message);
  }

  private settleInterrupted(
    row: SpoolRow,
    retry: boolean,
  ): Promise<{ message: InboundMessage; spoolId: string } | 'consumed' | null> {
    return this.spoolLifecycle.settleInterrupted(row, retry);
  }

  private recordSpoolDeadLettered(spoolId: string, reason: string): void {
    this.spoolLifecycle.recordSpoolDeadLettered(spoolId, reason);
  }

  /** @see SpoolReplay.replayInboundSpool in ./spool-replay.ts */
  replayInboundSpool(): Promise<{ replayed: number; deferred: number; dead: number }> {
    return this.spoolReplay.replayInboundSpool();
  }

  /** @see SpoolReplay.replaySpoolRow in ./spool-replay.ts */
  private replaySpoolRow(
    spool: InboundSpool,
    row: SpoolRow,
    staleByLane: Map<string, { row: SpoolRow; count: number; samples: string[] }>,
    counts: { replayed: number; deferred: number; dead: number },
  ): Promise<void> {
    return this.spoolReplay.replaySpoolRow(spool, row, staleByLane, counts);
  }

  private reviveSpooledMessage(row: SpoolRow): Promise<InboundMessage | null> {
    return this.spoolReplay.reviveSpooledMessage(row);
  }

  private transcribeVoiceNote(
    message: InboundMessage,
    text: string,
    personalityId: string | undefined,
    io: { attachmentCache: AttachmentCache; storage: Storage },
  ): Promise<{ text: string; providerId: string | undefined }> {
    return this.voice.transcribeVoiceNote(message, text, personalityId, io);
  }

  /** @see SpoolTurns.steerEntryFor in ./spool-turns.ts */
  private steerEntryFor(
    message: InboundMessage,
    text: string,
    laneKey: string,
    bot: GatewayBotConfig,
  ): Promise<SteerEntry> {
    return this.spoolLifecycle.steerEntryFor(message, text, laneKey, bot);
  }

  /** @see SpoolTurns.requeueUnreadSteers in ./spool-turns.ts */
  private requeueUnreadSteers(
    laneKey: string,
    lane: SessionLane,
    bot: GatewayBotConfig,
    sink: GatewaySteerSink<SteerOrigin>,
    spoolTurn: SpoolTurnState | undefined,
  ): void {
    this.spoolLifecycle.requeueUnreadSteers(laneKey, lane, bot, sink, spoolTurn);
  }

  /** @see SpoolTurns.settleUnreadSteers in ./spool-turns.ts */
  private settleUnreadSteers(
    sink: GatewaySteerSink<SteerOrigin>,
    spoolTurn: SpoolTurnState | undefined,
    answered: boolean,
  ): void {
    this.spoolLifecycle.settleUnreadSteers(sink, spoolTurn, answered);
  }

  /**
   * Whether this turn's reply should stream as live draft edits. Requires the
   * chat class (DM/group) to be enabled, the adapter to support editing, and
   * the chat not to have been flood-disabled earlier this run.
   */
  private shouldStream(message: InboundMessage, adapter: PlatformAdapter): boolean {
    const enabled = message.isDm ? this.streamingDm : this.streamingGroup;
    if (!enabled) return false;
    if (!adapter.canEditMessage || typeof adapter.editMessage !== 'function') return false;
    if (this.streamingDisabledChats.has(`${message.platform}:${message.chatId}`)) return false;
    return true;
  }

  private async runTurn(
    laneKey: string,
    _lane: SessionLane,
    bot: GatewayBotConfig,
    message: InboundMessage,
    adapter: PlatformAdapter,
    text: string,
    threadId: string | undefined,
    signal: AbortSignal,
    audience: TurnAudienceOptions,
    spoolTurn?: SpoolTurnState,
  ): Promise<void> {
    // A `wake_review` turn reaches here without `dispatchInbound`.
    const restoring = this.pendingLaneRestore(bot.botKey);
    if (restoring) await restoring;
    const review = spoolTurn?.review;
    const laneSessionKey = this.sessionKeys.get(laneKey) ?? laneKey;
    // A shared wake review whose lane is private (a DM — say a non-owner's,
    // whose `/background` job was stamped shared by D8) runs in its own
    // sub-session: its first turn would otherwise stamp the DM session shared
    // for good, withholding memory from every later turn in it — the same rule
    // `runCronTurn` applies to a web origin (verification round B4). Pinned by
    // the room-audience cases in `__tests__/parent-review.test.ts`.
    const sessionKey =
      review?.roomAudience === 'shared' &&
      !(await this.laneSessionIsShared(laneSessionKey, message))
        ? `${laneSessionKey}:review:${review.jobId}`
        : laneSessionKey;
    // Stamped on this turn's reply obligations: the replay's double-reply
    // guard (`DeliveryLedger.hasObligationFor`) reads it back.
    const inboundRef = spoolTurn?.id;
    // UBP-014 — the reply paths below dedup per inbound message (ARCHITECTURE.md
    // §V S3 as amended 2026-09-28): an identical answer to a DIFFERENT message
    // still sends. See `replyDedupScope`.
    const replyScope = replyDedupScope(inboundRef, message, this.localInboundId(message));
    this.lastInboundHadAudio.set(laneKey, hasAudioAttachments(message.attachments));
    // Refresh every loop registry from disk before resolving which personality
    // this turn runs as, so a hot-dropped or edited directory takes effect on
    // the next turn without a restart. Seam absent (tests, standalone) → no-op.
    // Fail-open: a refresh that throws (e.g. malformed YAML on disk) must not
    // abort the turn — the seam impl logs; we proceed with the last-good
    // registry (stale-but-alive beats a dead turn).
    await this.personalityDirectory?.refresh().catch(() => {});
    const personalityId = this.turnPersonalityFor(laneKey, bot);
    // The bot's reply prefix, rendered for the personality THIS turn runs as
    // (plan personality-presence-and-initiative §3). Applied to the answer, an
    // interrupted answer and the streamed draft BEFORE dedup and the ledger see
    // them; never to gateway notices (the error note, both empty-reply notices,
    // the credential link), and never to a voice note's spoken text.
    const replyPresence = bot.replyPrefix ? this.presenceOf(personalityId, bot) : undefined;
    const prefixReply = (reply: string): string =>
      applyReplyPrefix(reply, bot.replyPrefix, replyPresence);

    // Activity signal, fired at turn START so a listener can cancel background
    // work before the turn runs — not at completion, which would be too late.
    // A parent-review turn (plan openclaw-9.5-adoption item 6) is the agent
    // reacting to its own background work, not the user arriving: no signal.
    if (personalityId && !review) this.onUserTurn?.({ personalityId });

    this.activeTurns.set(laneKey, {
      adapter,
      chatId: message.chatId,
      // Carried so the shutdown notice returns to the thread the turn is in.
      ...(threadId ? { threadId } : {}),
    });

    // Flush buffered notifications from previous disconnected period
    if (this.notificationRouter) {
      const buffered = this.unreadNotifications.get(sessionKey);
      if (buffered && buffered.length > 0) {
        this.unreadNotifications.delete(sessionKey);
        for (const note of buffered) {
          await adapter.send(message.chatId, { text: note, threadId }).catch(() => {});
        }
      }
    }

    let turnActive = true;
    if (this.notificationRouter) {
      this.notificationRouter.register(sessionKey, {
        send: async (text: string) => {
          if (turnActive) {
            await adapter.send(message.chatId, { text, threadId }).catch(() => {});
          } else {
            const buf = this.unreadNotifications.get(sessionKey) ?? [];
            buf.push(text);
            this.unreadNotifications.set(sessionKey, buf);
          }
        },
        injectUserMessage: async (_msg: string) => {},
      });
    }

    const steerSink = createSteerSink<SteerOrigin>();
    this.activeSinks.set(laneKey, steerSink);
    // Set once the answer has been delivered and the iterator drained: the
    // `finally` then runs any steer no seam read as its own turn (UBP-001).
    let completed = false;

    this.sessionRouting.set(sessionKey, {
      adapter,
      chatId: message.chatId,
      threadId: message.threadId ? message.threadId : undefined,
      requesterUserId: message.userId,
      isDm: message.isDm,
      platform: message.platform,
    });

    // The thread too (UBP-017): typing, and Discord's "Thinking…" placeholder,
    // land in the thread or forum topic the turn is in, not its parent chat.
    const typingOpts = message.threadId ? { threadId: message.threadId } : undefined;
    await adapter.sendTyping?.(message.chatId, typingOpts).catch(() => {});
    const typingTimer = setInterval(() => {
      void adapter.sendTyping?.(message.chatId, typingOpts).catch(() => {});
    }, 4_000);

    // H1/H2 timers — declared out here so the `finally` can always clear them.
    let feedback: TurnFeedback | undefined;

    try {
      // --- Voice pipeline: auto-transcribe audio attachments ---
      const attachmentCache = this.attachmentCache;
      const storage = this.storage;
      // Set only when a transcript actually reached the turn. It becomes a
      // MESSAGE-LEVEL `<voice-origin>` annotation inside AgentLoop, riding
      // ALONGSIDE the `<attachments>` audio marker rather than replacing it —
      // the transcript is an annotation on the audio message, never a
      // substitute for it (OC #87269 / Hermes #51131). Nothing goes into the
      // system prompt, so a lane that mixes typed and spoken messages keeps a
      // byte-identical static prefix.
      let voiceOrigin: VoiceTurnOrigin | undefined;
      // BCP-47 tag of the inbound utterance, when the personality declares a
      // voice for it. Carried to the reply so a Spanish voice note comes back
      // in the Spanish voice.
      let voiceLanguage: string | undefined;
      if (hasAudioAttachments(message.attachments) && attachmentCache && storage) {
        const stt = await this.transcribeVoiceNote(message, text, personalityId, {
          attachmentCache,
          storage,
        });
        text = stt.text;
        // Detected against the personality's OWN language keys, never against
        // the world: `detectLanguage` only ever decides between candidates, so
        // a personality with no language map produces no guess and the default
        // voice stands — the behaviour that existed before this did.
        const candidates = Object.keys(this.personalityVoice(personalityId)?.languages ?? {});
        voiceLanguage = candidates.length > 0 ? detectLanguage(text, { candidates }) : undefined;
        // A channel voice note is the account owner's own message on their own
        // lane — channel ingress is already sender-gated. A far-end caller
        // arrives over telephony (V4), never here.
        //
        // The stamped id is THIS turn's resolution, not a remembered global:
        // per-personality resolution makes "which provider ran" a per-turn fact.
        voiceOrigin = {
          transport: `${message.platform}-voice-note`,
          speaker: 'owner',
          ...(stt.providerId ? { sttProvider: stt.providerId } : {}),
          ...(voiceLanguage ? { language: voiceLanguage } : {}),
        };
      }

      const wrapped = wrapUntrusted({ content: text, toolName: 'channel_message' });

      const contextPrefix = message.priorContext
        ? wrapUntrusted({ content: message.priorContext, toolName: 'channel_history' }).content +
          '\n\n---\n\n'
        : '';

      // A review turn's text is `buildWakeNotice(job)`: a trusted envelope with
      // the child's result ALREADY wrapped as untrusted (and injection-scanned
      // there), so it goes in as-is behind a trusted instruction — re-wrapping
      // it as a `channel_message` would mark our own envelope untrusted.
      let loopText = review
        ? `${REVIEW_TURN_PREAMBLE}\n\n${text}`
        : contextPrefix
          ? `${contextPrefix}${wrapped.content}`
          : wrapped.content;

      const tier1 = shortPatternCheck(text);
      if (!review && (tier1.containsInstructions || wrapped.strippedTokens > 0)) {
        this.observability?.recordInjectionFlag?.({
          code: 'channel.injection_detected',
          cause: tier1.containsInstructions
            ? (tier1.hits[0]?.rule ?? 'pattern-hit')
            : `stripped ${wrapped.strippedTokens} template token${wrapped.strippedTokens === 1 ? '' : 's'}`,
          details: {
            platform: message.platform,
            chatId: message.chatId,
            userId: message.userId ?? '',
            ...(tier1.containsInstructions ? { hits: tier1.hits } : {}),
          },
        });
      }

      const userId =
        message.userId && this.resolveUserIdFn
          ? await this.resolveUserIdFn(message.platform, message.userId, message.username)
          : undefined;

      // W3.1 — live draft-edit streamer, gated by chat class + adapter caps.
      // The ledger binding rides along so the streamer's TERMINAL edit gets the
      // same durable obligation the non-streaming paths get.
      const streamDelivery = this.deliveryBinding(bot.botKey, message.platform, inboundRef);
      // Per-room silence (plan channel-prompts L11, D20): set once the room resolves. While true
      // the lane posts nothing it could not retract (`silentHold`, no H1 notice): no adapter delete.
      let roomSilent = false;
      // Not for a review turn: whether its answer or the plain wake notice goes
      // out is decided only at the terminal event (see `deliverAnswer`).
      const streamer =
        !review && this.shouldStream(message, adapter)
          ? new DraftStreamer({
              adapter,
              chatId: message.chatId,
              threadId,
              sessionKey,
              dedup: this.outboundDedup,
              inboundId: replyScope.inboundId,
              ...(streamDelivery ? { delivery: streamDelivery } : {}),
              ...(bot.replyPrefix ? { prefixBody: prefixReply } : {}),
              minEditIntervalMs: this.streamingEditIntervalMs,
              silentHold: () => roomSilent,
              onFloodDisable: () => {
                this.streamingDisabledChats.add(`${message.platform}:${message.chatId}`);
                this.observability?.recordSafetyBlock({
                  code: 'gateway.streaming_disabled',
                  cause: `streaming disabled for chat ${message.chatId} after repeated flood-waits`,
                  details: { platform: message.platform, chatId: message.chatId },
                });
              },
            })
          : undefined;

      // H1/H2 — silent-lane liveness (see ./turn-feedback.ts for the shared
      // once-per-turn latch). Not for review turns (they are the agent's own
      // follow-up, not a user waiting) and never on email lanes (UD9 — a
      // second email is worse than silence). On a streaming lane H2 edits the
      // draft's progress line; on a non-streaming lane the one untracked ack
      // goes out like a slash ack — no dedup, no ledger.
      //
      // UD4 — an adapter that posts its own "Thinking…" placeholder from the
      // `sendTyping` this turn already sent (Discord with
      // `postsThinkingPlaceholder`) has visible liveness on the lane; arming
      // H1's `_working on it…_` on top of it double-notices. Omitting
      // `sendNotice` skips the notice while keeping the H2 per-tool timers
      // and the shared latch bookkeeping intact. A plain structural property
      // read, deliberately NOT a PlatformAdapter contract field. Pinned by
      // `__tests__/slow-turn-notice.test.ts` ('placeholder').
      const placeholderCoversLane =
        typeof adapter.sendTyping === 'function' &&
        (adapter as PlatformAdapter & { postsThinkingPlaceholder?: boolean })
          .postsThinkingPlaceholder === true;
      feedback =
        review || message.platform === 'email'
          ? undefined
          : new TurnFeedback({
              slowTurnNoticeMs: this.slowTurnNoticeMs,
              ...(streamer
                ? {
                    pushProgress: (line: string) => {
                      if (!signal.aborted) void streamer.pushProgress(line);
                    },
                  }
                : placeholderCoversLane
                  ? {}
                  : {
                      sendNotice: (notice: string) => {
                        if (!signal.aborted && !roomSilent)
                          void adapter
                            .send(message.chatId, { text: notice, threadId })
                            .catch(() => {});
                      },
                    }),
            });
      feedback?.start();

      // Static per-channel toolset narrowing (context-economy Phase 1).
      // Resolved from static config only — never computed per turn — so the
      // tool list stays byte-stable across turns on this lane (plan R1).
      const toolsetNarrow = this.channelToolsets?.[message.platform];

      // Per-room prompt and policy (plan channel-prompts D1, D14): see `RoomGateway.resolveTurn`.
      const resolveIn = { message, adapter, threadId, review, sessionKey, laneSessionKey };
      const { room, metaText } = await this.rooms.resolveTurn(resolveIn);
      if (metaText) loopText = `${metaText}\n\n---\n\n${loopText}`;
      roomSilent = room?.silent === true;

      const translator = createEventTranslator();

      // The chat has its answer: the TEXT final (or the error note standing in
      // for it) landed. Read by `shutdown()` — the one decision it informs is
      // whether this chat still needs an "interrupted, please resend" notice —
      // so it is set before the voice pipeline, which can take seconds, not
      // after it. Pinned by `__tests__/turn-tail.test.ts` ('answered means').
      const markAnswered = (): void => {
        const active = this.activeTurns.get(laneKey);
        if (active) active.answered = true;
        if (spoolTurn) spoolTurn.answered = true;
      };

      // Set when core reports the output cap cut the reply off; cleared by
      // any later text (a folded steer's next iteration wrote the ending).
      let cutOffAtCap = false;

      // Deliver the reply exactly once. Called at the turn's terminal event,
      // or after the loop when the iterator ends without one.
      const deliverAnswer = async (): Promise<void> => {
        // A `returnDirect` tool result reaches the turn only as `done.text`,
        // after whatever preamble the model streamed before the call. The
        // whole reply is the streamed text plus `answerSuffix` (the one rule,
        // in @ethosagent/types) — delivered as ONE final: the streamed draft is
        // finalized in place with it, or it is the one send. Pinned by
        // `__tests__/turn-tail.test.ts` ('returnDirect').
        const fullAnswer = translator.text + answerSuffix(translator.text, translator.done?.text);
        // V-CP-2 / UBP-033 — a reply the output cap cut off ends with core's
        // `MAX_TOKENS_REPLY_NOTICE` (packages/core/src/agent-loop/output-cap.ts), on
        // the streamed final and the plain send alike (`cutOffAtCap` below).
        // S4/U1 — a budget halt reaches the lane folded into the reply, so the
        // answer and the reason it stopped are ONE message (`haltNotice` in
        // @ethosagent/core owns the wording and the reset command). Not for a
        // review turn: its empty answer must still fall back to the wake
        // notice below. Pinned by `__tests__/budget-halt.test.ts`.
        const halted = !review && translator.halt ? haltNotice(translator.halt) : null;
        const answerText = answerWithCapNotice(
          roomSilent,
          fullAnswer,
          cutOffAtCap,
          halted !== null,
        );
        const responseText = halted
          ? answerText.trim().length > 0
            ? `${answerText}\n\n${halted}`
            : halted
          : answerText;
        const errored = translator.error;

        // Did the live streamer already deliver (at least a first chunk)? If so,
        // the final content lands as a draft edit (registered in dedup via
        // record()) instead of a fresh send — no duplicate message.
        const streamed = streamer?.hasDelivered ?? false;

        if (signal.aborted) {
          // /stop or shutdown — caller already notified the user. Any partial
          // draft is left as-is.
        } else if (review && (errored || responseText.trim().length === 0)) {
          // The review could not answer: the user gets the plain wake notice
          // instead, so the background result is never swallowed (D29).
          const target: SpoolTurnTarget = {
            botKey: bot.botKey,
            platform: message.platform,
            chatId: message.chatId,
            threadId,
            laneKey,
          };
          this.observability?.recordSafetyBlock({
            code: 'gateway.review_fallback',
            cause: errored ? `review turn errored: ${errored.error}` : 'review turn gave no answer',
            details: { jobId: review.jobId, platform: message.platform, botKey: bot.botKey },
          });
          if (await this.sendReviewFallback(target, review.fallbackText, inboundRef)) {
            markAnswered();
          }
        } else if (translator.credentialRequired) {
          // Refused pre-turn: no model ran, so there is no answer text. The
          // reply is a link (or the CLI command), sent on the same tracked
          // reply path as an error note. The refused turn still ends at `done`
          // and its spool row closes like any other; the user's resend is a
          // fresh turn (plan openclaw-9.5-adoption item 1 §5).
          const reply = credentialRequiredReply(translator.credentialRequired, this.webBaseUrl);
          if (this.outboundDedup.shouldSend(sessionKey, reply, replyScope)) {
            const sent = await this.sendTracked(
              {
                adapter,
                botKey: bot.botKey,
                platform: message.platform,
                chatId: message.chatId,
                sessionKey,
                inboundRef,
              },
              { text: reply, threadId },
            );
            if (sent) markAnswered();
          } else {
            markAnswered();
          }
        } else if (errored) {
          // A3 — the fold uses the shared chat-error map's title, never the
          // raw provider string (`describeChatError`, @ethosagent/surface-kit).
          // UBP-020 — a turn that wrote no reply at all says so, with its cause.
          const empty = errored.code === EMPTY_COMPLETION_CODE && responseText.trim().length === 0;
          if (empty) this.recordEmptyReply(message, bot, errored.error);
          // Only an interrupted ANSWER is the personality speaking, so only it
          // carries the reply prefix; the empty-completion notice and the bare
          // error note are gateway notices, like EMPTY_REPLY_NOTICE below.
          const interrupted = !empty && responseText.trim().length > 0;
          const note = empty
            ? emptyCompletionNotice(errored.error)
            : interrupted
              ? `${responseText}\n\n⚠ Response interrupted: ${describeChatError(errored.code, errored.error).title}`
              : `⚠ Error: ${errored.error}`;
          const sanitizedNote = interrupted
            ? prefixReply(stripAnsiEscapes(note))
            : stripAnsiEscapes(note);
          if (streamer && streamed) {
            // Fold the interruption into the existing draft rather than sending
            // a second message that duplicates the streamed text.
            await streamer.finalize(sanitizedNote);
            markAnswered();
          } else if (this.outboundDedup.shouldSend(sessionKey, sanitizedNote, replyScope)) {
            const noted = await this.sendTracked(
              {
                adapter,
                botKey: bot.botKey,
                platform: message.platform,
                chatId: message.chatId,
                sessionKey,
                inboundRef,
              },
              { text: sanitizedNote, threadId },
            );
            if (noted) markAnswered();
          } else {
            // Suppressed by the dedup cache: this exact note already answered
            // THIS inbound message inside the TTL (the key is scoped to it,
            // UBP-014), so the chat has it. See the same branch on the answer
            // path.
            markAnswered();
          }
        } else if (!streamed && shouldSuppressSilentReply(roomSilent, responseText)) {
          // Per-room silence (plan channel-prompts L11, D20): the room opted in and the whole
          // reply is a marker, so nothing is sent and nothing is owed (no ledger row, dedup not
          // armed); `markAnswered` completes the turn for `shutdown()` and `finishSpoolTurn`. A
          // halt/cap notice is part of `responseText`, so those still go out. Pinned by
          // `__tests__/room-silence.test.ts`.
          await this.rooms.endSilentTurn(adapter, message, bot, threadId, review?.jobId);
          markAnswered();
        } else if (responseText) {
          const sanitized = stripAnsiEscapes(responseText);
          // What the chat receives. The voice note below speaks `sanitized`:
          // a prefix read aloud is noise, and the voice is already the
          // personality's own (`voice.tts_voice`).
          const reply = prefixReply(sanitized);
          // Streaming path lands the final via editMessage; non-streaming path
          // gates a fresh send on dedup. `delivered` decides whether the voice
          // pipeline runs (it runs on either delivery route).
          let delivered = false;
          if (streamer && streamed) {
            await streamer.finalize(reply);
            delivered = true;
          } else if (this.outboundDedup.shouldSend(sessionKey, reply, replyScope)) {
            // `delivered` is now the adapter's own verdict, not "we called
            // send()". An unconfirmed reply leaves a pending obligation AND
            // skips the voice pipeline — synthesising audio for a message the
            // user never received is pure waste.
            delivered = await this.sendTracked(
              {
                adapter,
                botKey: bot.botKey,
                platform: message.platform,
                chatId: message.chatId,
                sessionKey,
                inboundRef,
              },
              { text: reply, parseMode: 'markdown', threadId },
            );
          } else {
            // Suppressed by the dedup cache: this exact text already answered
            // THIS inbound message inside the TTL (the key is scoped to it,
            // UBP-014), so the chat HAS the answer and needs no
            // "please resend" notice. NOT `delivered`: this turn sent nothing,
            // so it records no obligation and synthesizes no voice note.
            markAnswered();
          }

          if (delivered) {
            markAnswered();
            // --- Voice pipeline: post-turn TTS synthesis ---
            // `shouldReplyWithVoice` is the ONE decision function (voice V1a
            // eng-review D3, drift-gated). Everything downstream of it is
            // delivery mechanics, which is why they live in their own method.
            const shouldSynth = shouldReplyWithVoice({
              mode: await this.voiceModeStore.get(laneKey),
              inboundHadAudio: this.lastInboundHadAudio.get(laneKey) ?? false,
            });
            if (shouldSynth) {
              await this.deliverVoiceReply({
                adapter,
                botKey: bot.botKey,
                platform: message.platform,
                chatId: message.chatId,
                threadId,
                sessionKey,
                text: sanitized,
                personalityId,
                language: voiceLanguage,
              });
            }
          }
        } else if (translator.done) {
          // UBP-020 — the turn ended (`done`) with no reply text and no error:
          // the user gets one tracked notice instead of silence.
          this.recordEmptyReply(message, bot, 'blank done');
          if (
            this.outboundDedup.shouldSend(sessionKey, EMPTY_REPLY_NOTICE, replyScope) &&
            (await this.sendTracked(
              {
                adapter,
                botKey: bot.botKey,
                platform: message.platform,
                chatId: message.chatId,
                sessionKey,
                inboundRef,
              },
              { text: EMPTY_REPLY_NOTICE, threadId },
            ))
          ) {
            markAnswered();
          }
        }

        if (!signal.aborted && !errored && responseText) {
          try {
            this.onTurnComplete?.({ platform: message.platform });
          } catch {
            // App-layer callback errors must never break the turn.
          }
        }
      };

      // F07 — the ANSWER and the TURN end at different moments. The answer is
      // final at the terminal event (`done`, or an `error`), so delivery starts
      // there and does not wait for anything else. The turn is not over:
      // AgentLoop still has work after that yield — `maybeConsolidateAtTurnEnd`
      // (the context engine's `onTurnComplete`, the memory flush,
      // auto-compaction) after `done`, usage flush and trace close after an
      // `error`. A `break` here would call the generator's `return()` and skip
      // all of it, so the iterator is pulled until it is exhausted. `runTurn`
      // returns — which is what releases the lane — only once BOTH the delivery
      // has settled AND the iterator is done: the join after the loop below.
      // Pinned by `__tests__/turn-tail.test.ts`.
      let answer: Promise<void> | undefined;
      try {
        for await (const event of bot.loop.run(loopText, {
          sessionKey,
          personalityId,
          abortSignal: signal,
          attachments: message.attachments,
          userId,
          steerSink,
          origin: `${message.platform}:${message.chatId}`,
          // plan personality-memory-boundary G1: a shared room never reads or
          // writes private memory (enforced in core by `resolveTurnAudience`).
          roomAudience: audience.roomAudience,
          initiator: audience.initiator,
          // The gateway alone judged this room (chat type, private_chats), so
          // it alone may record a judged-private stamp (verification round
          // E5, `RunOptions.judgeAudience`). A review runs its job's audience,
          // not a judgement of the lane.
          ...(review ? {} : { judgeAudience: true }),
          ...(audience.skipPersonalityMemory ? { skipPersonalityMemory: true } : {}),
          // `/incognito` lane (D5): turn-setup stamps the session; a shared
          // audience above still wins, so this never re-admits the shell tools.
          ...(this.incognitoLanes.has(laneKey) ? { incognito: true } : {}),
          ...(voiceOrigin ? { voiceOrigin } : {}),
          ...(toolsetNarrow ? { toolsetNarrow } : {}),
          ...(room?.prompt ? { roomPrompt: room.prompt } : {}),
          ...this.rooms.loopOptions(room),
          // Unconditional, not config-driven: UI-card tools have no rendering on
          // any channel adapter, so they never reach a channel turn's tool list.
          toolsetExclude: [...CHANNEL_EXCLUDED_TOOLS],
          // One review hop (D10/D30): `delegate_task` refuses `deliver:'parent'`
          // from inside a review turn by reading this off its ToolContext.
          ...(review ? { reviewOfJobId: review.jobId } : {}),
          // V2-SEC-2 — a tainted job's review starts downgraded (`WakeReview.tainted`).
          ...(review?.tainted ? { untrustedOrigin: true } : {}),
          // openclaw-9.5 item 1 — a user turn answers `credential_required`
          // with a link, never by taking the secret in chat (`deliverAnswer`).
          // A review turn does not opt in: its refusal would reach the user as
          // the plain wake-notice fallback, which is what it gets today.
          ...(review ? {} : { credentialPrompt: true }),
        })) {
          if (event.type === 'usage') {
            const u = this.usageStore.get(laneKey) ?? {
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
            };
            u.inputTokens += event.inputTokens;
            u.outputTokens += event.outputTokens;
            u.costUsd += event.estimatedCostUsd;
            this.usageStore.set(laneKey, u);
            this.addDailySpend(bot, message.platform, event.estimatedCostUsd);
          }
          // From the first tool call on, this turn is never auto-replayed
          // (plan openclaw-9.5-adoption D5). `internal` tool_starts count too:
          // an inner script call is still an action taken on the user's behalf.
          if (event.type === 'tool_start' && spoolTurn) this.markSpoolToolStarted(spoolTurn);
          // Audience boundary (plan decision-provider-personality §15.4): a
          // `decision` row is internal judgement and never reaches a channel —
          // not the draft, not the final. Explicit, not left to the
          // translator's `default`. Pinned by `__tests__/streaming-integration.test.ts`.
          if (event.type === 'decision') continue;
          // Past the terminal event: the tail is drained, not rendered. The
          // answer is already on its way, and anything the tail yields (a
          // turn-end compaction notice) would land after the final.
          if (answer) continue;
          // H1/H2 — feed the liveness timers before the terminal check below
          // disposes them, so a tool_end always cancels its own timer.
          feedback?.onEvent(event);
          translator.push(event);
          if (event.type === 'text_delta') cutOffAtCap = false;
          else if (
            event.type === 'tool_progress' &&
            event.toolName === '_loop' &&
            event.message === MAX_TOKENS_REPLY_NOTICE
          ) {
            cutOffAtCap = true;
          }
          // Feed the live draft. Progress folds in only for `audience:'user'`
          // (W3.3) — the framework never opts a tool in. Fire-and-forget: the
          // streamer serializes internally and finalize() awaits it.
          if (streamer && !signal.aborted) {
            if (event.type === 'text_delta') {
              void streamer.pushText(translator.text);
            } else if (event.type === 'tool_progress' && shouldSurfaceProgress(event)) {
              void streamer.pushProgress(event.message);
            }
          }
          if (translator.error || translator.done) {
            // The answer is going out; the tail is maintenance, not the agent
            // composing a reply, so it gets no typing indicator.
            clearInterval(typingTimer);
            // …and no "working on it" either: nothing may fire after the final.
            feedback?.dispose();
            // The loop reads its steer sink only at its tool seam and at
            // text-end, and has passed its last one, so a message pushed now
            // would be acknowledged ("↩ noted") and then read by nobody.
            // Unhooked, the next message queues on the lane instead — which the
            // tail still holds. A steer already queued that no seam read runs
            // as its own turn, enqueued now so it keeps its place ahead of
            // anything that arrives during the tail (UBP-001).
            this.activeSinks.delete(laneKey);
            if (!signal.aborted && !this.closing) {
              this.requeueUnreadSteers(laneKey, _lane, bot, steerSink, spoolTurn);
            }
            answer = deliverAnswer();
            // Observed by the join below; this only stops a rejection that
            // settles while the tail is still draining from being reported
            // as unhandled.
            answer.catch(() => {});
          }
        }
      } catch (err) {
        // Before the answer, a loop failure is the turn failing: it propagates
        // exactly as it always did. After it, the user already has the answer,
        // so a failure in the turn-end tail is recorded, not thrown back at the
        // adapter that delivered it.
        if (!answer) throw err;
        this.observability?.recordSafetyBlock({
          code: 'gateway.turn_tail_failed',
          cause: 'AgentLoop threw in its turn-end tail after the reply was delivered',
          details: {
            platform: message.platform,
            botKey: bot.botKey,
            chatId: message.chatId,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
      // The join: the lane is released only once delivery has settled too. A
      // tail failure is already recorded above, so a delivery failure thrown
      // here hides nothing.
      if (answer) await answer;
      // An iterator that ends without `done` or `error` — AgentLoop always
      // yields one, test fakes need not: deliver what accumulated.
      else await deliverAnswer();
      if (!review) await this.rooms.notePolicyDigest(sessionKey, message, room);
      completed = true;
    } finally {
      clearInterval(typingTimer);
      feedback?.dispose();
      const answered =
        this.activeTurns.get(laneKey)?.answered === true || spoolTurn?.answered === true;
      this.activeTurns.delete(laneKey);
      this.activeSinks.delete(laneKey);
      // Steers no seam read that the terminal event did not already re-queue
      // (the turn threw, was stopped, or is being shut down) — UBP-001.
      if (!signal.aborted && !this.closing && (completed || answered)) {
        this.requeueUnreadSteers(laneKey, _lane, bot, steerSink, spoolTurn);
      } else {
        this.settleUnreadSteers(steerSink, spoolTurn, answered);
      }
      // A `removeAdapter` may be parked waiting for exactly this turn.
      this.notifyDrainWaiters();

      turnActive = false;
      // Don't deregister — keep the adapter alive to buffer offline notifications
      this.sessionRouting.delete(sessionKey);
      const sessionId = this.sessionIdByKey.get(sessionKey);
      if (sessionId !== undefined) {
        this.approvalRoutes.delete(sessionId);
        this.sessionIdByKey.delete(sessionKey);
      }
      // The lane just went idle — deliver any background-completion notices that
      // were deferred because a turn was running.
      void this.flushWakes(laneKey);
    }
  }

  private deliverVoiceReply(input: {
    adapter: PlatformAdapter;
    botKey: string;
    platform: string;
    chatId: string;
    threadId: string | undefined;
    sessionKey: string;
    text: string;
    personalityId: string | undefined;
    language: string | undefined;
  }): Promise<void> {
    return this.voice.deliverVoiceReply(input);
  }

  private onBackgroundJobComplete(bot: GatewayBotConfig, job: BackgroundJob): void {
    this.wake.onBackgroundJobComplete(bot, job);
  }

  private flushWakes(laneKey: string): Promise<void> {
    return this.wake.flushWakes(laneKey);
  }

  /** @see WakeReviews.admitWakeReview in ./wake-review.ts */
  private admitWakeReview(
    bot: GatewayBotConfig,
    job: BackgroundJob,
    adapter: PlatformAdapter,
    laneKey: string,
  ): Promise<boolean> {
    return this.wake.admitWakeReview(bot, job, adapter, laneKey);
  }

  private enqueueReview(
    bot: GatewayBotConfig,
    adapter: PlatformAdapter,
    message: InboundMessage,
    spoolId: string,
    review: WakeReview,
    laneKey: string,
  ): void {
    this.wake.enqueueReview(bot, adapter, message, spoolId, review, laneKey);
  }

  /** @see WakeReviews.deliverCompletion in ./wake-review.ts */
  private deliverCompletion(
    bot: GatewayBotConfig,
    job: BackgroundJob,
    adapter: PlatformAdapter,
    laneKey: string,
  ): Promise<boolean> {
    return this.wake.deliverCompletion(bot, job, adapter, laneKey);
  }

  /**
   * Resolve a `sessionId` to the adapter/chat/thread its turn originated
   * from — the bridge a `before_tool_call` approval hook needs to surface an
   * approval prompt on the right platform conversation. Returns `undefined`
   * once the turn ends (or if the sessionId was never seen). Platform-
   * agnostic by design: the gateway returns a generic `PlatformAdapter` and
   * never learns which concrete platform is in play.
   */
  /**
   * UBP-046 — subscribe to a user's `/stop`. The listener gets the stopped
   * turn's `sessionId` — the id its `before_tool_call` payloads carry, bridged
   * from `session_start` (`wireBotLoop`) — so an approval surface can settle
   * whatever the turn is parked on: `wireApprovalFlow` passes
   * `ApprovalCoordinator.cancelForSession`, which denies the pending approval,
   * updates its card and lets the aborted turn end, releasing the lane now
   * rather than at the approval timeout. Fired only when a turn on the lane
   * has reached `session_start`. Returns the unsubscribe. Pinned by
   * `__tests__/stop-settles-approval.test.ts`.
   */
  onLaneStop(listener: (stop: LaneStop) => void): () => void {
    this.laneStopListeners.add(listener);
    return () => {
      this.laneStopListeners.delete(listener);
    };
  }

  private notifyLaneStop(sessionKey: string): void {
    const sessionId = this.sessionIdByKey.get(sessionKey);
    if (sessionId === undefined) return;
    for (const listener of this.laneStopListeners) {
      try {
        listener({ sessionId, sessionKey });
      } catch (err) {
        this.observability?.recordSafetyBlock({
          code: 'gateway.lane_stop_listener_failed',
          cause: err instanceof Error ? err.message : String(err),
          details: { sessionKey },
        });
      }
    }
  }

  resolveApprovalRoute(sessionId: string): SessionRouting | undefined {
    return this.approvalRoutes.get(sessionId);
  }

  /**
   * Whether any turn is in flight on this gateway — the busy predicate an
   * idle-watcher consults before a scale-to-zero host is told it may snapshot
   * or stop the VM.
   *
   * Both maps are read from one accessor because they are two halves of the
   * same fact: `activeTurns` and `activeSinks` are set together at turn start.
   * The sink is unhooked at the turn's terminal event and the turn entry only
   * in `runTurn`'s `finally`, so `activeTurns` is the half that covers the
   * turn-end tail (F07) — which still writes the session store. The `||` is the
   * conservative half — if a sink ever outlived its turn it would still be work
   * in flight, and answering "idle" there would stop the process out from
   * under a live steer.
   */
  hasActiveTurns(): boolean {
    return this.activeTurns.size > 0 || this.activeSinks.size > 0;
  }

  /**
   * Stop all active session lanes gracefully. If `notify` is set, send that
   * text to every chat with an in-flight turn before aborting — so users
   * never see silent failure on shutdown / upgrade. See IMPROVEMENT.md P1-1
   * and OpenClaw #71178 (mid-turn update drops every Telegram message).
   *
   * A turn whose reply already landed and is only draining AgentLoop's
   * turn-end tail (F07, see `runTurn`) gets NO notice: the user has the
   * answer, and "please resend" would buy a duplicate turn. Its lane is
   * aborted like every other; nothing it still does can send a second reply.
   * Pinned by `__tests__/turn-tail.test.ts`.
   *
   * A turn with an inbound-spool row gets no `notify` either (D19): the replay
   * answers it, or — a tool had started — `finishSpoolTurn` sends
   * INTERRUPTED_RETRY_NOTICE. Pinned by `__tests__/inbound-spool.test.ts`
   * ('shutdown').
   *
   * RETURNS ONLY ONCE THE ABORTED TURNS HAVE UNWOUND — each `runTurn`,
   * including the turn-end tail it drains — or `drainTimeoutMs` (default
   * {@link SHUTDOWN_DRAIN_TIMEOUT_MS}) has passed, whichever is first. Callers
   * dispose each bot's loop right after this returns; returning with turns
   * still live handed them a runtime being torn down. A turn that outlives the
   * bound is recorded (`gateway.shutdown_drain_timeout`), not waited on for
   * ever. Pinned by `__tests__/turn-tail.test.ts` ('shutdown waits').
   *
   * `drainTimeoutMs` bounds the WHOLE call, the notice sends included: one
   * deadline is taken on entry, a notice send still pending at it is left
   * behind (`gateway.shutdown_notify_timeout`), and the drain gets whatever
   * time the sends left. `ethos run-all`'s child budget counts this call as one
   * `SHUTDOWN_DRAIN_TIMEOUT_MS` on that basis. Pinned by
   * `__tests__/turn-tail.test.ts` ('a hung notice send').
   */
  async shutdown(opts: { notify?: string; drainTimeoutMs?: number } = {}): Promise<void> {
    // First, before any await: inbound from here on is refused, not started.
    this.closing = opts.notify ? { notify: opts.notify } : {};
    const drainTimeoutMs = opts.drainTimeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS;
    const deadline = Date.now() + drainTimeoutMs;
    if (opts.notify) {
      const sends: Promise<unknown>[] = [];
      for (const [laneKey, ctx] of this.activeTurns) {
        if (ctx.answered) continue;
        // A spooled turn is not told "please resend" (plan openclaw-9.5-adoption
        // D19): with no tool started its row goes back to `received` and the
        // next boot's replay answers it, so the notice would buy a second
        // answer; with a tool started it becomes `interrupted` and gets
        // INTERRUPTED_RETRY_NOTICE instead. Both happen in `finishSpoolTurn` as
        // the aborted turn unwinds. Only unspooled turns keep this notice.
        if (this.spoolTurns.get(laneKey)?.id) continue;
        // Recorded so a message this chat sends during the drain is not told
        // the same thing twice (`refuseWhileClosing` dedups on the lane key).
        this.outboundDedup.record(laneKey, opts.notify);
        sends.push(
          ctx.adapter
            .send(ctx.chatId, {
              text: opts.notify,
              // H6 — back into the thread the interrupted turn was in.
              ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
            })
            .catch(() => {}),
        );
      }
      if (sends.length > 0) {
        let pending = sends.length;
        for (const send of sends) void send.then(() => pending--);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
          Promise.allSettled(sends).then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), drainTimeoutMs);
          }),
        ]);
        clearTimeout(timer);
        if (timedOut) {
          this.observability?.recordSafetyBlock({
            code: 'gateway.shutdown_notify_timeout',
            cause: 'shutdown notice sends were still pending when the shutdown bound expired',
            details: { stillPending: pending, timeoutMs: drainTimeoutMs },
          });
        }
      }
    }
    if (this.clarifySweepTimer) {
      clearInterval(this.clarifySweepTimer);
      this.clarifySweepTimer = undefined;
    }
    if (this.clarifyEscalationTimer) {
      clearInterval(this.clarifyEscalationTimer);
      this.clarifyEscalationTimer = undefined;
    }
    if (this.bgWakeSweepTimer) {
      clearInterval(this.bgWakeSweepTimer);
      this.bgWakeSweepTimer = undefined;
    }
    if (this.spoolReplayTimer) {
      clearInterval(this.spoolReplayTimer);
      this.spoolReplayTimer = undefined;
    }
    if (this.deliverySweepTimer) {
      clearInterval(this.deliverySweepTimer);
      this.deliverySweepTimer = undefined;
    }
    for (const undos of this.botCleanups.values()) for (const undo of undos) undo();
    this.botCleanups.clear();
    this.pendingWakes.clear();
    for (const lane of this.lanes.values()) {
      lane.abort();
    }
    await this.awaitInflightTurns(Math.max(0, deadline - Date.now()));
    // A redelivery mid-send when the caller closes the ledger would leave its
    // row claimed until `reclaimStaleClaims`; give it what is left of the bound.
    const sweep = this.deliverySweepInFlight;
    if (sweep) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        sweep.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        }),
      ]);
      clearTimeout(timer);
    }
    this.lanes.clear();
    this.sessionKeys.clear();
    this.activeTurns.clear();
    this.activeSinks.clear();
    this.sessionRouting.clear();
    this.approvalRoutes.clear();
    this.sessionIdByKey.clear();
  }

  /**
   * An inbound that arrived after `shutdown()` began. It starts no turn and is
   * steered into none. With a `notify` text it gets that text — the same
   * "please resend" an interrupted turn gets, and just as true, since this
   * message will not be answered either — through the ordinary outbound dedup,
   * keyed on its lane, so a chat hears it once however many messages it sends
   * (and not again if its in-flight turn was already told). Without one it is
   * dropped silently, which is what `shutdown()` without `notify` does to
   * in-flight turns. Either way the drop is recorded.
   */
  private async refuseWhileClosing(
    message: InboundMessage,
    adapter: PlatformAdapter,
    closing: { notify?: string },
  ): Promise<void> {
    const botKey = this.routedBotKey(message);
    this.observability?.recordSafetyBlock({
      code: 'gateway.shutting_down',
      cause: 'inbound message arrived while the gateway was shutting down',
      details: { platform: message.platform, chatId: message.chatId, botKey },
    });
    const notify = closing.notify;
    if (!notify) return;
    const threadId = message.threadId ? message.threadId : undefined;
    const laneKey = threadId
      ? buildLaneKey(message.platform, botKey, message.chatId, threadId)
      : buildLaneKey(message.platform, botKey, message.chatId);
    if (!this.outboundDedup.shouldSend(laneKey, notify)) return;
    await adapter.send(message.chatId, { text: notify, threadId }).catch(() => {});
  }

  /**
   * The botKey a message ROUTES to: its own, or the sole bot when its own
   * names no bot this process serves (`handleMessage`'s single-bot degrade —
   * `gateway.unknown_botKey`; `defaultBotKey` is null in multi-bot, so nothing
   * degrades there). ONE derivation, because the lane key is built from it in
   * two places: the turn's, and `refuseWhileClosing`'s. A second derivation
   * that disagreed keyed the same chat two ways and told it to resend twice.
   */
  private routedBotKey(message: InboundMessage): string {
    const claimed = message.botKey ?? this.defaultBotKey ?? '';
    return this.bots.has(claimed) ? claimed : (this.defaultBotKey ?? claimed);
  }

  /** Wait for every in-flight `runTurn` to settle, or `timeoutMs` — see `shutdown`. */
  private async awaitInflightTurns(timeoutMs: number): Promise<void> {
    const turns = [...this.inflightTurns];
    if (turns.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled(turns).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      this.observability?.recordSafetyBlock({
        code: 'gateway.shutdown_drain_timeout',
        cause: 'aborted turns were still running when the shutdown drain bound expired',
        details: { stillRunning: this.inflightTurns.size, timeoutMs },
      });
    }
  }

  /** Call after all plugins are loaded to register plugin slash commands with platform adapters. */
  async pluginsReady(): Promise<void> {
    const cmds =
      this.pluginLoader
        ?.getAllSlashCommands()
        .map((c) => ({ name: c.name, description: c.description })) ?? [];
    if (cmds.length === 0) return;
    for (const adapter of this.adapterRegistry.values()) {
      await adapter.registerCommands?.(cmds).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Durable delivery obligations (item 9)
  // ---------------------------------------------------------------------------

  /**
   * The adapter that speaks AS `botKey` on `platform` — the only adapter a
   * tracked send filed under `botKey` may leave through (F08).
   *
   * `adapterRegistry` is one-per-platform: the platform's DEFAULT adapter, for
   * sends that are intentionally platform-addressed (`sendTo`, the
   * `send_message` tool). Resolving a tracked send there let SalesBot's adapter
   * deliver SupportBot's obligation, and SalesBot's `ok: true` then marked
   * SupportBot's row delivered. This resolves through `botAdapters` instead and
   * requires the adapter's platform to agree with the send's. No match →
   * `undefined`, and every caller leaves the work pending (or refuses) rather
   * than borrowing a sibling bot's adapter.
   *
   * ONE alias, conditional and applied only here: in a SINGLE-bot deployment
   * (`defaultBotKey` set) the sole bot is served by every adapter in the
   * process — `handleMessage` routes any inbound whose botKey it does not know
   * to that bot (`gateway.unknown_botKey`) — so its replies may have left
   * through an adapter filed under another key, and the platform's adapter IS
   * its adapter. In a multi-bot deployment `defaultBotKey` is null and nothing
   * is borrowed. Both halves pinned by `__tests__/bot-addressed-delivery.test.ts`.
   */
  private adapterForBot(botKey: string, platform: string): PlatformAdapter | undefined {
    const own = this.botAdapters.get(botKey);
    if (own && platformOfAdapterId(own.id) === platform) return own;
    if (botKey === this.defaultBotKey) return this.adapterRegistry.get(platform);
    return undefined;
  }

  /** The ledger binding for one bot, or `undefined` when no ledger is wired. */
  private deliveryBinding(
    botKey: string,
    platform: string,
    inboundRef?: string,
  ): DeliveryBinding | undefined {
    const ledger = this.deliveryLedger;
    if (!ledger) return undefined;
    return {
      ledger,
      botKey,
      platform,
      ...(inboundRef ? { inboundRef } : {}),
      onLedgerError: (stage, error) => {
        this.observability?.recordSafetyBlock({
          code: 'gateway.delivery_ledger_error',
          cause: `delivery ledger ${stage} failed`,
          details: { stage, botKey, platform, error },
        });
      },
    };
  }

  /**
   * Send a reply with a durable obligation wrapped around it.
   *
   * `DeliveryResult.ok === true` is the ONLY definition of confirmed. Every
   * shipped adapter catches platform failures and returns `{ ok: false }`
   * rather than throwing, so "the promise resolved" would mark exactly the
   * failures this ledger exists to catch as delivered. A rejected promise is
   * folded into the same `{ ok: false }` shape so a throwing adapter still
   * leaves the obligation `pending` — and, as before, never breaks the turn.
   *
   * Returns whether the platform confirmed.
   */
  private async sendTracked(
    target: {
      adapter: PlatformAdapter;
      botKey: string;
      platform: string;
      chatId: string;
      sessionKey: string;
      /** Spool id of the inbound message this reply answers. */
      inboundRef?: string;
    },
    message: OutboundMessage,
    card?: InitiativeDigest,
  ): Promise<boolean> {
    return (await this.sendTrackedDetailed(target, message, card)).confirmed;
  }

  /**
   * {@link sendTracked}, with the obligation id the caller filed under.
   *
   * Same single path — this IS the body, and `sendTracked` is the boolean
   * shorthand over it. Only a caller that must hand the obligation to someone
   * else needs the id: `deliverPublication` stores it on the outbox item so the
   * UI can show the ledger row's live status for an unconfirmed publication,
   * and so the outbox knows the ledger owns the retry.
   *
   * `null` means no obligation exists — no ledger is wired, or the ledger write
   * itself failed (which is surfaced, not thrown). The send still happens.
   */
  private async sendTrackedDetailed(
    target: {
      adapter: PlatformAdapter;
      botKey: string;
      platform: string;
      chatId: string;
      sessionKey: string;
      inboundRef?: string;
    },
    message: OutboundMessage,
    card?: InitiativeDigest,
  ): Promise<{ confirmed: boolean; obligationId: string | null }> {
    const binding = this.deliveryBinding(target.botKey, target.platform, target.inboundRef);
    const obligationId = await beginDelivery(binding, {
      chatId: target.chatId,
      sessionId: target.sessionKey,
      // Every caller already puts the thread on the OutboundMessage, so the
      // ledger reads it from the same place the platform call does — there is
      // no second source that could drift.
      threadId: message.threadId,
      content: message.text,
    });
    // Registered in flight by `beginDelivery` until the send settles, so the
    // sweep does not redeliver a send that outlasts its age grace.
    let result: DeliveryResult;
    try {
      // An owner digest goes out as a button card on an adapter that renders one, with the same
      // text the obligation holds as its fallback; everything else is the plain send.
      const attempt =
        card && isInitiativeCardAdapter(target.adapter)
          ? target.adapter.sendInitiativeDigest(target.chatId, card, {
              text: message.text,
              ...(message.threadId ? { threadId: message.threadId } : {}),
            })
          : target.adapter.send(target.chatId, message);
      result = await attempt.catch(
        (err: unknown): DeliveryResult => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      if (result?.ok === true) {
        await confirmDelivery(binding, obligationId);
        return { confirmed: true, obligationId };
      }
    } finally {
      endDelivery(binding, obligationId);
    }
    // Leave the row `pending` — the next boot sweep redelivers it. Surface the
    // failure too: before this, a failed send was completely invisible.
    this.observability?.recordSafetyBlock({
      code: 'gateway.delivery_unconfirmed',
      cause: 'adapter did not confirm delivery',
      details: {
        platform: target.platform,
        botKey: target.botKey,
        chatId: target.chatId,
        error: result?.error,
        durable: obligationId !== null,
      },
    });
    return { confirmed: false, obligationId };
  }

  /**
   * Send an agent- or subsystem-initiated notification through the DURABLE
   * outbound path — the public door onto `sendTracked`.
   *
   * `sendTo()` is the other public send and records no obligation: it is the
   * `send_message` tool's path, where the agent is told immediately whether the
   * send worked and can react. This one is for messages nobody is waiting on —
   * a post-call summary, an owner notice that a call was refused for capacity —
   * where "silently lost" is the failure mode and a `pending` row that the boot
   * sweep redelivers is the fix. Same ledger, same `DeliveryResult.ok === true`
   * definition of confirmed, same observability event on an unconfirmed send;
   * there is deliberately no second ledger path.
   *
   * Returns whether the platform CONFIRMED. `false` with a ledger wired means
   * the obligation is still `pending` and will be retried by
   * {@link sweepPendingDeliveries}. `'held'` means the notice was stored for
   * quiet hours or a lane `/mute` ({@link holdNotice}) and is owed, not failed:
   * {@link releaseHeldNotices} sends it through the ledger once the hold ends
   * (pinned by the U11 cases in `__tests__/notify-tracked.test.ts`). It is
   * truthy on purpose, so a caller that only asks "did this fail?" (`!ok`)
   * does not report a held notice as a failure.
   *
   * Refuses (returning false, and recording the same unconfirmed event) when
   * the bot cannot be named, or when that bot has no adapter on the platform
   * here: an obligation filed under a botKey this process does not own is one
   * the sweep will never pick up, which is a lost message wearing a durable
   * row, and one sent through a SIBLING bot's adapter would be confirmed by the
   * wrong bot (F08). In multi-bot deployments `botKey` is therefore required —
   * `voice.inbound.owner` carries one for exactly this reason.
   */
  async notifyTrackedOutcome(
    target: {
      platform: string;
      chatId: string;
      botKey?: string;
      /** Ledger session id. Defaults to `<platform>:<chatId>`. */
      sessionKey?: string;
      threadId?: string;
      /**
       * The notice answers the user's own message (a dead-letter, interrupted
       * or missed-while-restarting notice). Never held for quiet hours or a
       * mute (U11): the user is there, waiting on it.
       */
      answersInbound?: boolean;
    },
    text: string,
    /**
     * The owner digest behind `text`. A card-capable adapter renders its buttons; a held notice
     * (quiet hours) and a ledger redelivery carry only `text`. Not a recipient: that stays `target`.
     */
    extra?: { initiativeDigest?: InitiativeDigest },
  ): Promise<NotifyOutcome> {
    const refuse = (cause: string): 'failed' => {
      this.observability?.recordSafetyBlock({
        code: 'gateway.delivery_unconfirmed',
        cause,
        details: {
          platform: target.platform,
          ...(target.botKey ? { botKey: target.botKey } : {}),
          chatId: target.chatId,
          durable: false,
        },
      });
      return 'failed';
    };

    const botKey = target.botKey ?? this.defaultBotKey;
    if (!botKey) return refuse('no botKey given and this deployment has no single default bot');
    if (!this.bots.has(botKey)) return refuse(`botKey "${botKey}" is not served by this process`);

    // The bot's own adapter, never the platform's default — see `adapterForBot`.
    const adapter = this.adapterForBot(botKey, target.platform);
    if (!adapter) {
      return refuse(`no adapter registered for bot "${botKey}" on platform "${target.platform}"`);
    }

    const sessionKey = target.sessionKey ?? `${target.platform}:${target.chatId}`;
    // U11 — quiet hours / a lane mute hold an unprompted notice. `'held'`:
    // nothing was sent yet, but it is owed; the release goes through `sendTracked`.
    if (!target.answersInbound) {
      const laneKey = laneKeyOf(target.platform, botKey, target.chatId, target.threadId);
      const held = await this.holdNotice({
        botKey,
        platform: target.platform,
        chatId: target.chatId,
        ...(target.threadId ? { threadId: target.threadId } : {}),
        laneKey,
        sessionKey,
        text,
      });
      if (held) return 'held';
    }

    const sent = await this.sendTrackedDetailed(
      {
        adapter,
        botKey,
        platform: target.platform,
        chatId: target.chatId,
        sessionKey,
      },
      { text, ...(target.threadId ? { threadId: target.threadId } : {}) },
      extra?.initiativeDigest,
    );
    if (sent.confirmed) return 'confirmed';
    return sent.obligationId === null ? 'failed' : 'owed';
  }

  /**
   * {@link notifyTrackedOutcome} as the boolean the other callers read: `'owed'` (unconfirmed, but
   * the ledger holds a `pending` row the sweep redelivers) is `false`, exactly as before.
   */
  async notifyTracked(
    target: Parameters<Gateway['notifyTrackedOutcome']>[0],
    text: string,
    extra?: { initiativeDigest?: InitiativeDigest },
  ): Promise<boolean | 'held'> {
    const outcome = await this.notifyTrackedOutcome(target, text, extra);
    return outcome === 'held' ? 'held' : outcome === 'confirmed';
  }

  /**
   * `dmPolicy: decline` — whether this sender's refusal may go out now. Held is
   * checked FIRST: a held refusal is suppressed and does not spend the window
   * (D23). Any store failure fails closed to silence, never a turn.
   */
  private declineOutcome(
    message: InboundMessage,
    botKey: string,
    laneKey: string,
  ): 'sent' | 'held' | 'rate_limited' | 'unavailable' {
    if (this.noticeHoldReason(botKey, laneKey)) return 'held';
    if (!this.pairingDb) return 'unavailable';
    try {
      const won = claimDeclineSlot(this.pairingDb, {
        platform: message.platform,
        botKey,
        senderId: message.userId ?? '',
      });
      return won ? 'sent' : 'rate_limited';
    } catch {
      return 'unavailable';
    }
  }

  /**
   * U11 — why an unprompted notice for `laneKey` must wait right now: the
   * lane's `/mute` has not expired, or `now` is inside the bot's quiet hours
   * (`GatewayConfig.quietHours`, evaluated in its explicit time zone). Null
   * when it may go. The ONE decision for every held path: `notifyTracked`,
   * `deliverCompletion`, `admitWakeReview`, and the releases in
   * `releaseHeldNotices` and `releaseParkedReviews`.
   */
  private noticeHoldReason(
    botKey: string,
    laneKey: string,
    now: number = Date.now(),
  ): 'muted' | 'quiet_hours' | null {
    const mutedUntil = this.laneMutes.get(laneKey);
    if (mutedUntil !== undefined && mutedUntil > now) return 'muted';
    const window = quietWindowFor(this.quietHours, botKey);
    if (window && this.quietHours && inQuietHours(window, this.quietHours.timeZone, now)) {
      return 'quiet_hours';
    }
    return null;
  }

  /**
   * Hold `notice` when {@link noticeHoldReason} says so. Returns whether it was
   * held. Without a `heldNotices` store nothing is held — a notice kept only in
   * memory is lost by a restart, and "never dropped" outranks "not at night".
   * A store write that throws also sends now, for the same reason.
   */
  private async holdNotice(notice: Omit<HeldNotice, 'id' | 'heldAt'>): Promise<boolean> {
    const store = this.heldNotices;
    if (!store) return false;
    const reason = this.noticeHoldReason(notice.botKey, notice.laneKey);
    if (!reason) return false;
    try {
      await store.hold(notice);
    } catch (err) {
      this.observability?.recordSafetyBlock({
        code: 'gateway.notice_hold_failed',
        cause: err instanceof Error ? err.message : String(err),
        details: { botKey: notice.botKey, platform: notice.platform, reason },
      });
      return false;
    }
    this.observability?.recordSafetyBlock({
      code: 'gateway.notice_held',
      cause: reason,
      details: { botKey: notice.botKey, platform: notice.platform, chatId: notice.chatId },
    });
    return true;
  }

  /**
   * U11 — deliver every held notice whose lane is no longer muted and whose
   * bot is out of quiet hours, through `sendTracked` (ledger `pending` first),
   * then drop it from the store. A crash between the two re-sends it on the
   * next pass: at-least-once, like the ledger. A notice whose bot has no
   * adapter here stays held. Run at the top of every delivery sweep
   * (`sweepDeliveriesOnce`), so it follows the sweep's boot pass and 60s timer.
   */
  async releaseHeldNotices(): Promise<number> {
    const store = this.heldNotices;
    if (!store) return 0;
    let held: HeldNotice[];
    try {
      held = await store.listHeld();
    } catch {
      return 0;
    }
    let released = 0;
    for (const notice of held) {
      if (!this.bots.has(notice.botKey)) continue;
      if (this.noticeHoldReason(notice.botKey, notice.laneKey)) continue;
      const adapter = this.adapterForBot(notice.botKey, notice.platform);
      if (!adapter) continue;
      await this.sendTracked(
        {
          adapter,
          botKey: notice.botKey,
          platform: notice.platform,
          chatId: notice.chatId,
          sessionKey: notice.sessionKey,
        },
        { text: notice.text, ...(notice.threadId ? { threadId: notice.threadId } : {}) },
      );
      await store.markReleased(notice.id).catch(() => {});
      released++;
    }
    return released;
  }

  /** @see WakeReviews.releaseParkedReviews in ./wake-review.ts */
  private releaseParkedReviews(): Promise<number> {
    return this.wake.releaseParkedReviews();
  }

  /**
   * Publish ONE approved outbox item (O-T5, plan/phases/trust-before-reach.md).
   *
   * The whole point of this method is that a publication goes out as the bot a
   * human approved it for, or it does not go out. Every other outbound path can
   * afford to be addressed at a platform; this one cannot, because the card the
   * approver tapped named the sending bot, and with two bots on one platform a
   * platform-resolved send publishes B's post in A's voice to A's audience.
   *
   * In order:
   *  1. The bot must be served here and have its OWN adapter on the platform
   *     ({@link adapterForBot}, F08 — a sibling's adapter is never borrowed).
   *     No adapter means this process refuses and the item stays `approved`
   *     for the process that does own that bot; it never falls back.
   *  2. The bot must STILL speak for the personality
   *     ({@link GatewayConfig.publicationSpeaksFor}) — the same re-check cron
   *     does (`createCronDeliver`), at bot granularity. Approval happened in the
   *     past; a rebinding since then voids it.
   *  3. `outboundDedup.shouldSend('outbox:<id>', text)` — the single outbound
   *     chokepoint. The outbox adds NO dedup of its own (CLAUDE.md channel
   *     adapter contract).
   *  4. {@link sendTrackedDetailed} with ledger session `outbox:<id>`, so an
   *     unconfirmed publication leaves a `pending` row that
   *     {@link sweepPendingDeliveries} redelivers — through the same bot, since
   *     the row carries its botKey.
   *
   * `text` reaches the adapter byte-identical to the approved revision. No
   * trimming, no normalisation: the content hash the human approved binds those
   * exact bytes, and anything else publishes something nobody approved.
   *
   * Never throws for a delivery failure — an adapter that throws folds into
   * `confirmed: false` inside `sendTrackedDetailed`, leaving the obligation
   * `pending`.
   */
  async deliverPublication(request: PublicationRequest): Promise<PublicationResult> {
    const refuse = (code: PublicationRefusalCode, message: string): PublicationResult => {
      this.observability?.recordSafetyBlock({
        code: 'outbox.publication_refused',
        cause: message,
        details: {
          reason: code,
          itemId: request.itemId,
          personalityId: request.personalityId,
          botKey: request.botKey,
          platform: request.platform,
          chatId: request.chatId,
        },
      });
      return { confirmed: false, obligationId: null, refusal: { code, message } };
    };

    if (!this.bots.has(request.botKey)) {
      return refuse(
        'bot_not_served',
        `bot "${request.botKey}" is not served by this process — nothing was sent`,
      );
    }
    const adapter = this.adapterForBot(request.botKey, request.platform);
    if (!adapter) {
      return refuse(
        'no_adapter',
        `no ${request.platform} adapter is registered for bot "${request.botKey}" here — ` +
          'nothing was sent. Another bot must not publish in its place.',
      );
    }

    const speaksFor = this.publicationSpeaksFor;
    if (!speaksFor) {
      return refuse(
        'no_binding_check',
        'no publicationSpeaksFor check is wired into this gateway — a publication is not ' +
          'sent on the assumption that its bot is still bound',
      );
    }
    if (!speaksFor(request.botKey, request.personalityId)) {
      return refuse(
        'not_bound',
        `bot "${request.botKey}" no longer speaks for personality "${request.personalityId}" — ` +
          'the approval named that bot, so nothing was sent',
      );
    }

    const sessionKey = `outbox:${request.itemId}`;
    if (!this.outboundDedup.shouldSend(sessionKey, request.text)) {
      return refuse(
        'deduplicated',
        `identical text already passed the outbound chokepoint for ${sessionKey} within the ` +
          'dedup window — nothing was sent by this call',
      );
    }

    return this.sendTrackedDetailed(
      {
        adapter,
        botKey: request.botKey,
        platform: request.platform,
        chatId: request.chatId,
        sessionKey,
      },
      { text: request.text, ...(request.threadId ? { threadId: request.threadId } : {}) },
    );
  }

  /** @see DeliveryLedgerSweep.sweepPendingDeliveries in ./delivery-ledger-sweep.ts */
  sweepPendingDeliveries(): Promise<{ redelivered: number; failed: number }> {
    return this.deliverySweep.sweepPendingDeliveries();
  }

  /** @see DeliveryLedgerSweep.localInboundId in ./delivery-ledger-sweep.ts */
  private localInboundId(message: InboundMessage): string {
    return this.deliverySweep.localInboundId(message);
  }

  /** UBP-020 — a turn ended with no reply text; the user got a notice instead. */
  private recordEmptyReply(message: InboundMessage, bot: GatewayBotConfig, cause: string): void {
    this.observability?.recordSafetyBlock({
      code: 'gateway.empty_reply',
      cause: `turn ended with no reply text: ${cause}`,
      details: { platform: message.platform, chatId: message.chatId, botKey: bot.botKey },
    });
  }

  /** @see DeliveryLedgerSweep.recordRedelivered in ./delivery-ledger-sweep.ts */
  private recordRedelivered(row: DeliveryObligation): void {
    this.deliverySweep.recordRedelivered(row);
  }

  /** @see DeliveryLedgerSweep.startDeliverySweep in ./delivery-ledger-sweep.ts */
  startDeliverySweep(): void {
    this.deliverySweep.startDeliverySweep();
  }

  /** @see DeliveryLedgerSweep.settleRefusedRedelivery in ./delivery-ledger-sweep.ts */
  private settleRefusedRedelivery(
    row: DeliveryObligation,
    ledger: DeliveryLedger,
    refusal: { error?: string; permanent?: boolean },
  ): Promise<void> {
    return this.deliverySweep.settleRefusedRedelivery(row, ledger, refusal);
  }

  applyPauseOffset(pauseDurationMs: number): void {
    this.voice.applyPauseOffset(pauseDurationMs);
  }

  /** @see VoiceReply.pruneVoiceArtifacts in ./voice-reply.ts */
  pruneVoiceArtifacts(opts: {
    abandonAfterDays: number;
    maxTotalMb: number;
  }): Promise<{ abandoned: number; bytesFreed: number }> {
    return this.voice.pruneVoiceArtifacts(opts);
  }

  sweepUndeliveredJobs(): Promise<{ delivered: number; failed: number }> {
    return this.wake.sweepUndeliveredJobs();
  }

  // ---------------------------------------------------------------------------
  // Mid-run "needs you" escalation (§4.6 rung 3)
  // ---------------------------------------------------------------------------

  /**
   * Push a "needs you" notice to the origin lane of every run parked on a
   * question that has been PRESENTED and unanswered for longer than
   * `clarifyEscalationDelayMs` (§4.6 rung 3, D2's clock rule).
   *
   * Runs on its own timer, and is public so a caller (or a test) can drive one
   * pass deterministically. Per bot: the bridge supplies the SHARED clarify
   * store every process sweeps, the job store supplies G5's second claim
   * (`claimNotice`, keyed by `requestId` so it never spends the completion
   * notice's `deliveredAt`), and delivery goes through `sendTracked` — the same
   * ledger-backed path the completion notice uses, so an unconfirmed push is
   * redelivered by `sweepPendingDeliveries()` rather than lost.
   *
   * Never throws: it is called from a timer with no one to catch it.
   */
  async sweepClarifyEscalations(
    now: number = Date.now(),
  ): Promise<{ pushed: number; failed: number }> {
    let pushed = 0;
    let failed = 0;
    for (const bot of this.bots.values()) {
      const bridge = bot.loop.clarifyBridge;
      const store = bot.jobStore;
      if (!bridge || !store) continue;
      const result = await runClarifyEscalationSweep(
        {
          store: bridge.store,
          jobs: store,
          delayMs: this.clarifyEscalationDelayMs,
          // With a ledger wired, an unconfirmed push left a `pending`
          // obligation and the ledger sweep owns the retry, so the claim is
          // kept. Without one, nothing would ever retry — release it.
          durableRetry: this.deliveryLedger !== undefined,
          resolveTarget: (job) => this.clarifyNoticeTarget(bot, job),
          notify: (target, text) => this.deliverClarifyNotice(bot, target, text),
          onError: (stage, err, details) => {
            this.observability?.recordSafetyBlock({
              code: 'clarify.escalation_failed',
              cause: err instanceof Error ? err.message : String(err),
              details: { stage, botKey: bot.botKey, ...details },
            });
          },
        },
        now,
      );
      pushed += result.pushed;
      failed += result.failed;
    }
    return { pushed, failed };
  }

  /**
   * The lane a parked run's notice is pushed to, or `null` to skip it: a job
   * with no recorded origin (CLI-owned), a job whose origin belongs to a
   * DIFFERENT bot in a shared store (an obligation filed under someone else's
   * botKey is a lost message), or a bot with no adapter here on that platform
   * (`adapterForBot` — a sibling bot's adapter is never borrowed, F08).
   * Skipping returns the row untouched — its claim is never spent.
   */
  private clarifyNoticeTarget(
    bot: GatewayBotConfig,
    job: BackgroundJob,
  ): ClarifyNoticeTarget | null {
    const platform = job.originPlatform;
    const chatId = job.originChatId;
    if (!platform || !chatId) return null;
    if (job.originBotKey && job.originBotKey !== bot.botKey) return null;
    if (!this.adapterForBot(bot.botKey, platform)) return null;
    return {
      platform,
      botKey: bot.botKey,
      chatId,
      ...(job.originThreadId ? { threadId: job.originThreadId } : {}),
    };
  }

  /**
   * Send one escalation notice through the durable outbound path. Returns
   * whether the platform confirmed; a dedup hit counts as confirmed, since the
   * identical text already reached this lane.
   */
  private async deliverClarifyNotice(
    bot: GatewayBotConfig,
    target: ClarifyNoticeTarget,
    text: string,
  ): Promise<boolean> {
    const adapter = this.adapterForBot(bot.botKey, target.platform);
    if (!adapter) return false;
    const laneKey = target.threadId
      ? buildLaneKey(target.platform, bot.botKey, target.chatId, target.threadId)
      : buildLaneKey(target.platform, bot.botKey, target.chatId);
    if (!this.outboundDedup.shouldSend(laneKey, text)) return true;
    return this.sendTracked(
      {
        adapter,
        botKey: bot.botKey,
        platform: target.platform,
        chatId: target.chatId,
        sessionKey: this.sessionKeys.get(laneKey) ?? laneKey,
      },
      { text, ...(target.threadId ? { threadId: target.threadId } : {}) },
    );
  }

  /**
   * The thread a live turn on `sessionKey` originated in. The gateway is the one
   * component that knows this mapping (`ToolContext` carries no thread), so it
   * is exposed for wiring to hand to the background tools — a `delegate_task`
   * job stamps it as `origin_thread_id` and its completion returns to the
   * sub-conversation that asked for it. `undefined` once the turn ends.
   */
  originThreadIdFor(sessionKey: string): string | undefined {
    return this.sessionRouting.get(sessionKey)?.threadId;
  }

  /**
   * The platform user whose message started the live turn on `sessionKey`
   * (`SessionRouting.requesterUserId`), for the same reason as
   * `originThreadIdFor`: a `delegate_task` job stamps it as `origin_user_id`
   * so the job's clarify binds to that user. `undefined` once the turn ends.
   */
  originUserIdFor(sessionKey: string): string | undefined {
    return this.sessionRouting.get(sessionKey)?.requesterUserId;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Whether `/personality` switching is permitted for this lane's bot.
   *  Team bots always reject (coordinator is structural). Personality
   *  bots reject unless `binding.allowSlashSwitch` is on. */
  private personalitySwitchAllowed(bot: GatewayBotConfig): boolean {
    if (bot.binding.type === 'team') return false;
    return bot.binding.allowSlashSwitch === true;
  }

  /** @see GatewayAudience.audienceFor in ./audience.ts */
  private audienceFor(message: InboundMessage): TurnAudience {
    return this.audience.audienceFor(message);
  }

  private withholdsPersonalityMemory(message: InboundMessage): boolean {
    return this.audience.withholdsPersonalityMemory(message);
  }

  /** Lane scope + requester audience + untracked ack sender for `./job-commands`. */
  private jobCommandContext(
    bot: GatewayBotConfig,
    message: InboundMessage,
    threadId: string | undefined,
    adapter: PlatformAdapter,
  ) {
    return {
      bot,
      message,
      threadId,
      audience: this.jobAudienceFor(message),
      send: async (text: string) => {
        await adapter.send(message.chatId, { text, threadId }).catch(() => {});
      },
    };
  }

  private jobAudienceFor(message: InboundMessage): TurnAudience {
    return this.audience.jobAudienceFor(message);
  }

  private laneSessionIsShared(sessionKey: string, message: InboundMessage): Promise<boolean> {
    return this.audience.laneSessionIsShared(sessionKey, message);
  }

  private reviewAudience(job: BackgroundJob): TurnAudience {
    return this.audience.reviewAudience(job);
  }

  /**
   * `/mcp login <server> | code <url> | cancel` (plan mcp-device-code-login §8.3).
   * Runs BEFORE the agent like `/allow`: no turn, no session row, nothing for the
   * LLM to read — pinned by `__tests__/mcp-login.test.ts` "/mcp messages never
   * reach the AgentLoop". The seven checks run in the plan's order and the first
   * failure answers and stops; nothing is started and no request is made before
   * all of them pass (D12), pinned by the refusal cases in the same file. Every
   * reply is an untracked, dedup-gated `adapter.send` (D17: no ledger
   * obligation, no quiet-hours or `/mute` hold) to the lane the owner wrote from.
   */
  private async handleMcpCommand(
    message: InboundMessage,
    adapter: PlatformAdapter,
    bot: GatewayBotConfig,
    laneKey: string,
    threadId: string | undefined,
    text: string,
  ): Promise<void> {
    const reply = (body: string): Promise<void> =>
      this.sendMcpReply(adapter, message.chatId, threadId, laneKey, body);
    const port = this.mcpLoginFor?.(bot.botKey) ?? bot.mcpLogin;
    if (!port) return reply('MCP sign-in is not available on this gateway.');
    const personalityId = this.turnPersonalityFor(laneKey, bot);
    if (personalityId === undefined) return reply('Sign in from the CLI for team bots.');
    const owner = this.channelFilter?.[message.platform]?.ownerUserId;
    if (owner === undefined || owner === '') {
      return reply(`Set channel_filter.${message.platform}.ownerUserId in config.yaml.`);
    }
    if (!senderIsOwner(message, owner)) return reply('Only the owner may sign in to MCP servers.');
    if (!message.isDm || this.audienceFor(message) !== 'private') {
      return reply('Send /mcp login to me in a direct message.');
    }

    const parts = text.split(/\s+/);
    const sub = (parts[1] ?? '').toLowerCase();

    if (sub === 'cancel') {
      const flow = this.mcpFlows.get(laneKey);
      if (!flow) return reply('No sign-in is waiting.');
      flow.port.cancel(flow.flowId); // the settlement callback answers
      return;
    }

    if (sub === 'code') {
      const flow = this.mcpFlows.get(laneKey);
      if (!flow) return reply('No sign-in is waiting. Send /mcp login <server> first.');
      // Pasted text is passed through and never echoed back.
      const pasted = parts.slice(2).join(' ');
      const done = await flow.port.completePaste(flow.flowId, pasted);
      // Success: the settlement callback answers.
      if (!done.ok) {
        await reply(
          `✗ That address was not accepted (${done.code}). Paste it again, or send /mcp cancel.`,
        );
      }
      return;
    }

    const serverName = parts[2];
    if (sub !== 'login' || !serverName) {
      return reply('Usage: /mcp login <server> · /mcp code <address> · /mcp cancel');
    }
    if (!port.isAttached(serverName, personalityId)) {
      return reply(
        `'${serverName}' is not attached to ${personalityId}. Attach it first: ethos personality mcp ${personalityId} --attach ${serverName}.`,
      );
    }

    // One flow per lane: a second start would orphan the first (unreachable by /mcp cancel).
    if (this.mcpFlows.has(laneKey)) {
      return reply('A sign-in is already waiting. Send /mcp cancel first.');
    }
    const started = await port.start({ serverName, personalityId });
    if (started.kind === 'refused') {
      return reply(
        `✗ Could not start sign-in for ${serverName}: ${started.code}.${started.detail ? ` ${started.detail}` : ''}`,
      );
    }
    this.mcpFlows.set(laneKey, { flowId: started.flowId, port });
    port.onSettled(started.flowId, (s) => {
      if (this.mcpFlows.get(laneKey)?.flowId === started.flowId) this.mcpFlows.delete(laneKey);
      void reply(mcpSettlementText(s.status, serverName, personalityId));
    });
    const minutes = Math.max(1, Math.round((started.expiresAt - Date.now()) / 60_000));
    const tail = `Expires in ${minutes} min. If you did not just send /mcp login, ignore this message.`;
    if (started.kind === 'device') {
      await reply(
        `Sign in to ${serverName} for personality "${personalityId}"\n` +
          `Server: ${started.serverHost} · Authorization: ${started.authHost}\n` +
          `Open ${started.verificationUri} and enter ${started.userCode}\n${tail}`,
      );
    } else {
      await reply(
        `Sign in to ${serverName} for personality "${personalityId}"\n` +
          `Server: ${started.serverHost} · Authorization: ${started.authHost}\n` +
          `Open ${started.authorizeUrl}\nThen send: /mcp code <the address your browser ended on>\n${tail}`,
      );
    }
  }

  /** An untracked, dedup-gated send for `/mcp` replies (D17). Not held by quiet hours or `/mute`. */
  private async sendMcpReply(
    adapter: PlatformAdapter,
    chatId: string,
    threadId: string | undefined,
    laneKey: string,
    body: string,
  ): Promise<void> {
    if (!this.outboundDedup.shouldSend(laneKey, body)) return;
    await adapter.send(chatId, { text: body, threadId }).catch(() => {});
  }

  /** Whether the sender is `channel_filter.<platform>.ownerUserId`. False
   *  when the platform has no owner configured. See `senderIsOwner`. */
  private isOwner(message: InboundMessage): boolean {
    return senderIsOwner(message, this.channelFilter?.[message.platform]?.ownerUserId);
  }

  /**
   * One `channel.pairing` audit row: `issued` when the channel filter answers an
   * unknown DM sender with a pairing code (`checkMessage`'s `pairing_reply`), or
   * a failed `/allow` redemption — `not_owner`, or `consumeAndAllow`'s reason
   * (`not_found` | `consumed` | `expired` | `sender_mismatch` | `owner_paused`,
   * the last being the brute-force pause). `senderId` is whoever sent THIS
   * message: the requester for `issued`, the redeemer otherwise. The pairing
   * code is never recorded — it is a bearer credential until it expires. An
   * approval is `channel.allow` (`channel.pairing.approved`), not this.
   */
  private recordPairing(message: InboundMessage, outcome: string, codePlatform?: string): void {
    this.observability?.recordChannelPairing?.({
      code: outcome === 'issued' ? 'channel.pairing.issued' : 'channel.pairing.redeem_failed',
      details: {
        platform: message.platform,
        botKey: message.botKey ?? this.defaultBotKey ?? '',
        senderId: message.userId ?? '',
        outcome,
        ...(codePlatform ? { codePlatform } : {}),
      },
    });
  }

  /**
   * Who bot `botKey` speaks as in one chat of `platform` (plan
   * personality-presence-and-initiative §3): the personality bound to that
   * lane — after any `/personality` switch — and its `display.emoji`. Read by
   * the adapters' receipt reaction and mention-by-name through the resolver
   * {@link bindPresence} hands them. `undefined` for a bot this gateway does
   * not route.
   */
  presenceFor(
    botKey: string,
    platform: string,
    chatId: string,
    threadId?: string,
  ): ChannelPresence | undefined {
    const bot = this.bots.get(botKey);
    if (!bot) return undefined;
    const laneKey = laneKeyOf(platform, botKey, chatId, threadId);
    return this.presenceOf(this.turnPersonalityFor(laneKey, bot), bot);
  }

  /**
   * The personality a turn on `laneKey` RUNS as (`runTurn`) — and therefore
   * the one every presence surface names (`presenceFor`, the reply prefix, the
   * hook-claimed reply). `undefined` for a team bot. Unlike
   * {@link activePersonalityFor} it honours a stored lane override whether or
   * not the bot allows `/personality` now: `restoreLaneSessions` and a branch
   * switch write overrides without that check, and the loop runs them.
   * Pinned by the 'names the personality the turn runs as' case in
   * `__tests__/reply-prefix.test.ts`.
   */
  private turnPersonalityFor(laneKey: string, bot: GatewayBotConfig): string | undefined {
    if (bot.binding.type === 'team') return undefined;
    return this.personalityIds.get(laneKey) ?? bot.binding.name;
  }

  /** The presence of `personalityId` on `bot` — a team bot speaks as its
   *  team's name; a personality without a directory identity as its id. */
  private presenceOf(personalityId: string | undefined, bot: GatewayBotConfig): ChannelPresence {
    if (personalityId === undefined) return { name: bot.binding.name };
    return this.personalityDirectory?.identity?.(personalityId) ?? { name: personalityId };
  }

  /**
   * Hand `adapter` a presence resolver for its own bot, when it asks for one.
   * A structural `setPresenceResolver` read — deliberately NOT a
   * `PlatformAdapter` contract field, the same shape as
   * `postsThinkingPlaceholder`. Called for every adapter the constructor seeds
   * and for every hot-added one (`addAdapter`), so the two paths cannot drift.
   */
  private bindPresence(adapter: PlatformAdapter, botKey: string): void {
    const bindable = adapter as PlatformAdapter & {
      setPresenceResolver?: (resolve: ChannelPresenceResolver) => void;
    };
    if (typeof bindable.setPresenceResolver !== 'function') return;
    const platform = platformOfAdapterId(adapter.id);
    bindable.setPresenceResolver((chatId, threadId) =>
      this.presenceFor(botKey, platform, chatId, threadId),
    );
  }

  /** The personality identifier surfaced by `/personality` (no arg) and
   *  `/help` for a given lane. Honors the per-lane override only when
   *  the bot permits slash-switching. */
  private activePersonalityFor(laneKey: string, bot: GatewayBotConfig): string {
    if (this.personalitySwitchAllowed(bot)) {
      const override = this.personalityIds.get(laneKey);
      if (override) return override;
    }
    return bot.binding.name;
  }

  sendVia(botKey: string, chatId: string, body: string): Promise<{ ok: boolean; error?: string }> {
    return this.outbound.sendVia(botKey, chatId, body);
  }

  /**
   * Run the ambient channel digest over every watched lane this process serves
   * (plan R9/R10). The `channel-digest` system cron task's whole body.
   *
   * It lives on the Gateway because every input it needs is gateway-private:
   * the transcript store, the per-bot loops, the botKey-keyed adapters and the
   * owner declared in `channel_filter`. The job itself is a pure function in
   * `./channel-digest` — this is the wiring, not the logic.
   */
  async runChannelDigest(settings: ChannelDigestSettings = {}): Promise<ChannelDigestReport> {
    return runChannelDigest(
      {
        transcript: this.channelTranscript,
        bots: [...this.bots.values()].map((b) => ({ botKey: b.botKey, loop: b.loop })),
        ownerChatId: (platform) => this.channelFilter?.[platform]?.ownerUserId,
        sendVia: (botKey, chatId, text) => this.sendVia(botKey, chatId, text),
        // Where the per-lane watermarks live. Without both halves the digest
        // falls back to a fixed look-back and re-reads what it already sent.
        ...(this.storage && this.dataDir
          ? {
              watermarks: {
                storage: this.storage,
                path: `${this.dataDir}/${CHANNEL_DIGEST_WATERMARK_FILE}`,
              },
            }
          : {}),
        // The run lock. Keyed on `dataDir` ALONE, not on `storage` as well:
        // two processes sharing a `~/.ethos` must serialise even if one of
        // them has no watermark file to protect, because both still deliver.
        ...(this.dataDir ? { lock: { path: `${this.dataDir}/${CHANNEL_DIGEST_LOCK_FILE}` } } : {}),
        // `channelDigestFeed`, not `notificationRouter` — see the field's doc
        // on GatewayConfig. The sink answers with a RECIPIENT COUNT, and only a
        // non-zero one is delivery: "the call returned" is what the router
        // already said for a digest that reached nothing, and an in-app feed
        // with no browser session connected says exactly the same thing. Under
        // `deliverTo: 'inApp'` that answer is what the consumption cursor
        // advances on, so a zero here has to leave it alone.
        ...(this.channelDigestFeed
          ? {
              notify: async (entry: {
                laneKey: string;
                platform: string;
                chatId: string;
                botKey: string;
                text: string;
              }): Promise<{ ok: boolean; error?: string }> => {
                try {
                  const result = await this.channelDigestFeed?.(entry);
                  const recipients = result?.recipients ?? 0;
                  if (recipients > 0) return { ok: true };
                  return {
                    ok: false,
                    error:
                      'the in-app notifications feed reached 0 listeners — no session was ' +
                      'connected when the digest ran',
                  };
                } catch (err) {
                  return { ok: false, error: err instanceof Error ? err.message : String(err) };
                }
              },
            }
          : {}),
        ...(this.observability ? { observability: this.observability } : {}),
        backgroundGate: (lane) =>
          this.backgroundGate({ kind: 'channel_digest', attribution: lane }),
      },
      settings,
    );
  }

  /** @see OutboundSend.sendTo in ./outbound-send.ts */
  sendTo(
    platform: string,
    target: string,
    body: string,
    media?: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.outbound.sendTo(platform, target, body, media);
  }

  sendAsBot(
    platform: string,
    target: string,
    body: string,
    botKey?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.outbound.sendAsBot(platform, target, body, botKey);
  }

  restoreLaneSessions(): Promise<void> {
    return this.laneManager.restoreLaneSessions();
  }

  private restoreBotLaneSessions(botKey: string): Promise<void> {
    return this.laneManager.restoreBotLaneSessions(botKey);
  }

  private rotateLaneSession(laneKey: string, previous: string): void {
    this.laneManager.rotateLaneSession(laneKey, previous);
  }

  /**
   * D13 — `/incognito` is refused wherever the audience is not one person who
   * owns the memory: any non-DM (group, including a `private_chats`-listed
   * one), a DM the adapter hinted shared, a room judged shared
   * (`audienceFor`), and a non-owner DM (`withholdsPersonalityMemory`). Each
   * term fails closed on its own. Pinned by `__tests__/memory-boundary-e2e.test.ts`
   * ('incognito DM' refusals).
   */
  private incognitoRefused(message: InboundMessage): boolean {
    return (
      !message.isDm ||
      message.audienceHint === 'shared' ||
      this.audienceFor(message) === 'shared' ||
      this.withholdsPersonalityMemory(message)
    );
  }

  /**
   * After `lane.abort()`: wait for the aborted turn to unwind (lane idle, no
   * active turn), bounded by {@link ABORT_GRACE_MS}. `abort()` only raises a
   * signal, so a scrub run straight after it races the turn's last writes
   * (partial assistant message, title, context events). On timeout the caller
   * scrubs anyway and this records `gateway.incognito_abort_unsettled`; the 24 h
   * sweep is the backstop. Pinned by `__tests__/incognito-surfaces.test.ts`.
   */
  private async settleAbortedLane(laneKey: string, lane: SessionLane): Promise<void> {
    const busy = (): boolean => lane.length > 0 || this.activeTurns.has(laneKey);
    if (!busy()) return;
    const settled = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.drainWaiters.delete(check);
        resolve(false);
      }, ABORT_GRACE_MS);
      timer.unref?.();
      const check = (): void => {
        if (busy()) return;
        this.drainWaiters.delete(check);
        clearTimeout(timer);
        resolve(true);
      };
      this.drainWaiters.add(check);
    });
    if (!settled) {
      this.observability?.recordSafetyBlock({
        code: 'gateway.incognito_abort_unsettled',
        cause: 'aborted incognito turn still running at scrub time — the 24 h scrub clears it',
        details: { laneKey },
      });
    }
  }

  /**
   * Scrub the incognito session a lane just left. Fail-open (D8): a failure is
   * recorded as `gateway.incognito_scrub_failed` and `/new` still starts the new
   * session; the 24 h `olderThan` scrub is the backstop. Returns whether it ran.
   */
  private async scrubEndedIncognito(laneKey: string, previousSession: string): Promise<boolean> {
    try {
      const store = this.sessionStoreFor?.();
      if (!store?.scrubIncognito) throw new Error('session store has no scrubIncognito');
      await store.scrubIncognito({ sessionKey: previousSession });
      return true;
    } catch (err) {
      this.observability?.recordSafetyBlock({
        code: 'gateway.incognito_scrub_failed',
        cause: 'incognito history not cleared on /new — the 24 h scrub clears it',
        details: {
          laneKey,
          sessionKey: previousSession,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return false;
    }
  }

  private persistLaneSessions(laneKey: string): Promise<void> {
    return this.laneManager.persistLaneSessions(laneKey);
  }

  private spentToday(bot: GatewayBotConfig, platform: string): Promise<BotSpend | null> {
    return this.spend.spentToday(bot, platform);
  }

  private addDailySpend(bot: GatewayBotConfig, platform: string, usd: number): void {
    this.spend.addDailySpend(bot, platform, usd);
  }

  private dailyCapReached(
    bot: GatewayBotConfig,
    platform: string,
  ): Promise<{ spentUsd: number; capUsd: number } | null> {
    return this.spend.dailyCapReached(bot, platform);
  }

  backgroundGate(request: UsageGateRequest): Promise<UsageGateVerdict> {
    return this.spend.backgroundGate(request);
  }

  /**
   * `/fork`, `/branches`, `/branch <n>`. Forking goes through `forkSession`
   * and listing through `listBranches` (packages/core/src/session-fork.ts), so
   * the numbers match the CLI's. A fork or switch reuses `/new`'s lane switch —
   * abort the lane, clear the previous session's outbound dedup, move
   * `sessionKeys`, persist — but keeps the previous session's cached
   * attachments, because that session is still a branch the user can return to.
   */
  private async handleBranchCommand(
    command: 'fork' | 'branches' | 'branch',
    text: string,
    laneKey: string,
    lane: SessionLane,
    bot: GatewayBotConfig,
    message: InboundMessage,
    adapter: PlatformAdapter,
    threadId: string | undefined,
  ): Promise<void> {
    const reply = async (body: string): Promise<void> => {
      await adapter.send(message.chatId, { text: body, threadId }).catch(() => {});
    };
    const store = this.sessionStoreFor?.();
    if (!store) {
      await reply('Session branches are not available on this gateway.');
      return;
    }
    const moveTo = async (sessionKey: string, personalityId: string | undefined) => {
      lane.abort();
      this.outboundDedup.clearSession(this.sessionKeys.get(laneKey) ?? laneKey);
      this.sessionKeys.set(laneKey, sessionKey);
      if (personalityId === bot.binding.name) this.personalityIds.delete(laneKey);
      else if (personalityId) this.personalityIds.set(laneKey, personalityId);
      this.usageStore.delete(laneKey);
      await this.persistLaneSessions(laneKey);
    };
    try {
      const current = await store.getSessionByKey(this.sessionKeys.get(laneKey) ?? laneKey);
      if (!current) {
        await reply('Nothing to branch yet — send a message first.');
        return;
      }
      if (command === 'fork') {
        const { session } = await forkSession(store, current.id, {
          key: forkSessionKey(laneKey),
        });
        await moveTo(session.key, session.personalityId);
        await reply('✓ Forked — now on a new branch. /branches lists them, /branch <n> switches.');
        return;
      }
      const branches = await listBranches(store, current.id);
      if (command === 'branches') {
        await reply(formatBranchList(branches, current.id));
        return;
      }
      const picked = pickBranch(text.split(/\s+/).slice(1).join(' '), branches);
      if (!picked.ok) {
        await reply(picked.message);
        return;
      }
      if (picked.session.id === current.id) {
        await reply(`Already on branch ${picked.n}.`);
        return;
      }
      // Fail closed: the lane's incognito flag would follow the switch and the
      // next turn would stamp a normal branch incognito (then `/new` wipes it).
      if (this.incognitoLanes.has(laneKey) && !isIncognitoSession(picked.session)) {
        await reply(NOT_INCOGNITO_BRANCH_TEXT);
        return;
      }
      await moveTo(picked.session.key, picked.session.personalityId);
      await reply(`✓ Switched to branch ${picked.n}.`);
    } catch (err) {
      await reply(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getOrCreateLane(key: string): SessionLane {
    return this.laneManager.getOrCreateLane(key);
  }
}
