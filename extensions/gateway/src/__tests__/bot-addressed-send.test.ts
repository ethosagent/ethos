// B-T4 (plan/phases/trust-before-reach.md) — an agent-initiated send leaves
// through the bot whose turn produced it.
//
// `send_message` used to call `Gateway.sendTo`, which resolves the FIRST
// adapter registered for a platform. With SalesBot and SupportBot both on
// Telegram, SupportBot's turn sent as SalesBot — the wrong identity answering
// in a chat SalesBot was never in. `sendAsBot` binds the send to the botKey the
// turn's lane names, and refuses rather than falling back when it cannot.

import type { AgentLoop } from '@ethosagent/core';
import type { PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { Gateway } from '../index';
import { type FakeAdapter, fakeAdapter, stubLoop } from './voice-fakes';

const SALES = 'sales-bot';
const SUPPORT = 'support-bot';

function bot(botKey: string, loop: AgentLoop = stubLoop()) {
  return { botKey, loop, binding: { type: 'personality' as const, name: 'default' } };
}

/**
 * SalesBot (A) and SupportBot (B), both on Telegram. A is the platform's
 * default adapter — first-adapter-per-platform, exactly as the wiring builds
 * `GatewayConfig.adapters`.
 */
function twoTelegramBots(): { gw: Gateway; sales: FakeAdapter; support: FakeAdapter } {
  const sales = fakeAdapter({ id: `telegram:${SALES}` });
  const support = fakeAdapter({ id: `telegram:${SUPPORT}` });
  const gw = new Gateway({
    bots: [bot(SALES), bot(SUPPORT)],
    adapters: new Map([['telegram', sales.adapter]]),
    botAdapters: new Map<string, PlatformAdapter>([
      [SALES, sales.adapter],
      [SUPPORT, support.adapter],
    ]),
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
  });
  return { gw, sales, support };
}

/** The single-bot deployment every existing install is. */
function oneTelegramBot(): { gw: Gateway; sales: FakeAdapter } {
  const sales = fakeAdapter({ id: `telegram:${SALES}` });
  const gw = new Gateway({
    bots: [bot(SALES)],
    adapters: new Map([['telegram', sales.adapter]]),
    botAdapters: new Map<string, PlatformAdapter>([[SALES, sales.adapter]]),
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
  });
  return { gw, sales };
}

describe('Gateway.sendAsBot — two same-platform bots', () => {
  it('sends a turn on B’s lane through B, never through the platform default', async () => {
    const { gw, sales, support } = twoTelegramBots();

    expect(await gw.sendAsBot('telegram', 'C9', 'from support', SUPPORT)).toEqual({ ok: true });

    expect(support.sent).toEqual([{ chatId: 'C9', message: { text: 'from support' } }]);
    expect(sales.sent).toHaveLength(0);
  });

  it('refuses when B is gone and never falls back to A', async () => {
    const { gw, sales, support } = twoTelegramBots();
    await gw.removeAdapter(SUPPORT);

    const result = await gw.sendAsBot('telegram', 'C9', 'from support', SUPPORT);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('CRON_TARGET_NOT_ALLOWED');
    expect(result.error).toContain(SUPPORT);
    expect(sales.sent).toHaveLength(0);
    expect(support.sent).toHaveLength(0);
  });

  it('refuses a web turn as an ambiguous sender rather than picking the first adapter', async () => {
    const { gw, sales, support } = twoTelegramBots();

    // A web turn's session key names no bot, so the tool passes no botKey.
    const result = await gw.sendAsBot('telegram', 'C9', 'from the web UI', undefined);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ambiguous sender');
    expect(sales.sent).toHaveLength(0);
    expect(support.sent).toHaveLength(0);
  });

  it('refuses a platform with no bot at all', async () => {
    const { gw } = twoTelegramBots();

    const result = await gw.sendAsBot('slack', 'C9', 'hello', undefined);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('CRON_TARGET_NOT_ALLOWED');
  });
});

describe('Gateway.sendAsBot — single-bot deployment behaves as it did', () => {
  it('sends a bot-named call through the one adapter', async () => {
    const { gw, sales } = oneTelegramBot();

    expect(await gw.sendAsBot('telegram', 'C1', 'hi', SALES)).toEqual({ ok: true });
    expect(sales.sent).toEqual([{ chatId: 'C1', message: { text: 'hi' } }]);
  });

  it('sends an unnamed call (CLI or web turn) through the one adapter', async () => {
    const { gw, sales } = oneTelegramBot();

    expect(await gw.sendAsBot('telegram', 'C1', 'hi', undefined)).toEqual({ ok: true });
    expect(sales.sent).toEqual([{ chatId: 'C1', message: { text: 'hi' } }]);
  });

  it('reports an adapter failure instead of swallowing it', async () => {
    const failing = fakeAdapter({ id: `telegram:${SALES}`, sendOk: false });
    const gw = new Gateway({
      bots: [bot(SALES)],
      adapters: new Map([['telegram', failing.adapter]]),
      botAdapters: new Map<string, PlatformAdapter>([[SALES, failing.adapter]]),
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
    });

    const result = await gw.sendAsBot('telegram', 'C1', 'hi', SALES);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('platform rejected the message');
  });
});
