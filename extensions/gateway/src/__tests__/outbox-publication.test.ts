// O-T5 (plan/phases/trust-before-reach.md) — `Gateway.deliverPublication`.
//
// A publication is the one outbound send where the identity of the sender was
// APPROVED: a human read a card that named the bot and the exact text, and
// tapped approve. So this path may not do what the platform-addressed sends do
// and resolve an adapter by platform — with two bots on one platform that
// publishes B's post in A's voice, to A's audience, over A's name.
//
// These tests run SalesBot (A) and SupportBot (B) on Telegram, the same shape
// `bot-addressed-delivery.test.ts` uses for the F08 ledger paths, and prove:
// B's item leaves through B; B without an adapter here refuses rather than
// borrowing A; an unconfirmed publication leaves a `pending` ledger row under
// `outbox:<id>` that the sweep redelivers through B; and the adapter receives
// the approved bytes unchanged.

import type { AgentLoop } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import type { PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { Gateway, type PublicationSpeaksFor } from '../index';
import { type FakeAdapter, fakeAdapter, stubLoop } from './voice-fakes';

const SALES = 'sales-bot';
const SUPPORT = 'support-bot';
const CMO = 'cmo';

function bot(botKey: string, personality: string, loop: AgentLoop = stubLoop()) {
  return { botKey, loop, binding: { type: 'personality' as const, name: personality } };
}

/** SupportBot speaks for `cmo`; SalesBot speaks for nobody in these tests. */
const supportSpeaksForCmo: PublicationSpeaksFor = (botKey, personalityId) =>
  botKey === SUPPORT && personalityId === CMO;

/**
 * A (SalesBot) and B (SupportBot), both Telegram. A is the platform's DEFAULT
 * adapter — first-adapter-per-platform, exactly as the wiring builds
 * `GatewayConfig.adapters` — so any platform-level resolution lands on A and a
 * wrong answer is visible in `sales.sent`.
 */
function twoTelegramBots(
  opts: {
    ledger?: SQLiteDeliveryLedger;
    supportAdapter?: boolean;
    supportSendOk?: boolean;
    speaksFor?: PublicationSpeaksFor | null;
  } = {},
): { gw: Gateway; sales: FakeAdapter; support: FakeAdapter } {
  const sales = fakeAdapter({ id: `telegram:${SALES}` });
  const support = fakeAdapter({
    id: `telegram:${SUPPORT}`,
    ...(opts.supportSendOk === false ? { sendOk: false } : {}),
  });
  const botAdapters = new Map<string, PlatformAdapter>([[SALES, sales.adapter]]);
  if (opts.supportAdapter !== false) botAdapters.set(SUPPORT, support.adapter);
  const speaksFor = opts.speaksFor === undefined ? supportSpeaksForCmo : opts.speaksFor;
  const gw = new Gateway({
    bots: [bot(SALES, 'sales'), bot(SUPPORT, CMO)],
    adapters: new Map([['telegram', sales.adapter]]),
    botAdapters,
    ...(opts.ledger ? { deliveryLedger: opts.ledger } : {}),
    ...(speaksFor ? { publicationSpeaksFor: speaksFor } : {}),
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
  });
  return { gw, sales, support };
}

function publication(text: string, itemId = 'obx_1') {
  return {
    itemId,
    personalityId: CMO,
    botKey: SUPPORT,
    platform: 'telegram',
    chatId: 'C-announce',
    text,
  };
}

describe('deliverPublication — the approved bot sends, or nobody does', () => {
  it('publishes B’s item through B, never through the platform’s default adapter', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const { gw, sales, support } = twoTelegramBots({ ledger });

    const result = await gw.deliverPublication(publication('ship day is Thursday'));

    expect(result.confirmed).toBe(true);
    expect(result.refusal).toBeUndefined();
    expect(sales.sent).toHaveLength(0);
    expect(support.sent).toHaveLength(1);
    expect(support.sent[0]?.chatId).toBe('C-announce');
    ledger.close();
  });

  it('refuses when B has no adapter here — nothing is sent and A is not borrowed', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const { gw, sales, support } = twoTelegramBots({ ledger, supportAdapter: false });

    const result = await gw.deliverPublication(publication('ship day is Thursday'));

    expect(result.confirmed).toBe(false);
    expect(result.refusal?.code).toBe('no_adapter');
    expect(result.obligationId).toBeNull();
    expect(sales.sent).toHaveLength(0);
    expect(support.sent).toHaveLength(0);
    // Nothing was written either: an obligation filed here would be swept by a
    // process whose adapter set is exactly the one that just refused.
    expect(await ledger.findBySession('outbox:obx_1')).toEqual([]);
    ledger.close();
  });

  it('refuses a bot that no longer speaks for the personality', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const { gw, sales, support } = twoTelegramBots({
      ledger,
      speaksFor: () => false,
    });

    const result = await gw.deliverPublication(publication('ship day is Thursday'));

    expect(result.refusal?.code).toBe('not_bound');
    expect(sales.sent).toHaveLength(0);
    expect(support.sent).toHaveLength(0);
    ledger.close();
  });

  it('refuses when no binding re-check is wired rather than assuming the binding holds', async () => {
    const { gw, support } = twoTelegramBots({ speaksFor: null });

    const result = await gw.deliverPublication(publication('ship day is Thursday'));

    expect(result.refusal?.code).toBe('no_binding_check');
    expect(support.sent).toHaveLength(0);
  });

  it('refuses a bot this process does not serve', async () => {
    const { gw, sales, support } = twoTelegramBots();

    const result = await gw.deliverPublication({
      ...publication('ship day is Thursday'),
      botKey: 'marketing-bot',
    });

    expect(result.refusal?.code).toBe('bot_not_served');
    expect(sales.sent).toHaveLength(0);
    expect(support.sent).toHaveLength(0);
  });

  it('hands the adapter the approved revision byte for byte', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const { gw, support } = twoTelegramBots({ ledger });
    // Leading and trailing whitespace, a blank line, a non-ASCII character and
    // a trailing newline: everything a well-meaning normaliser would "fix".
    const approved = '  Launch — 09:00 CET\n\n  • demo\n  • Q&A  \n';

    await gw.deliverPublication(publication(approved));

    expect(support.sent[0]?.message.text).toBe(approved);
    const rows = await ledger.findBySession('outbox:obx_1');
    expect(rows[0]?.content).toBe(approved);
    ledger.close();
  });

  it('carries the item’s thread so a publication into a topic stays there', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const { gw, support } = twoTelegramBots({ ledger });

    await gw.deliverPublication({ ...publication('in-topic'), threadId: 'T7' });

    expect(support.sent[0]?.message.threadId).toBe('T7');
    expect((await ledger.findBySession('outbox:obx_1'))[0]?.threadId).toBe('T7');
    ledger.close();
  });

  it('suppresses a second call for the same item and text, and says so honestly', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const { gw, support } = twoTelegramBots({ ledger });

    await gw.deliverPublication(publication('exactly once'));
    const second = await gw.deliverPublication(publication('exactly once'));

    expect(second.confirmed).toBe(false);
    expect(second.refusal?.code).toBe('deduplicated');
    expect(support.sent).toHaveLength(1);
    ledger.close();
  });
});

