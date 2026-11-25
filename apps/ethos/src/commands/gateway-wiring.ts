// `ethos gateway start` — the pieces `buildGateway` is assembled from that
// need no pinned import: the turn-origin lookup, the idle-bot loop options,
// `BuildGatewayOptions`, the lazy observability sink, the adapter inbound
// callback and the quiet-hours resolution. Split out of gateway.ts, which
// re-exports them. `buildGateway` itself stays there: archcheck pins its
// `Gateway` / `privateChatSetFrom` value imports to that file's path.

import {
  type EthosConfig,
  hostTimeZone,
  type NotificationsConfig,
  parseQuietHoursSpec,
} from '@ethosagent/config';
import type { AgentLoop } from '@ethosagent/core';
import type {
  Gateway,
  GatewayBotConfig,
  GatewayConfig,
  GatewayObservability,
  GatewayQuietHours,
  RoomPolicyTable,
} from '@ethosagent/gateway';
import type {
  InboundMessage,
  NotificationRouter,
  PlatformAdapter,
  UsageGate,
} from '@ethosagent/types';
import { type createAgentLoop, getEthosObservability } from '../wiring';

/** The shape `createAgentLoop` returns — used to type the collaborators the
 *  extracted builders below receive already-constructed. */
type AgentLoopBuild = Awaited<ReturnType<typeof createAgentLoop>>;

/**
 * The botKey of the one bot an idle gateway (no platform bot configured) runs
 * on — the same `'default'` the Gateway's legacy `loop` shorthand synthesized.
 * Plugin adapters and the like reach it through the single-bot fallback
 * (`Gateway.routedBotKey`).
 */
export const IDLE_GATEWAY_BOT_KEY = 'default';

/**
 * `createAgentLoop` options that make a host's system loop the idle bot's
 * loop, the way `assembleGatewayBots` gives every configured bot its own:
 * `originBotKey` so a `delegate_task(background: true)` job started from one
 * of its turns records WHICH bot announces it (without it the job has no
 * origin bot, nothing subscribes to its completion and the restart sweep
 * `Gateway.sweepUndeliveredJobs` never lists it), and the thread resolver so
 * the notice returns to the sub-conversation. Only gateway turns carry a
 * `platform:chatId` origin, so cron, web and ACP turns on the same loop still
 * record no origin bot (`splitFirstColon` in extensions/tools-delegation).
 * Both `ethos gateway start` and `ethos boot` pass these when no bot is
 * configured; pinned by apps/ethos/src/__tests__/idle-gateway-bot.test.ts.
 */
export function idleGatewayBotLoopOpts(
  origin: GatewayTurnOrigin,
): { originBotKey: string } & GatewayTurnOrigin {
  return { originBotKey: IDLE_GATEWAY_BOT_KEY, ...origin };
}

/**
 * The per-turn origin lookups only the gateway can answer (`ToolContext`
 * carries neither a thread nor a sender), handed to every loop a gateway host
 * builds so a `delegate_task(background: true)` job records the thread its
 * completion returns to and the user its clarify binds to
 * (`BackgroundToolDeps` in extensions/tools-delegation). Late-bound: the
 * gateway is constructed after its loops.
 */
export interface GatewayTurnOrigin {
  resolveOriginThreadId: (sessionKey: string) => string | undefined;
  resolveOriginUserId: (sessionKey: string) => string | undefined;
  /**
   * The bot daily cap's background gate (`Gateway.backgroundGate`, plan
   * background-usage-accounting D39), handed to the loop's usage meter. Rides
   * here because every loop a gateway host builds already takes this object,
   * late-bound. `allow` before the Gateway exists.
   */
  backgroundGate: UsageGate;
}

export function gatewayTurnOrigin(gateway: () => Gateway | null): GatewayTurnOrigin {
  return {
    resolveOriginThreadId: (sessionKey) => gateway()?.originThreadIdFor(sessionKey),
    resolveOriginUserId: (sessionKey) => gateway()?.originUserIdFor(sessionKey),
    backgroundGate: async (request) =>
      (await gateway()?.backgroundGate(request)) ?? { decision: 'allow' },
  };
}

/**
 * The idle gateway's one bot: the host's system loop, bound to the default
 * personality with `/personality` switching allowed (what the legacy `loop`
 * shorthand gave it), plus that loop's job store and background executor so
 * its background jobs announce through the normal tracked path
 * (`Gateway.deliverCompletion` / `WakeReviews.claimWake` in extensions/gateway/src/wake-review.ts, resolved by `adapterForBot`).
 */
export function idleGatewayBot(
  loop: AgentLoop,
  personality: string | undefined,
  jobs: Pick<GatewayBotConfig, 'jobStore' | 'backgroundExecutor' | 'jobControl'> | undefined,
): GatewayBotConfig {
  return {
    botKey: IDLE_GATEWAY_BOT_KEY,
    loop,
    binding: { type: 'personality', name: personality ?? 'default', allowSlashSwitch: true },
    ...(jobs?.jobStore ? { jobStore: jobs.jobStore } : {}),
    ...(jobs?.backgroundExecutor ? { backgroundExecutor: jobs.backgroundExecutor } : {}),
    ...(jobs?.jobControl ? { jobControl: jobs.jobControl } : {}),
  };
}

