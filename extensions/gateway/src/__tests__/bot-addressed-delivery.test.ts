// F08 (plan/phases/architecture-suggestions-2026-09-10.md) — resolve tracked
// sends by bot, not just by platform.
//
// `GatewayConfig.adapters` holds the FIRST adapter per platform. Every
// obligation in the delivery ledger is filed under a botKey. Resolving a
// tracked send by platform alone therefore let SalesBot's adapter deliver
// SupportBot's pending reply — and SalesBot's `ok: true` marked SupportBot's
// row delivered. These tests run two same-platform bots and prove the owed
// bot, and only the owed bot, discharges its own obligations; and that a bot
// with no adapter here leaves its work pending rather than borrowing a sibling.

import type { AgentLoop } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { Gateway } from '../index';
import { createVoiceArtifactStore, type VoiceArtifactStore } from '../voice-artifacts';
import { type FakeAdapter, fakeAdapter, inbound, recordingTts, stubLoop } from './voice-fakes';

const SALES = 'sales-bot';
const SUPPORT = 'support-bot';
const ARTIFACT_DIR = '/ethos/voice/artifacts';

async function artifactStore(): Promise<VoiceArtifactStore> {
  const storage = new InMemoryStorage();
  await storage.mkdir('/ethos');
  return createVoiceArtifactStore({ storage, dir: ARTIFACT_DIR });
}

function bot(botKey: string, loop: AgentLoop = stubLoop()) {
  return { botKey, loop, binding: { type: 'personality' as const, name: 'default' } };
}

/**
 * SalesBot (A) and SupportBot (B), both on Telegram. A is the platform's
 * default adapter — first-adapter-per-platform, exactly as the wiring builds
 * `GatewayConfig.adapters`. `supportAdapter: false` leaves SupportBot served
 * by this process but with no adapter registered for it.
 */
function twoTelegramBots(opts: {
  ledger: SQLiteDeliveryLedger;
  artifacts?: VoiceArtifactStore;
  supportAdapter?: boolean;
  tts?: ReturnType<typeof recordingTts>;
  supportVoiceOk?: boolean;
}): { gw: Gateway; sales: FakeAdapter; support: FakeAdapter } {
  const sales = fakeAdapter({ id: `telegram:${SALES}` });
  const support = fakeAdapter({
    id: `telegram:${SUPPORT}`,
    ...(opts.supportVoiceOk === false ? { voiceOk: false } : {}),
  });
  const botAdapters = new Map<string, PlatformAdapter>([[SALES, sales.adapter]]);
  if (opts.supportAdapter !== false) botAdapters.set(SUPPORT, support.adapter);
  const gw = new Gateway({
    bots: [bot(SALES), bot(SUPPORT)],
    adapters: new Map([['telegram', sales.adapter]]),
    botAdapters,
    deliveryLedger: opts.ledger,
    ...(opts.artifacts ? { voiceArtifacts: opts.artifacts } : {}),
    ...(opts.tts
      ? {
          ttsProviderRegistry: opts.tts.registry,
          ttsProviderName: 'local-tts',
          defaultVoiceMode: 'all' as const,
        }
      : {}),
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
  });
  return { gw, sales, support };
}

