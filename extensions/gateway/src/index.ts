import { BackgroundRunner } from '@ethosagent/agent-bridge';
import type { AgentLoop } from '@ethosagent/core';
import { stripAnsiEscapes } from '@ethosagent/core';
import type { ChannelFilterConfig } from '@ethosagent/safety-channel';
import {
  checkMessage,
  consumeAndAllow,
  getApprovedSenders,
  isSenderAllowed,
  revokeApproval,
} from '@ethosagent/safety-channel';
import { shortPatternCheck, wrapUntrusted } from '@ethosagent/safety-injection';
import { redactPii } from '@ethosagent/safety-redact';
import type {
  AttachmentCache,
  ClarifyResponse,
  InboundMessage,
  PlatformAdapter,
  SteerSink,
} from '@ethosagent/types';
import type Database from 'better-sqlite3';
import { MessageDedupCache } from './dedup';

export { MessageDedupCache } from './dedup';
export { DreamExecutor } from './dream-executor';

/**
 * Minimal observability surface the gateway needs. Defined locally so this
 * package depends only on `@ethosagent/types` + `@ethosagent/core`'s AgentLoop;
 * any adapter exposing this method shape (e.g. wiring's GatewayObservability)
 * is a fit.
 */
export interface GatewayObservability {
  recordSafetyBlock(opts: {
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
  recordInjectionFlag?(opts: {
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
  recordChannelAllow(opts: {
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
  recordChannelDeny(opts: {
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
}

// ---------------------------------------------------------------------------
// Lane / session key encoding
// ---------------------------------------------------------------------------

/**
 * Build a lane / session key from its segments. Each segment is
 * URL-encoded so a segment that happens to contain the `:` separator
 * (e.g. a future adapter's `threadId` with a colon) cannot alias two
 * distinct conversations onto the same key.
 *
 * Continuity with pre-encoding session keys is only guaranteed for
 * segments that are themselves URL-safe: platform identifiers
 * (`telegram` / `slack` / ...), the hex-derived default botKey
 * (`deriveBotKey` in `apps/ethos/src/config.ts`), numeric Slack
 * `thread_ts`, and the chat IDs the supported platforms emit. An
 * operator who configures a custom `id:` value containing reserved
 * characters will see their existing SQLite session key change shape
 * once after upgrade and their history orphan — that's the cost of
 * choosing an unusual botKey, not a regression in the common case.
 *
 * Treat the returned string as opaque. The Gateway never decodes it;
 * collisions only matter at construction time, and the encoder is the
 * single point of truth for what a lane key looks like.
 */
function buildLaneKey(...segments: string[]): string {
  return segments.map(encodeURIComponent).join(':');
}

// ---------------------------------------------------------------------------
// SessionLane — serialises concurrent messages for the same chat
// ---------------------------------------------------------------------------

interface LaneTask {
  run: (signal: AbortSignal) => Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class SessionLane {
  private readonly queue: LaneTask[] = [];
  private processing = false;
  private currentAbort: AbortController | null = null;

  enqueue(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ run: task, resolve, reject });
      void this.drain();
    });
  }

  /** Abort the running task and drop everything queued behind it. */
  abort(): void {
    this.currentAbort?.abort();
    const dropped = this.queue.splice(0);
    for (const item of dropped) {
      item.reject(new Error('aborted'));
    }
  }

  get length(): number {
    return this.queue.length + (this.processing ? 1 : 0);
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      this.currentAbort = new AbortController();
      try {
        await item.run(this.currentAbort.signal);
        item.resolve();
      } catch (err) {
        item.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    this.currentAbort = null;
    this.processing = false;
  }
}

// ---------------------------------------------------------------------------
// Gateway config
// ---------------------------------------------------------------------------

/**
 * Per-bot routing entry. The Gateway maintains one `AgentLoop` per bot;
 * inbound messages carrying `InboundMessage.botKey` route to the entry
 * with the matching `botKey`. Each bot is statically bound to a single
 * destination (a personality or a team's coordinator).
 *
 * `binding.type === 'team'` means the supplied `loop` is the team's
 * coordinator loop (constructed via `createTeamAgentLoop`). The Gateway
 * does not override the personality on team turns — the coordinator's
 * personality is baked into the loop. `binding.type === 'personality'`
 * means the loop is the shared CLI loop and the Gateway passes
 * `binding.name` as the per-turn personality id.
 *
 * `binding.allowSlashSwitch` defaults to false: the `/personality`
 * command is soft-rejected for identity-bound bots so the bot's
 * external identity remains a stable contract with the user.
 */
export interface GatewayBotConfig {
  botKey: string;
  loop: AgentLoop;
  binding: {
    type: 'personality' | 'team';
    name: string;
    allowSlashSwitch?: boolean;
  };
  /** When true, PII (email, phone, card, SSN) is redacted from inbound message
   *  text before it reaches AgentLoop. Default false. */
  piiRedaction?: boolean;
}

export interface GatewayConfig {
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
  /** Maximum concurrent active sessions. Excess sessions are queued per-lane. */
  maxConcurrentSessions?: number;
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
   * the adapter. Defaults to 30s. Set to 0 to disable. The
   * `ETHOS_DEDUP_LEGACY=1` env var is a separate, hard-off switch — see
   * `dedup.ts` and plan/phases/30-robustness.md § 30.4.
   */
  outboundDedupTtlMs?: number;
  /**
   * Send a brief message to the channel whenever a tool call starts, so users
   * can see what the agent is doing mid-turn. Defaults to `true`. Set to
   * `false` (or read from `ETHOS_CHANNEL_TOOL_CALLS=false`) to silence.
   */
  showToolCalls?: boolean;
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
   * Optional attachment cache for cleaning up cached files on session reset
   * (`/new`) and lane eviction. When absent, no cleanup is performed.
   */
  attachmentCache?: AttachmentCache;
  /** Adapter lookup for agent-initiated outbound sends (send_message tool). */
  adapters?: Map<string, PlatformAdapter>;
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
}

// ---------------------------------------------------------------------------
// Built-in gateway slash commands (handled before the AgentLoop sees the text)
// ---------------------------------------------------------------------------

const PLATFORM_COMMANDS: Record<
  string,
  | 'new'
  | 'usage'
  | 'stop'
  | 'help'
  | 'personality'
  | 'allow'
  | 'deny'
  | 'communications'
  | 'start'
  | 'queue'
  | 'background'
> = {
  '/new': 'new',
  '/reset': 'new',
  '/stop': 'stop',
  '/usage': 'usage',
  '/help': 'help',
  '/personality': 'personality',
  '/allow': 'allow',
  '/deny': 'deny',
  '/communications': 'communications',
  '/start': 'start',
  '/queue': 'queue',
  '/background': 'background',
};

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

/**
 * Where an in-flight turn originated — the adapter/chat/thread plus the user
 * who triggered it. The `before_tool_call` approval flow resolves a
 * `sessionId` to this so it can surface a prompt on the right conversation
 * and bind the decision to the rightful approver.
 */
export interface SessionRouting {
  adapter: PlatformAdapter;
  chatId: string;
  threadId?: string;
  /** Platform user id of whoever's message triggered the turn. Absent when
   *  the adapter didn't stamp one — the approval is then left unbound. */
  requesterUserId?: string;
}

export class Gateway {
  /** Bot routing table keyed by `botKey`. */
  private readonly bots: Map<string, GatewayBotConfig>;
  /** The botKey used when `InboundMessage.botKey` is absent (single-bot
   *  deployments). When the config supplies multiple bots, this is null
   *  and a message without `botKey` is treated as an unknown route. */
  private readonly defaultBotKey: string | null;
  private readonly lanes = new Map<string, SessionLane>();
  /** Effective session key per lane (allows /new to fork a fresh session). */
  private readonly sessionKeys = new Map<string, string>();
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
  /** Outbound-message dedup cache. Suppresses `(sessionId, content)` within TTL. */
  private readonly outboundDedup: MessageDedupCache;
  /** Active turns by laneKey — used by graceful shutdown to notify users. */
  private readonly activeTurns = new Map<string, { adapter: PlatformAdapter; chatId: string }>();
  /** Active steer sinks by laneKey — inbound messages during a turn push here. */
  private readonly activeSinks = new Map<string, SteerSink>();
  /** Live status message per lane — edited in place during tool execution. */
  private readonly activeStatusMessages = new Map<
    string,
    {
      messageId: string;
      adapter: PlatformAdapter;
      chatId: string;
      threadId?: string;
    }
  >();
  /**
   * Routing for an in-flight turn, keyed by `sessionKey`. Populated when the
   * turn is enqueued (where `adapter`, `chatId`, and `threadId` are all in
   * scope) and consumed by the `session_start` hook below, which is the only
   * place `sessionId` becomes known. `activeTurns` is keyed by `laneKey` and
   * lacks `threadId`, so it can't serve this — hence a parallel map.
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
  private readonly maxChats: number;
  /** Optional clarify correlator — see GatewayConfig.clarifyMessageCorrelator. */
  private readonly clarifyCorrelator:
    | ((message: InboundMessage) => Promise<ClarifyResponse | null>)
    | undefined;
  /** Live timer running the periodic clarify sweep, cleared on shutdown. */
  private clarifySweepTimer: ReturnType<typeof setInterval> | undefined;
  /** Chapter 1 safety: per-platform sender allowlist + pairing config. */
  private readonly channelFilter: ChannelFilterConfig | undefined;
  /** SQLite DB for pairing codes. */
  private readonly pairingDb: Database.Database | undefined;
  /** Observability adapter for audit events. */
  private readonly observability: GatewayObservability | undefined;
  /** Whether to send a brief channel message on each tool_start event. */
  private readonly showToolCalls: boolean;
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
  /** Optional attachment cache for cleanup on /new and lane eviction. */
  private readonly attachmentCache: AttachmentCache | undefined;
  /** Adapter lookup for agent-initiated outbound sends (send_message tool). */
  private readonly adapterRegistry: Map<string, PlatformAdapter>;
  private readonly resolveUserIdFn:
    | ((platform: string, platformUserId: string, displayLabel?: string) => Promise<string>)
    | undefined;
  private readonly backgroundRunner: BackgroundRunner;
  private readonly pluginLoader: GatewayConfig['pluginLoader'];
  private readonly notificationRouter: GatewayConfig['notificationRouter'];
  private readonly backgroundCallbacks = new Map<
    string,
    { adapter: PlatformAdapter; chatId: string; threadId?: string }
  >();

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

    // Bridge `sessionId → routing`. `session_start` fires inside `loop.run()`
    // (AgentLoop step 2) and is the only hook that carries BOTH `sessionId`
    // and `sessionKey`. We register it on every bot loop so that, by the time
    // any `before_tool_call` approval hook fires later in the same turn, the
    // gateway can resolve the sessionId back to its adapter/chat/thread.
    for (const entry of botEntries) {
      entry.loop.hooks.registerVoid('session_start', async (payload) => {
        const routing = this.sessionRouting.get(payload.sessionKey);
        if (routing) {
          this.approvalRoutes.set(payload.sessionId, routing);
          this.sessionIdByKey.set(payload.sessionKey, payload.sessionId);
        }
      });
    }

    this.dedupWindow = config.dedupWindow ?? 1024;
    this.maxChats = config.maxChats ?? 4096;
    // ttlMs <= 0 disables dedup inside the cache itself (shouldSend always returns true).
    this.outboundDedup = new MessageDedupCache({ ttlMs: config.outboundDedupTtlMs ?? 30_000 });
    this.channelFilter = config.channelFilter;
    this.pairingDb = config.pairingDb;
    this.observability = config.observability;
    this.showToolCalls = config.showToolCalls ?? true;
    this.onAllowlistChange = config.onAllowlistChange;
    this.clarifyCorrelator = config.clarifyMessageCorrelator;
    this.personalityCardReader = config.personalityCardReader;
    this.greetingProvider = config.greetingProvider;
    this.attachmentCache = config.attachmentCache;
    this.adapterRegistry = config.adapters ?? new Map();
    this.resolveUserIdFn = config.resolveUserId;
    this.pluginLoader = config.pluginLoader;
    this.notificationRouter = config.notificationRouter;

    this.backgroundRunner = new BackgroundRunner({ maxConcurrent: 4 });
    this.backgroundRunner.onComplete((task) => {
      const routing = this.backgroundCallbacks.get(task.id);
      if (!routing) return;
      this.backgroundCallbacks.delete(task.id);
      const text =
        task.status === 'done'
          ? `📋 Background task complete:\n${task.result ?? '(no output)'}`
          : `❌ Background task failed: ${task.error ?? 'unknown error'}`;
      void routing.adapter
        .send(routing.chatId, { text, threadId: routing.threadId })
        .catch(() => {});
    });

    // Clarify sweep — fires on a single timer for all bots' bridges so a
    // multi-bot deployment doesn't pile up N timers. Each bridge owns its own
    // expiry logic; we just tick them in parallel.
    const sweepMs = config.clarifySweepIntervalMs ?? 30_000;
    const bridges = botEntries
      .map((b) => b.loop.clarifyBridge)
      .filter((b): b is NonNullable<typeof b> => b !== undefined);
    if (sweepMs > 0 && bridges.length > 0) {
      this.clarifySweepTimer = setInterval(() => {
        void Promise.all(bridges.map((b) => b.sweep())).catch(() => {});
      }, sweepMs);
      // `unref()` lets the process exit when only the sweep timer remains.
      this.clarifySweepTimer.unref?.();
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
  }

  /**
   * Returns true if this message is a duplicate of one seen in the dedup
   * window (and records the key for future drops). Returns false for
   * never-before-seen keys, or when the message has no `messageId` (we can't
   * dedup what isn't keyed).
   *
   * The dedup key is platform-, bot-, chat-, and message-scoped: the same
   * `messageId` arriving through two different bots is two distinct
   * inbounds, not a duplicate. (Without the botKey segment, multi-bot
   * routing would silently drop one of them.)
   */
  private isDuplicate(message: InboundMessage, botKey: string): boolean {
    if (this.dedupWindow <= 0 || !message.messageId) return false;
    const key = buildLaneKey(message.platform, botKey, message.chatId, message.messageId);
    if (this.seenMessages.has(key)) return true;
    this.seenMessages.add(key);
    // Bound the set — drop the oldest entry once we exceed the window.
    if (this.seenMessages.size > this.dedupWindow) {
      const first = this.seenMessages.values().next().value;
      if (first !== undefined) this.seenMessages.delete(first);
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Public API — adapters call this for every inbound message
  // ---------------------------------------------------------------------------

  async handleMessage(message: InboundMessage, adapter: PlatformAdapter): Promise<void> {
    // Drop duplicates BEFORE any work — billing-relevant. See OpenClaw #71761
    // (channel messages injected twice → 2× cost). Use the resolved botKey
    // (message.botKey or the synthesized default) so multi-bot routing
    // doesn't accidentally cross-dedupe. Edited messages (`isEdit: true`)
    // bypass dedup because they intentionally re-use the same `messageId`
    // with different content.
    const dedupBotKey = message.botKey ?? this.defaultBotKey ?? '';
    if (!message.isEdit && this.isDuplicate(message, dedupBotKey)) return;

    // --- Clarify correlator: short-circuit force-reply + `/cancel` ---
    // Runs BEFORE the safety filter's mention gate so an approved sender's
    // force-reply isn't treated as a fresh agent prompt (the agent is
    // already paused inside `clarify()` waiting on this answer). But we
    // still gate on the *allowlist* portion of the safety filter — a
    // non-allowlisted sender in a group chat must NOT be able to resolve
    // the bot's pending clarify (that would be an authentication bypass,
    // not just a routing shortcut).
    if (this.clarifyCorrelator) {
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
            userId: message.userId,
            isDm: message.isDm,
            isGroupMention: message.isGroupMention,
          },
        });
        return;
      }

      if (filterResult.action === 'pairing_reply') {
        await adapter.send(message.chatId, { text: filterResult.reply ?? '' }).catch(() => {});
        return;
      }

      // 'allow' — if context was stripped, use stripped text for the turn
      if (filterResult.strippedText !== undefined) {
        this.observability?.recordSafetyBlock({
          code: 'channel.context_stripped',
          details: {
            platform: message.platform,
            chatId: message.chatId,
            userId: message.userId,
            replyToId: message.replyToId,
          },
        });
        message = { ...message, text: filterResult.strippedText };
      }
    }

    // Resolve which bot this message is for. `message.botKey` wins when
    // adapters populate it; single-bot deployments fall back to the
    // synthesized default. Multi-bot deployments with a missing botKey
    // are a configuration error — log and drop rather than silently
    // route to a wrong personality.
    const botKey = message.botKey ?? this.defaultBotKey ?? '';
    const bot = botKey ? this.bots.get(botKey) : undefined;
    if (!bot) {
      this.observability?.recordSafetyBlock({
        code: 'gateway.unknown_botKey',
        details: { platform: message.platform, chatId: message.chatId, botKey: message.botKey },
      });
      return;
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
    const lane = this.getOrCreateLane(laneKey);
    const rawText = message.text?.trim() ?? '';
    const text = bot.piiRedaction ? redactPii(rawText) : rawText;

    // --- Gateway-level slash command handling ---

    const cmdToken = text.split(/\s+/)[0] ?? '';
    const cmdType = PLATFORM_COMMANDS[cmdToken.toLowerCase()];

    if (cmdType === 'stop') {
      lane.abort();
      await adapter.send(message.chatId, { text: '✓ Stopped.' }).catch(() => {});
      return;
    }

    if (cmdType === 'new') {
      lane.abort();
      const previousSession = this.sessionKeys.get(laneKey) ?? laneKey;
      this.outboundDedup.clearSession(previousSession);
      void this.attachmentCache?.clear(previousSession).catch(() => {});
      const fresh = `${laneKey}:${Date.now()}`;
      this.sessionKeys.set(laneKey, fresh);
      this.usageStore.delete(laneKey);
      this.personalityIds.delete(laneKey); // reset to default personality
      await adapter.send(message.chatId, { text: '✓ New session started.' }).catch(() => {});
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
        `/stop — abort current response\n` +
        `${personalityLines.join('\n')}\n` +
        `/usage — token and cost stats\n` +
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
        })
        .catch(() => {});
      return;
    }

    if (cmdType === 'start') {
      const personalityId = this.activePersonalityFor(laneKey, bot);
      if (this.greetingProvider) {
        const greeting = await this.greetingProvider.greet(personalityId).catch(() => null);
        if (greeting) {
          await adapter.send(message.chatId, { text: greeting }).catch(() => {});
          return;
        }
      }
      await adapter
        .send(message.chatId, {
          text: `Hello! I'm running as *${personalityId}*. Send a message to get started, or try /help for available commands.`,
        })
        .catch(() => {});
      return;
    }

    if (cmdType === 'personality') {
      const arg = text.split(/\s+/).slice(1).join(' ').trim();
      const current = this.activePersonalityFor(laneKey, bot);

      if (!arg) {
        await adapter
          .send(message.chatId, { text: `Current personality: ${current}` })
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
          await adapter.send(message.chatId, { text: card.text }).catch(() => {});
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
          })
          .catch(() => {});
        return;
      }

      if (arg === 'list') {
        await adapter
          .send(message.chatId, {
            text: 'Built-in personalities: researcher · engineer · reviewer · coach · operator\n\nUse /personality <id> to switch.',
          })
          .catch(() => {});
        return;
      }

      // Switch personality — also start a fresh session so the new identity takes effect immediately
      const previousSession = this.sessionKeys.get(laneKey) ?? laneKey;
      this.outboundDedup.clearSession(previousSession);
      void this.attachmentCache?.clear(previousSession).catch(() => {});
      this.personalityIds.set(laneKey, arg);
      const fresh = `${laneKey}:${Date.now()}`;
      this.sessionKeys.set(laneKey, fresh);
      await adapter
        .send(message.chatId, { text: `✓ Switched to ${arg} personality. New session started.` })
        .catch(() => {});
      return;
    }

    if (cmdType === 'usage') {
      const u = this.usageStore.get(laneKey) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      await adapter
        .send(message.chatId, {
          text: `Tokens: ${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out\nCost: $${u.costUsd.toFixed(5)}`,
        })
        .catch(() => {});
      return;
    }

    if (cmdType === 'allow') {
      const code = text.split(/\s+/)[1]?.toUpperCase() ?? '';
      if (!code || !this.pairingDb || !this.channelFilter) {
        await adapter
          .send(message.chatId, { text: '✗ Pairing not configured or no code given.' })
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
        const isOwner =
          codePlatformCfg?.ownerUserId && message.userId === codePlatformCfg.ownerUserId;
        if (!isOwner) {
          await adapter
            .send(message.chatId, { text: '✗ Only the owner may approve pairings.' })
            .catch(() => {});
          return;
        }
      }

      const result = consumeAndAllow(this.pairingDb, code, message.userId);
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
          .send(message.chatId, { text: `✓ ${result.senderId} approved.` })
          .catch(() => {});
      } else if (result.reason === 'owner_paused') {
        await adapter
          .send(message.chatId, { text: '✗ Too many invalid attempts. Pairing paused for 24h.' })
          .catch(() => {});
      } else {
        await adapter.send(message.chatId, { text: '✗ Invalid or expired code.' }).catch(() => {});
      }
      return;
    }

    if (cmdType === 'deny') {
      const targetUserId = text.split(/\s+/)[1] ?? '';
      const cleanTarget = targetUserId.replace(/^@/, '');
      if (!cleanTarget || !this.channelFilter) {
        await adapter.send(message.chatId, { text: '✗ Usage: /deny <userId>' }).catch(() => {});
        return;
      }

      let removed = false;
      for (const [platform, cfg] of Object.entries(this.channelFilter)) {
        // Only the owner can remove senders.
        const isOwner = cfg.ownerUserId && message.userId === cfg.ownerUserId;
        if (!isOwner) continue;

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
        await adapter.send(message.chatId, { text: `✓ ${cleanTarget} removed.` }).catch(() => {});
      } else {
        await adapter
          .send(message.chatId, { text: `✗ ${cleanTarget} not found in any allowlist.` })
          .catch(() => {});
      }
      return;
    }

    if (cmdType === 'communications') {
      if (!this.pairingDb || !this.channelFilter) {
        await adapter.send(message.chatId, { text: 'Pairing not configured.' }).catch(() => {});
        return;
      }

      const platformCfg = this.channelFilter[message.platform];
      const isOwner = platformCfg?.ownerUserId && message.userId === platformCfg.ownerUserId;
      if (!isOwner) {
        await adapter
          .send(message.chatId, { text: '✗ Only the owner may use /communications.' })
          .catch(() => {});
        return;
      }

      const subCmd = text.split(/\s+/)[1]?.toLowerCase();

      if (subCmd === 'approve-all') {
        // Scope to platforms where the caller is the configured owner.
        const ownedPlatforms = new Set(
          Object.entries(this.channelFilter)
            .filter(([, cfg]) => cfg.ownerUserId && message.userId === cfg.ownerUserId)
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
            await this.onAllowlistChange?.(result.platform, result.senderId, 'add');
          }
        }

        await adapter
          .send(message.chatId, { text: `✓ Approved ${approvedCount} sender(s).` })
          .catch(() => {});
        return;
      }

      // Default: list pending codes
      const pending = this.pairingDb
        .prepare(`SELECT code, sender_id, platform FROM pairing_codes WHERE status = 'pending'`)
        .all() as { code: string; sender_id: string; platform: string }[];

      if (pending.length === 0) {
        await adapter
          .send(message.chatId, { text: 'No pending pairing requests.' })
          .catch(() => {});
        return;
      }

      const lines = pending.map((r) => `${r.sender_id} (${r.platform}) — /allow ${r.code}`);
      const reply = `${pending.length} pending pairing request(s):\n${lines.join('\n')}`;
      await adapter.send(message.chatId, { text: reply }).catch(() => {});
      return;
    }