/**
 * Construct the `Gateway` for the gateway role.
 *
 * Extracted verbatim from `runGatewayStart` (plan §3b step 5, "`Gateway` class
 * constructed"). The two-branch shape is preserved exactly: with no bot
 * configured the Gateway is built on the single system loop and skips the
 * bot-only collaborators (attachment cache, clarify correlator, Telegram card
 * / greeting readers); with bots it is built on the routing table.
 */
export interface BuildGatewayOptions {
  config: EthosConfig;
  /** Per-room prompt/policy table from `loadRoomPolicyTable`, built once at boot
   *  (static per process, plan channel-prompts D9). Omitted = no room policies. */
  roomPolicies?: RoomPolicyTable;
  bots: GatewayBotConfig[];
  /** Used only on the no-bot idle path, as the idle bot's loop (`idleGatewayBot`). */
  systemLoop: AgentLoop;
  /** `systemLoop`'s job store and background executor — the idle bot's, as a
   *  configured bot gets its own loop's. Ignored when `bots` is non-empty. */
  idleBotJobs?: Pick<GatewayBotConfig, 'jobStore' | 'backgroundExecutor' | 'jobControl'>;
  /**
   * EVERY adapter this process runs. Both registries the Gateway takes are
   * derived from it by `adapterRegistries` (@ethosagent/gateway): the
   * platform-keyed default for `send_message`, and the botKey-keyed full set
   * that tracked sends resolve through. Taking the list rather than the two
   * maps is deliberate — `ethos gateway start` once passed only the first map,
   * and every later same-platform bot lost its tracked sends
   * (`__tests__/gateway-bot-adapters.test.ts`).
   */
  adapters: readonly PlatformAdapter[];
  deliveryLedger: GatewayConfig['deliveryLedger'];
  /** U11 — where notices wait out quiet hours / a `/mute`. Absent → none held. */
  heldNotices?: GatewayConfig['heldNotices'];
  inboundDedup: GatewayConfig['inboundDedup'];
  /** Opened by `ethos gateway start` and `ethos boot` — the two commands that
   *  hold the gateway lock (`openInboundSpool`, ../lib/gateway-inbound-durability).
   *  Optional for tests and hosts that own no adapters. */
  inboundSpool?: GatewayConfig['inboundSpool'];
  inboundSpoolOptions?: GatewayConfig['inboundSpoolOptions'];
  resolveUserId: GatewayConfig['resolveUserId'];
  /** `GatewayConfig['pluginLoader']` is narrower than what `createAgentLoop`
   *  returns — `pluginAdapters` is derived here via `getPlatformAdapters()`,
   *  which that narrower shape does not declare. */
  pluginLoader: AgentLoopBuild['pluginLoader'];
  trustedChannelPlugins: GatewayConfig['trustedChannelPlugins'];
  notificationRouter: NotificationRouter;
  storage: GatewayConfig['storage'];
  attachmentCache: NonNullable<GatewayConfig['attachmentCache']>;
  sttProviders: GatewayConfig['sttProviderRegistry'];
  ttsProviders: GatewayConfig['ttsProviderRegistry'];
  voiceConfig: AgentLoopBuild['voiceConfig'];
  voiceModeStore: GatewayConfig['voiceModeStore'];
  voiceArtifacts: GatewayConfig['voiceArtifacts'];
  transcoder: GatewayConfig['transcoder'];
  channelVoiceOut: GatewayConfig['channelVoiceOut'];
  voiceBitrateKbps: GatewayConfig['voiceBitrateKbps'];
  personalityDirectory: GatewayConfig['personalityDirectory'];
  onTurnComplete: GatewayConfig['onTurnComplete'];
  onUserTurn: GatewayConfig['onUserTurn'];
  streamingEdits: GatewayConfig['streamingEdits'];
  pairingDb: GatewayConfig['pairingDb'];
  /** Observe-mode transcript sink. Build it with `openChannelTranscriptStore`. */
  channelTranscript: GatewayConfig['channelTranscript'];
  /**
   * The channel digest's in-app feed. Optional because only `ethos boot` has
   * one — see `channelDigestFeed` in `./boot-digest` and the field's doc on
   * `GatewayConfig`.
   */
  channelDigestFeed?: GatewayConfig['channelDigestFeed'];
  clarifyMessageCorrelator: GatewayConfig['clarifyMessageCorrelator'];
  personalityCardReader: GatewayConfig['personalityCardReader'];
  greetingProvider: GatewayConfig['greetingProvider'];
  /**
   * "Does bot `botKey` still speak for `personalityId`?" — the binding re-check
   * `Gateway.deliverPublication` runs before it publishes an approved outbox
   * item (O-T5). Build it with `buildBotSpeakers(config).speaksFor`.
   *
   * Required, not optional: `deliverPublication` refuses EVERY publication
   * when it is absent, so leaving it unwired is a deployment that queues
   * approvals nobody can deliver.
   */
  publicationSpeaksFor: NonNullable<GatewayConfig['publicationSpeaksFor']>;
  /**
   * Where every `gateway.*` event is recorded — safety blocks, channel
   * allow/deny, injection flags, and the inbound spool's `gateway.spool_*`
   * events. Build it with `gatewayObservability()`.
   *
   * Required, not optional, for the same reason as `publicationSpeaksFor`: the
   * Gateway records through `this.observability?.…`, so leaving it out is not
   * an error anywhere — every event just goes nowhere, which is what both
   * production hosts did until this field existed
   * (`__tests__/gateway-observability-wiring.test.ts`).
   */
  observability: GatewayConfig['observability'];
}

