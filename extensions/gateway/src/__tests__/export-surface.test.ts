// Pins the public surface of extensions/gateway/src/index.ts across the
// Context Budget 3 split (Task 2): every runtime export, every type-only export,
// and every `Gateway.*` method name CLAUDE.md and .claude/rules/gateway-*.md cite.
// A moved symbol must stay re-exported; a cited method stays as a delegate.

import type { AgentLoop } from '@ethosagent/core';
import type { PlatformAdapter } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BotSpend,
  CapturingAdapter,
  ChannelDigestBot,
  ChannelDigestDeps,
  ChannelDigestFeedResult,
  ChannelDigestReport,
  ChannelDigestSettings,
  DeliveryBinding,
  DeliveryTargetConfig,
  FfmpegTranscoderOptions,
  GatewayBotConfig,
  GatewayConfig,
  GatewayObservability,
  GatewayQuietHours,
  HandleMessageOptions,
  HeldNotice,
  HeldNoticeStore,
  InboundAcceptance,
  LaneStop,
  McpLoginPort,
  McpLoginSettlement,
  McpLoginStart,
  OutboundMediaCaps,
  OutboundMediaSource,
  PublicationRefusalCode,
  PublicationRequest,
  PublicationResult,
  PublicationSpeaksFor,
  QuietHoursWindow,
  RelayResult,
  SessionRouting,
  StreamAdapter,
  TranscodeRequest,
  TranscodeResult,
  Transcoder,
  TranscodeStageEvent,
  VoiceArtifactStore,
  VoiceArtifactStoreOptions,
} from '../index';
import * as surface from '../index';
import { Gateway } from '../index';
import { stubLoop } from './voice-fakes';

// Type-only exports: a missing one fails `pnpm typecheck` on the import above.
export type TypeOnlySurface = [
  BotSpend,
  CapturingAdapter,
  ChannelDigestBot,
  ChannelDigestDeps,
  ChannelDigestFeedResult,
  ChannelDigestReport,
  ChannelDigestSettings,
  DeliveryBinding,
  DeliveryTargetConfig,
  FfmpegTranscoderOptions,
  GatewayBotConfig,
  GatewayConfig,
  GatewayObservability,
  GatewayQuietHours,
  HandleMessageOptions,
  HeldNotice,
  HeldNoticeStore,
  InboundAcceptance,
  LaneStop,
  McpLoginPort,
  McpLoginSettlement,
  McpLoginStart,
  OutboundMediaCaps,
  OutboundMediaSource,
  PublicationRefusalCode,
  PublicationRequest,
  PublicationResult,
  PublicationSpeaksFor,
  QuietHoursWindow,
  RelayResult,
  SessionRouting,
  StreamAdapter,
  TranscodeRequest,
  TranscodeResult,
  TranscodeStageEvent,
  Transcoder,
  VoiceArtifactStore,
  VoiceArtifactStoreOptions,
];

describe('@ethosagent/gateway export surface', () => {
  it('keeps the runtime export list of src/index.ts unchanged', () => {
    expect(Object.keys(surface).sort()).toEqual([
      'ABSORBED_STEER_ACK',
      'ATTACHMENT_NOT_RECOVERED_NOTE',
      'CHANNEL_EXCLUDED_TOOLS',
      'DraftStreamer',
      'DreamExecutor',
      'EMPTY_REPLY_NOTICE',
      'Gateway',
      'INTERRUPTED_RETRY_NOTICE',
      'LEARN_SHARED_ROOM_REPLY',
      'MAX_MUTE_MS',
      'MessageDedupCache',
      'OUTBOUND_MEDIA_MAX_BYTES',
      'PLATFORM_COMMANDS',
      'RoomTurnPolicies',
      'SessionLane',
      'VOICE_FAILURE_NOTICE',
      'adapterRegistries',
      'attachmentsFromStructured',
      'beginDelivery',
      'buildDigestPrompt',
      'buildRoomPolicyTable',
      'closeUnbalancedMarkup',
      'confirmDelivery',
      'createCapturingAdapter',
      'createFfmpegTranscoder',
      'createVoiceArtifactStore',
      'deadLetteredNotice',
      'decodeDataUrl',
      'endDelivery',
      'formatDigest',
      'inQuietHours',
      'isOutboundMediaSource',
      'minuteOfDay',
      'parseMuteDuration',
      'parseRetryAfterSeconds',
      'queuedTurnAck',
      'quietWindowFor',
      'relayToTargets',
      'renderRoomPrompt',
      'resolveRoomPolicy',
      'roomModeDefault',
      'roomPolicyDigest',
      'roomSelectorFromFile',
      'runChannelDigest',
      'slugRoomName',
      'summarizeChannelDigest',
      'transcriptTimestamp',
    ]);
  });
});

