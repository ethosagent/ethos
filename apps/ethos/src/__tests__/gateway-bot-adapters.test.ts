// F08 follow-up — `ethos gateway start` must hand the Gateway EVERY adapter,
// keyed by the bot it speaks as, not only the first adapter per platform.
//
// Tracked sends (ledger redelivery, `notifyTracked`, background wakes, clarify
// notices) resolve through `Gateway.botAdapters` by botKey (`adapterForBot` in
// extensions/gateway/src/index.ts). `runGatewayStart` used to build only the
// platform-keyed map, so with two Telegram bots the second bot had no adapter
// for any of them: its failed replies stayed pending forever and its notices
// were refused. `buildGateway` now takes the full adapter list and derives both
// registries itself (`adapterRegistries`), which is what both `runGatewayStart`
// and `ethos boot` pass.

import type { EthosConfig } from '@ethosagent/config';
import type { AgentLoop } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { adapterRegistries } from '@ethosagent/gateway';
import type { DeliveryResult, OutboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { type BuildGatewayOptions, buildGateway } from '../commands/gateway';

function adapter(id: string, extra: Record<string, unknown> = {}) {
  const sent: Array<{ chatId: string; text: string }> = [];
  const a = {
    id,
    displayName: id,
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (chatId: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sent.push({ chatId, text: m.text });
      return { ok: true, messageId: String(sent.length) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
    ...extra,
  } as unknown as PlatformAdapter;
  return { adapter: a, sent };
}

function stubLoop(): AgentLoop {
  return {
    run: vi.fn(async function* () {}),
    hooks: { registerVoid: vi.fn(() => () => {}) },
  } as unknown as AgentLoop;
}

function gatewayFor(adapters: PlatformAdapter[], botKeys: string[]) {
  const deliveryLedger = new SQLiteDeliveryLedger(':memory:');
  const gw = buildGateway({
    config: { personality: 'default' } as EthosConfig,
    bots: botKeys.map((botKey) => ({
      botKey,
      loop: stubLoop(),
      binding: { type: 'personality' as const, name: 'default' },
    })),
    systemLoop: stubLoop(),
    adapters,
    deliveryLedger,
    inboundDedup: undefined,
    resolveUserId: undefined,
    pluginLoader: {
      getPlatformAdapters: () => new Map(),
      getSlashHandler: () => undefined,
      getAllSlashCommands: () => [],
    } as unknown as BuildGatewayOptions['pluginLoader'],
    trustedChannelPlugins: undefined,
    notificationRouter: {
      route: async () => {},
      register: () => {},
      deregister: () => {},
    } as unknown as BuildGatewayOptions['notificationRouter'],
    storage: undefined,
    attachmentCache: {
      clear: async () => {},
    } as unknown as BuildGatewayOptions['attachmentCache'],
    sttProviders: undefined,
    ttsProviders: undefined,
    voiceConfig: {} as BuildGatewayOptions['voiceConfig'],
    voiceModeStore: undefined,
    voiceArtifacts: undefined,
    transcoder: undefined,
    channelVoiceOut: undefined,
    voiceBitrateKbps: undefined,
    personalityDirectory: undefined,
    onTurnComplete: undefined,
    onUserTurn: undefined,
    streamingEdits: undefined,
    pairingDb: undefined,
    channelTranscript: undefined,
    clarifyMessageCorrelator: undefined,
    personalityCardReader: undefined,
    greetingProvider: undefined,
    // This suite is about adapter resolution, not about publication bindings.
    publicationSpeaksFor: () => true,
  });
  return { gw, deliveryLedger };
}

describe('buildGateway — every adapter reaches the bot-keyed registry', () => {
  it('two Telegram bots: the SECOND bot’s tracked send leaves through its own adapter', async () => {
    const sales = adapter('telegram:sales-bot');
    const support = adapter('telegram:support-bot');
    const { gw, deliveryLedger } = gatewayFor(
      [sales.adapter, support.adapter],
      ['sales-bot', 'support-bot'],
    );

    await expect(
      gw.notifyTracked({ platform: 'telegram', chatId: 'C9', botKey: 'support-bot' }, 'summary'),
    ).resolves.toBe(true);
    expect(support.sent).toEqual([{ chatId: 'C9', text: 'summary' }]);
    expect(sales.sent).toHaveLength(0);

    // A failed reply the second bot owes is redelivered, not stranded.
    await deliveryLedger.record({
      botKey: 'support-bot',
      platform: 'telegram',
      chatId: 'C9',
      sessionId: 's',
      content: 'owed',
    });
    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });
    expect(support.sent.map((s) => s.text)).toEqual(['summary', 'owed']);
    expect(gw.listAdapters()).toHaveLength(2);

    await gw.shutdown();
    deliveryLedger.close();
  });
});

describe('adapterRegistries — the one derivation', () => {
  it('keeps the first adapter per platform, and files every adapter under the botKey it speaks as', () => {
    const a = adapter('telegram:a').adapter;
    const b = adapter('telegram:b').adapter;
    // Email's id is the bare platform; the bot it serves is its declared botKey.
    const email = adapter('email', { botKey: 'emailbotkey' }).adapter;

    const { adapters, botAdapters } = adapterRegistries([a, b, email]);

    expect(adapters.get('telegram')).toBe(a);
    expect(adapters.get('email')).toBe(email);
    expect(botAdapters.get('a')).toBe(a);
    expect(botAdapters.get('b')).toBe(b);
    expect(botAdapters.get('emailbotkey')).toBe(email);
    expect(botAdapters.has('email')).toBe(false);
  });
});