/**
 * The Gateway's observability sink for a production host: the process-wide
 * `EthosObservability` (`getEthosObservability`, ../wiring), resolved on EVERY
 * call rather than captured once.
 *
 * Lazy because `closeObservabilityStore` drops the singleton at the end of
 * shutdown; a straggler event after that reopens a fresh handle instead of
 * writing to a closed one — the same idiom as the
 * `recordSafetyBlock: (opts) => getEthosObservability().recordSafetyBlock(opts)`
 * closures elsewhere in this file. The Gateway only borrows the sink: it never
 * closes it, and the host's shutdown still closes the store last.
 *
 * Fail-open: a store that cannot be opened, or a record that throws, is
 * swallowed here, so observability can never stop the gateway handling a
 * message. The Gateway calls these inline on its hot paths with no guard of
 * its own. Pinned by `__tests__/gateway-observability-wiring.test.ts`.
 */
export function gatewayObservability(
  get: () => GatewayObservability = getEthosObservability,
): GatewayObservability {
  const record = (fn: (sink: GatewayObservability) => void): void => {
    try {
      fn(get());
    } catch {
      // Fail-open — see the doc comment above.
    }
  };
  return {
    recordSafetyBlock: (opts) => record((sink) => sink.recordSafetyBlock(opts)),
    recordInjectionFlag: (opts) => record((sink) => sink.recordInjectionFlag?.(opts)),
    recordChannelAllow: (opts) => record((sink) => sink.recordChannelAllow(opts)),
    recordChannelDeny: (opts) => record((sink) => sink.recordChannelDeny(opts)),
    recordChannelPairing: (opts) => record((sink) => sink.recordChannelPairing?.(opts)),
  };
}

/**
 * Route one adapter's inbound messages into the gateway, spool first.
 *
 * `acceptInbound` runs synchronously INSIDE the adapter's callback, before it
 * returns. In webhook mode the adapter calls that callback from inside the
 * platform framework's request handler (grammy's `webhookCallback`, Bolt's
 * `HTTPReceiver`), which writes its 200 only after the handler returns — so the
 * spool row is on disk before the platform is acknowledged, and the platform
 * retries only messages that were never spooled (plan reach-and-containment
 * §2.5, D2-10). Pinned by `__tests__/platform-webhook-ack-order.test.ts`.
 * A media message whose download the adapter awaits before calling back is the
 * exception: the framework has already acked it (adapter-side, unchanged).
 */
export function wireAdapterInbound(gateway: Gateway, adapter: PlatformAdapter): void {
  adapter.onMessage((message: InboundMessage) => {
    const accepted = gateway.acceptInbound(message);
    void gateway.handleMessage(message, adapter, { accepted }).catch((err) => {
      console.error(`[gateway:${adapter.id}] Error:`, err);
    });
  });
}

/**
 * U11 — `notifications.*` → the gateway's quiet hours, with the time zone made
 * explicit (`notifications.timezone`, else the host's zone). A per-bot `off`
 * becomes `null`, which turns the window off for that bot. Undefined when no
 * window is configured anywhere.
 */
export function resolveGatewayQuietHours(
  notifications: NotificationsConfig | undefined,
): GatewayQuietHours | undefined {
  if (!notifications) return undefined;
  const window = notifications.quietHours
    ? (parseQuietHoursSpec(notifications.quietHours) ?? undefined)
    : undefined;
  const byBot: NonNullable<GatewayQuietHours['byBot']> = {};
  for (const [botKey, entry] of Object.entries(notifications.bots ?? {})) {
    if (entry.quietHours === 'off') byBot[botKey] = null;
    else {
      const parsed = parseQuietHoursSpec(entry.quietHours);
      if (parsed) byBot[botKey] = parsed;
    }
  }
  const hasByBot = Object.keys(byBot).length > 0;
  if (!window && !hasByBot) return undefined;
  return {
    timeZone: notifications.timezone ?? hostTimeZone(),
    ...(window ? { window } : {}),
    ...(hasByBot ? { byBot } : {}),
  };
}