describe('F08 — two same-platform bots: B’s tracked sends go through B', () => {
  it('redelivers SupportBot’s pending text reply through SupportBot, into its thread', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const id = await ledger.record({
      botKey: SUPPORT,
      platform: 'telegram',
      chatId: 'C9',
      sessionId: 's',
      threadId: 'T-1',
      content: 'your ticket is resolved',
    });
    const { gw, sales, support } = twoTelegramBots({ ledger });

    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });

    expect(sales.sent).toHaveLength(0);
    expect(support.sent).toEqual([
      { chatId: 'C9', message: { text: 'your ticket is resolved', threadId: 'T-1' } },
    ]);
    expect((await ledger.get(id))?.status).toBe('delivered');
  });

  it('replays SupportBot’s stored voice note through SupportBot — the same bytes, then released', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const artifacts = await artifactStore();
    const tts = recordingTts('wav');
    const { gw, sales, support } = twoTelegramBots({
      ledger,
      artifacts,
      tts,
      supportVoiceOk: false,
    });

    // A live SupportBot turn: the text reply confirms, the voice note fails.
    await gw.handleMessage(inbound({ botKey: SUPPORT, chatId: 'C9' }), support.adapter);
    const firstAttempt = support.voiceSends[0];
    expect(firstAttempt).toBeDefined();
    const [row] = await ledger.listPending([SUPPORT]);
    expect(row?.kind).toBe('voice');
    expect(row?.botKey).toBe(SUPPORT);

    support.setVoiceOk(true);
    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });

    expect(sales.sent).toHaveLength(0);
    expect(sales.voiceSends).toHaveLength(0);
    expect(support.voiceSends).toHaveLength(2);
    expect(Array.from(support.voiceSends[1]?.audio ?? [])).toEqual(
      Array.from(firstAttempt?.audio ?? []),
    );
    // Replayed, never re-synthesized.
    expect(tts.calls).toHaveLength(1);
    expect((await ledger.get(row?.id ?? ''))?.status).toBe('delivered');
    expect(await artifacts.read(row?.artifactRef ?? '')).toBeNull();
  });

  it('sends SupportBot’s notifyTracked notice through SupportBot', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const { gw, sales, support } = twoTelegramBots({ ledger });

    await expect(
      gw.notifyTracked({ platform: 'telegram', chatId: 'C9', botKey: SUPPORT }, 'call summary'),
    ).resolves.toBe(true);

    expect(sales.sent).toHaveLength(0);
    expect(support.sent.map((s) => s.message.text)).toEqual(['call summary']);
    expect(await ledger.listPending([SUPPORT])).toHaveLength(0);
  });
});

describe('F08 — a bot with no adapter here keeps its work pending; the sibling is never used', () => {
  it('leaves SupportBot’s text and voice obligations pending, untouched, and never sends through SalesBot', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const artifacts = await artifactStore();
    const ref = await artifacts.put(new Uint8Array([1, 2, 3]), 'wav');
    const text = await ledger.record({
      botKey: SUPPORT,
      platform: 'telegram',
      chatId: 'C9',
      sessionId: 's',
      content: 'owed by support',
    });
    const voice = await ledger.record({
      botKey: SUPPORT,
      platform: 'telegram',
      chatId: 'C9',
      sessionId: 's',
      content: 'owed by support, spoken',
      kind: 'voice',
      ...(ref ? { artifactRef: ref } : {}),
      mediaFormat: 'wav',
    });
    const { gw, sales } = twoTelegramBots({ ledger, artifacts, supportAdapter: false });

    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 0, failed: 2 });

    expect(sales.sent).toHaveLength(0);
    expect(sales.voiceSends).toHaveLength(0);
    // Pending — not burned, and not left claimed (`redelivering`) either.
    expect((await ledger.get(text))?.status).toBe('pending');
    expect((await ledger.get(voice))?.status).toBe('pending');
    expect(await artifacts.read(ref ?? '')).not.toBeNull();
  });

  it('refuses SupportBot’s notifyTracked rather than sending it as SalesBot', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const { gw, sales } = twoTelegramBots({ ledger, supportAdapter: false });

    await expect(
      gw.notifyTracked({ platform: 'telegram', chatId: 'C9', botKey: SUPPORT }, 'call summary'),
    ).resolves.toBe(false);
    expect(sales.sent).toHaveLength(0);
  });

  it('checks platform agreement: SupportBot’s Telegram adapter never carries its Slack obligation', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const id = await ledger.record({
      botKey: SUPPORT,
      platform: 'slack',
      chatId: 'C9',
      sessionId: 's',
      content: 'owed on slack',
    });
    const { gw, sales, support } = twoTelegramBots({ ledger });

    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 0, failed: 1 });
    expect(sales.sent).toHaveLength(0);
    expect(support.sent).toHaveLength(0);
    expect((await ledger.get(id))?.status).toBe('pending');
  });
});