describe('deliverPublication — an unconfirmed publication becomes the ledger’s problem', () => {
  it('leaves a pending row under outbox:<id> that the sweep redelivers through B', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const first = twoTelegramBots({ ledger, supportSendOk: false });

    const result = await first.gw.deliverPublication(publication('half-sent'));

    // The platform did not confirm. `confirmed` means `DeliveryResult.ok ===
    // true` and nothing weaker — the adapter resolved, it just said no.
    expect(result.confirmed).toBe(false);
    expect(result.refusal).toBeUndefined();
    expect(result.obligationId).not.toBeNull();

    const rows = await ledger.findBySession('outbox:obx_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.botKey).toBe(SUPPORT);
    expect(rows[0]?.id).toBe(result.obligationId);

    // A new process over the same ledger file — the restart the sweep exists
    // for. SupportBot's adapter works this time.
    const second = twoTelegramBots({ ledger });
    const swept = await second.gw.sweepPendingDeliveries();

    expect(swept).toEqual({ redelivered: 1, failed: 0 });
    expect(second.sales.sent).toHaveLength(0);
    expect(second.support.sent).toHaveLength(1);
    expect(second.support.sent[0]?.message.text).toBe('half-sent');
    expect((await ledger.findBySession('outbox:obx_1'))[0]?.status).toBe('delivered');
    ledger.close();
  });
});