    // --- /background command ---
    if (cmdType === 'background') {
      const bgText = text.slice('/background '.length).trim();
      if (!bgText) {
        await adapter
          .send(message.chatId, { text: '✗ Usage: /background <prompt>' })
          .catch(() => {});
        return;
      }
      const bgSessionKey = `bg:${laneKey}:${Date.now()}`;
      try {
        const task = this.backgroundRunner.run(bgText, bot.loop, bgSessionKey);
        this.backgroundCallbacks.set(task.id, {
          adapter,
          chatId: message.chatId,
          threadId,
        });
        await adapter
          .send(message.chatId, { text: '⏳ Background task started', threadId })
          .catch(() => {});
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === 'BACKGROUND_QUEUE_FULL') {
          await adapter
            .send(message.chatId, {
              text: '⚠ Background queue full (max 4). Wait for a task to finish.',
              threadId,
            })
            .catch(() => {});
        } else {
          throw err;
        }
      }
      return;
    }

    // --- /queue command ---
    if (cmdType === 'queue') {
      const queueText = text.slice('/queue '.length).trim();
      if (!queueText) {
        await adapter.send(message.chatId, { text: '✗ Usage: /queue <message>' }).catch(() => {});
        return;
      }
      if (this.activeSinks.has(laneKey)) {
        void lane.enqueue((signal) =>
          this.runTurn(laneKey, lane, bot, message, adapter, queueText, threadId, signal),
        );
        await adapter
          .send(message.chatId, { text: `✅ queued (position ${lane.length})`, threadId })
          .catch(() => {});
        return;
      }
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

    // --- Auto-steer: if a turn is already running, push into its steer sink ---
    const activeSink = this.activeSinks.get(laneKey);
    if (activeSink) {
      const accepted = activeSink.push(text);
      if (accepted) {
        await adapter.send(message.chatId, { text: '↩ noted', threadId }).catch(() => {});
      }
      return;
    }

    // --- Agent turn ---

    const turnText = cmdType === 'queue' ? text.slice('/queue '.length).trim() : text;
    await lane.enqueue((signal) =>
      this.runTurn(laneKey, lane, bot, message, adapter, turnText, threadId, signal),
    );
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
  ): Promise<void> {
    const sessionKey = this.sessionKeys.get(laneKey) ?? laneKey;
    const personalityId =
      bot.binding.type === 'team'
        ? undefined
        : (this.personalityIds.get(laneKey) ?? bot.binding.name);

    this.activeTurns.set(laneKey, { adapter, chatId: message.chatId });

    if (this.notificationRouter) {
      this.notificationRouter.register(sessionKey, {
        send: async (text: string) => {
          await adapter.send(message.chatId, { text, threadId }).catch(() => {});
        },
        injectUserMessage: async (_msg: string) => {},
      });
    }

    const steerSink = createSteerSink();
    this.activeSinks.set(laneKey, steerSink);

    this.sessionRouting.set(sessionKey, {
      adapter,
      chatId: message.chatId,
      threadId: message.threadId ? message.threadId : undefined,
      requesterUserId: message.userId,
    });

    await adapter.sendTyping?.(message.chatId).catch(() => {});
    const typingTimer = setInterval(() => {
      void adapter.sendTyping?.(message.chatId).catch(() => {});
    }, 4_000);

    try {
      let responseText = '';
      let errored: { error: string; code: string } | null = null;

      const wrapped = wrapUntrusted({ content: text, toolName: 'channel_message' });

      const contextPrefix = message.priorContext
        ? wrapUntrusted({ content: message.priorContext, toolName: 'channel_history' }).content +
          '\n\n---\n\n'
        : '';

      const loopText = contextPrefix ? `${contextPrefix}${wrapped.content}` : wrapped.content;

      const tier1 = shortPatternCheck(text);
      if (tier1.containsInstructions || wrapped.strippedTokens > 0) {
        this.observability?.recordInjectionFlag?.({
          code: 'channel.injection_detected',
          cause: tier1.containsInstructions
            ? (tier1.hits[0]?.rule ?? 'pattern-hit')
            : `stripped ${wrapped.strippedTokens} template token${wrapped.strippedTokens === 1 ? '' : 's'}`,
          details: {
            platform: message.platform,
            chatId: message.chatId,
            userId: message.userId,
            ...(tier1.containsInstructions ? { hits: tier1.hits } : {}),
          },
        });
      }

      const userId =
        message.userId && this.resolveUserIdFn
          ? await this.resolveUserIdFn(message.platform, message.userId, message.username)
          : undefined;

      for await (const event of bot.loop.run(loopText, {
        sessionKey,
        personalityId,
        abortSignal: signal,
        attachments: message.attachments,
        userId,
        steerSink,
      })) {
        if (event.type === 'tool_start' && this.showToolCalls) {
          const status = this.activeStatusMessages.get(laneKey);
          if (status) {
            await status.adapter
              .editMessage?.(status.chatId, status.messageId, `⚙ ${event.toolName}…`)
              .catch(() => {});
          }
        }

        if (event.type === 'tool_end' && this.showToolCalls) {
          const status = this.activeStatusMessages.get(laneKey);
          if (status) {
            const dur = `${(event.durationMs / 1000).toFixed(1)}s`;
            await status.adapter
              .editMessage?.(status.chatId, status.messageId, `⚙ ${event.toolName} ✓ · ${dur}`)
              .catch(() => {});
          }
        }
        if (event.type === 'text_delta') responseText += event.text;
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
        }
        if (event.type === 'error') {
          errored = { error: event.error, code: event.code };
          break;
        }
        if (event.type === 'done') break;
      }

      if (signal.aborted) {
        // /stop or shutdown — caller already notified the user.
      } else if (errored) {
        const errStatus = this.activeStatusMessages.get(laneKey);
        if (errStatus) {
          await errStatus.adapter
            .editMessage?.(errStatus.chatId, errStatus.messageId, '⚠ Stopped')
            .catch(() => {});
        }
        const note =
          responseText.trim().length > 0
            ? `${responseText}\n\n⚠ Response interrupted: ${errored.error}`
            : `⚠ Error: ${errored.error}`;
        const sanitizedNote = stripAnsiEscapes(note);
        if (this.outboundDedup.shouldSend(sessionKey, sanitizedNote)) {
          await adapter.send(message.chatId, { text: sanitizedNote, threadId }).catch(() => {});
        }
      } else if (responseText) {
        const sanitized = stripAnsiEscapes(responseText);
        if (this.outboundDedup.shouldSend(sessionKey, sanitized)) {
          await adapter
            .send(message.chatId, {
              text: sanitized,
              parseMode: 'markdown',
              threadId,
            })
            .catch(() => {});
        }
      }
    } finally {
      clearInterval(typingTimer);
      this.activeTurns.delete(laneKey);
      this.activeSinks.delete(laneKey);

      const status = this.activeStatusMessages.get(laneKey);
      if (status) {
        await status.adapter.editMessage?.(status.chatId, status.messageId, '').catch(() => {});
        this.activeStatusMessages.delete(laneKey);
      }

      this.notificationRouter?.deregister(sessionKey);
      this.sessionRouting.delete(sessionKey);
      const sessionId = this.sessionIdByKey.get(sessionKey);
      if (sessionId !== undefined) {
        this.approvalRoutes.delete(sessionId);
        this.sessionIdByKey.delete(sessionKey);
      }
    }
  }

  /**
   * Resolve a `sessionId` to the adapter/chat/thread its turn originated
   * from — the bridge a `before_tool_call` approval hook needs to surface an
   * approval prompt on the right platform conversation. Returns `undefined`
   * once the turn ends (or if the sessionId was never seen). Platform-
   * agnostic by design: the gateway returns a generic `PlatformAdapter` and
   * never learns which concrete platform is in play.
   */
  resolveApprovalRoute(sessionId: string): SessionRouting | undefined {
    return this.approvalRoutes.get(sessionId);
  }

  /**
   * Stop all active session lanes gracefully. If `notify` is set, send that
   * text to every chat with an in-flight turn before aborting — so users
   * never see silent failure on shutdown / upgrade. See IMPROVEMENT.md P1-1
   * and OpenClaw #71178 (mid-turn update drops every Telegram message).
   */
  async shutdown(opts: { notify?: string } = {}): Promise<void> {
    if (opts.notify) {
      const sends: Promise<unknown>[] = [];
      for (const ctx of this.activeTurns.values()) {
        sends.push(ctx.adapter.send(ctx.chatId, { text: opts.notify }).catch(() => {}));
      }
      await Promise.allSettled(sends);
    }
    if (this.clarifySweepTimer) {
      clearInterval(this.clarifySweepTimer);
      this.clarifySweepTimer = undefined;
    }
    for (const lane of this.lanes.values()) {
      lane.abort();
    }
    this.lanes.clear();
    this.sessionKeys.clear();
    this.activeTurns.clear();
    this.activeStatusMessages.clear();
    this.activeSinks.clear();
    this.sessionRouting.clear();
    this.approvalRoutes.clear();
    this.sessionIdByKey.clear();
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
  // Helpers
  // ---------------------------------------------------------------------------

  /** Whether `/personality` switching is permitted for this lane's bot.
   *  Team bots always reject (coordinator is structural). Personality
   *  bots reject unless `binding.allowSlashSwitch` is on. */
  private personalitySwitchAllowed(bot: GatewayBotConfig): boolean {
    if (bot.binding.type === 'team') return false;
    return bot.binding.allowSlashSwitch === true;
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

  // ---------------------------------------------------------------------------
  // Public API — agent-initiated outbound sends (send_message tool)
  // ---------------------------------------------------------------------------

  async sendTo(
    platform: string,
    target: string,
    body: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const adapter = this.adapterRegistry.get(platform);
    if (!adapter) {
      return { ok: false, error: `No adapter registered for platform "${platform}"` };
    }
    try {
      // Route through outbound dedup — same path as normal responses.
      // Use target as the session key for dedup so repeated sends to the
      // same target with same content are suppressed within TTL.
      const dedupKey = `outbound:${platform}:${target}`;
      if (!this.outboundDedup.shouldSend(dedupKey, body)) {
        return { ok: true }; // silently deduplicated
      }
      const result = await adapter.send(target, { text: body });
      if (!result.ok) {
        return { ok: false, error: result.error ?? 'Adapter send failed' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private getOrCreateLane(key: string): SessionLane {
    const existing = this.lanes.get(key);
    if (existing) {
      // LRU touch: re-insert to push to the tail so eviction skips it.
      this.lanes.delete(key);
      this.lanes.set(key, existing);
      return existing;
    }
    const lane = new SessionLane();
    this.lanes.set(key, lane);
    this.evictIdleChats();
    return lane;
  }

  /**
   * Bound per-chat state at `maxChats`. Walks `lanes` in LRU order (oldest
   * first) and evicts the first idle chat — one whose lane queue is empty
   * and that has no in-flight turn. Active chats are skipped, so a flood of
   * new chats can't drop a user mid-response.
   */
  private evictIdleChats(): void {
    while (this.lanes.size > this.maxChats) {
      let evictedKey: string | null = null;
      for (const [key, lane] of this.lanes) {
        if (lane.length === 0 && !this.activeTurns.has(key)) {
          evictedKey = key;
          break;
        }
      }
      if (evictedKey === null) return; // every chat is busy — leave the cap alone
      const evictedSession = this.sessionKeys.get(evictedKey) ?? evictedKey;
      void this.attachmentCache?.clear(evictedSession).catch(() => {});
      this.lanes.delete(evictedKey);
      this.sessionKeys.delete(evictedKey);
      this.personalityIds.delete(evictedKey);
      this.usageStore.delete(evictedKey);
    }
  }
}

function createSteerSink(cap = 32): SteerSink {
  const queue: string[] = [];
  return {
    push(text: string): boolean {
      if (queue.length >= cap) return false;
      queue.push(text);
      return true;
    },
    drain(): string[] {
      if (queue.length === 0) return [];
      const out = queue.splice(0);
      return out;
    },
    depth(): number {
      return queue.length;
    },
  };
}