// Every Gateway built here is shut down after its test, so its timers stop.
const built: Gateway[] = [];
afterEach(async () => {
  for (const gw of built.splice(0)) await gw.shutdown();
});

const CITED_METHODS = [
  'acceptInbound',
  'adapterForBot',
  'admitWakeReview',
  'audienceFor',
  'deliverCompletion',
  'foldAbsorbed',
  'linkAbsorbed',
  'localInboundId',
  'markSpoolToolStarted',
  'noticeHoldReason',
  'notifyDeadLettered',
  'pruneVoiceArtifacts',
  'recordRedelivered',
  'releaseParkedReviews',
  'replayInboundSpool',
  'replaySpoolRow',
  'replayable',
  'requeueUnreadSteers',
  'runTurn',
  'sendTo',
  'settleRefusedRedelivery',
  'settleUnreadSteers',
  'shutdown',
  'startDeliverySweep',
  'steerEntryFor',
  'sweepPendingDeliveries',
] as const;

describe('Gateway keeps cited method names', () => {
  it.each(CITED_METHODS)('Gateway.prototype.%s is a method', (name) => {
    const proto = Gateway.prototype as unknown as Record<string, unknown>;
    expect(typeof proto[name]).toBe('function');
  });

  it('inFlightSends is an own field of a constructed Gateway', () => {
    const gw = new Gateway({
      bots: [
        {
          botKey: 'bot-a',
          loop: stubLoop() as AgentLoop,
          binding: { type: 'personality', name: 'default' },
        },
      ],
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
    });
    built.push(gw);
    expect(Object.hasOwn(gw, 'inFlightSends')).toBe(true);
    expect((gw as unknown as Record<string, unknown>).inFlightSends).toBeInstanceOf(Map);
  });
});

// Review focus 1 (Context Budget 3): the collaborators split out of `Gateway`
// own no state. The outbound sends write the in-flight map and the dedup cache
// that live on `Gateway`, so a send started through `sendTo` is visible in
// `gw.inFlightSends` while it runs and the cache `gw.outboundDedup` holds its
// key afterwards — one map, one cache, never a collaborator's private copy.
describe('Gateway collaborators share Gateway-owned state', () => {
  it('a sendTo in flight is registered in Gateway.inFlightSends and recorded in Gateway.outboundDedup', async () => {
    let finish: (r: { ok: boolean }) => void = () => {};
    const adapter = {
      id: 'telegram:bot-a',
      displayName: 'Telegram',
      canSendTyping: false,
      canEditMessage: false,
      canReact: false,
      canSendFiles: false,
      maxMessageLength: 4096,
      async start() {},
      async stop() {},
      send: () =>
        new Promise<{ ok: boolean }>((resolve) => {
          finish = resolve;
        }),
      onMessage() {},
      async health() {
        return { ok: true };
      },
    } as unknown as PlatformAdapter;
    const gw = new Gateway({
      bots: [
        {
          botKey: 'bot-a',
          loop: stubLoop() as AgentLoop,
          binding: { type: 'personality', name: 'default' },
        },
      ],
      adapters: new Map([['telegram', adapter]]),
      botAdapters: new Map([['bot-a', adapter]]),
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
    });
    built.push(gw);
    const own = gw as unknown as {
      inFlightSends: Map<string, unknown>;
      outboundDedup: { wouldSend(sessionId: string, content: string): boolean };
    };
    const sending = gw.sendTo('telegram', '42', 'hello');
    await Promise.resolve();
    expect(own.inFlightSends.size).toBe(1);
    finish({ ok: true });
    await expect(sending).resolves.toEqual({ ok: true });
    expect(own.inFlightSends.size).toBe(0);
    expect(own.outboundDedup.wouldSend('outbound:telegram:42', 'hello')).toBe(false);
  });
});

// Review focus 2 (Context Budget 3): an extracted module must load on its own,
// before index.ts, with no import cycle back into it.
describe('extracted gateway modules load before index', () => {
  it.each([
    'gateway-pure',
    'gateway-config',
    'gateway-types',
    'audience',
    'delivery-ledger-sweep',
    'outbound-send',
    'wake-review',
    'spool-turns',
    'spool-replay',
    'voice-reply',
    'daily-spend',
    'lane-manager',
  ])('%s imports first, then index constructs a Gateway', async (mod) => {
    vi.resetModules();
    await import(`../${mod}.ts`);
    const { Gateway: Fresh } = await import('../index');
    expect(typeof Fresh).toBe('function');
  });
});