describe('F08 — the legacy aliases, normalized once', () => {
  // The single-bot alias. `handleMessage` routes every inbound whose botKey it
  // does not know to the sole bot (`gateway.unknown_botKey`), so in a
  // single-bot deployment every adapter in the process is that bot's. In a
  // multi-bot deployment the same adapter belongs to no bot and is not used.
  it('a single-bot deployment redelivers through the platform adapter; a multi-bot one does not', async () => {
    const record = async (ledger: SQLiteDeliveryLedger) =>
      ledger.record({
        botKey: SALES,
        platform: 'telegram',
        chatId: 'C1',
        sessionId: 's',
        content: 'owed',
      });

    const single = new SQLiteDeliveryLedger(':memory:');
    const singleId = await record(single);
    const unkeyed = fakeAdapter({ id: 'telegram:legacy' });
    const singleGw = new Gateway({
      bots: [bot(SALES)],
      adapters: new Map([['telegram', unkeyed.adapter]]),
      deliveryLedger: single,
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
    });
    expect(await singleGw.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });
    expect(unkeyed.sent).toHaveLength(1);
    expect((await single.get(singleId))?.status).toBe('delivered');

    const multi = new SQLiteDeliveryLedger(':memory:');
    const multiId = await record(multi);
    const stranger = fakeAdapter({ id: 'telegram:legacy' });
    const multiGw = new Gateway({
      bots: [bot(SALES), bot(SUPPORT)],
      adapters: new Map([['telegram', stranger.adapter]]),
      deliveryLedger: multi,
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
    });
    expect(await multiGw.sweepPendingDeliveries()).toEqual({ redelivered: 0, failed: 1 });
    expect(stranger.sent).toHaveLength(0);
    expect((await multi.get(multiId))?.status).toBe('pending');
  });

  // The Email alias. Email's adapter id is the bare platform, `'email'`, so a
  // map keyed by the id's botKey segment files it under `'email'` — while the
  // bot it serves, and every obligation it owes, is `emailBotKey(user, host)`.
  // The adapter's own declared `botKey` is what it stamps on every inbound,
  // so that is the key it is registered under.
  // The live path must file it the same way the cold path does: `addAdapter`
  // used `bot.botKey` while the constructor used the adapter's declared key.
  it('a hot-added adapter is filed under the botKey it declares, as at construction', async () => {
    const EMAIL_KEY = 'emailbotkey00000000abcd0';
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const email = fakeAdapter({ platform: 'email', id: 'email' });
    Object.assign(email.adapter, { botKey: EMAIL_KEY });
    const telegram = fakeAdapter({ id: `telegram:${SALES}` });
    const gw = new Gateway({
      bots: [bot(SALES)],
      adapters: new Map([['telegram', telegram.adapter]]),
      botAdapters: new Map([[SALES, telegram.adapter]]),
      deliveryLedger: ledger,
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
    });

    // The email bot arrives live, filed by the wiring under its bot's key.
    gw.addAdapter(email.adapter, bot(EMAIL_KEY));

    const id = await ledger.record({
      botKey: EMAIL_KEY,
      platform: 'email',
      chatId: 'someone@example.com',
      sessionId: 's',
      content: 'owed by email',
    });
    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });
    expect(email.sent.map((s) => s.message.text)).toEqual(['owed by email']);
    expect((await ledger.get(id))?.status).toBe('delivered');
    // Filed once, under the declared key — not twice.
    expect(gw.listAdapters().filter((a) => a === email.adapter)).toHaveLength(1);

    // And WHICH key wins is the same on both paths: the one the adapter
    // declares (what it stamps on every inbound), not the one it is filed
    // under. `sendVia` reads that map by botKey.
    const odd = fakeAdapter({ id: 'telegram:whatever' });
    Object.assign(odd.adapter, { botKey: 'declared-key' });
    gw.addAdapter(odd.adapter, bot('filed-under-key'));
    expect(await gw.sendVia('declared-key', 'C1', 'hi')).toEqual({ ok: true });

    await gw.shutdown();
    ledger.close();
  });

  it('files an adapter under the botKey it declares, not the one its id implies', async () => {
    const EMAIL_KEY = 'emailbotkey00000000abcd0';
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const id = await ledger.record({
      botKey: EMAIL_KEY,
      platform: 'email',
      chatId: 'someone@example.com',
      sessionId: 's',
      content: 'owed by email',
    });
    const email = fakeAdapter({ platform: 'email', id: 'email' });
    Object.assign(email.adapter, { botKey: EMAIL_KEY });
    const discord = fakeAdapter({ platform: 'discord', id: 'discord:discordkey' });
    const gw = new Gateway({
      bots: [bot(EMAIL_KEY), bot('discordkey')],
      adapters: new Map([
        ['email', email.adapter],
        ['discord', discord.adapter],
      ]),
      // How the wiring builds it: keyed by the id's botKey segment.
      botAdapters: new Map([
        ['email', email.adapter],
        ['discordkey', discord.adapter],
      ]),
      deliveryLedger: ledger,
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
    });

    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });
    expect(email.sent.map((s) => s.message.text)).toEqual(['owed by email']);
    expect((await ledger.get(id))?.status).toBe('delivered');
    // Registered once, under the declared key — not listed twice.
    expect(gw.listAdapters().filter((a) => a === email.adapter)).toHaveLength(1);
  });
});
