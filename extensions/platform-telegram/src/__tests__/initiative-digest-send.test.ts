import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import { type DigestBrief, type InitiativeDigest, parseInitiativeAction } from '@ethosagent/types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `TelegramAdapter.sendInitiativeDigest`: the digest as an inline keyboard whose callback data is
// the `init:` action id the tap router parses (initiative-tap.test.ts), with the Markdown text as
// the fallback when no card can carry it.

const mockApi = {
  setMyCommands: vi.fn().mockResolvedValue(true),
  sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
  getMe: vi.fn().mockResolvedValue({ id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' }),
};

vi.mock('grammy', () => {
  class MockBot {
    token = '1:fake-token';
    api = mockApi;
    on() {}
    start() {
      return Promise.resolve();
    }
    stop() {
      return Promise.resolve();
    }
  }
  class MockInlineKeyboard {
    readonly buttons: Array<{ label: string; data: string }> = [];
    text(label: string, data: string) {
      this.buttons.push({ label, data });
      return this;
    }
    row() {
      return this;
    }
  }
  return { Bot: MockBot, InlineKeyboard: MockInlineKeyboard };
});

import { TelegramAdapter } from '../index';
import { loadTelegramSdk } from '../sdk';

beforeAll(async () => {
  await loadTelegramSdk();
});

beforeEach(() => {
  mockApi.sendMessage.mockReset().mockResolvedValue({ message_id: 42 });
});

const adapter = () =>
  new TelegramAdapter({
    token: '1:fake-token',
    botKey: 'test-bot',
    cache: new InMemoryAttachmentCache(),
  });

const brief = (n: number): DigestBrief => ({
  explorationId: `EXP-000${n}`,
  initiativeId: 'grow',
  question: `Question ${n}`,
  found: [
    { id: 'F-0001', claim: 'c'.repeat(300) },
    { id: 'F-0002', claim: 'd'.repeat(300) },
  ],
  stillUnknown: [],
  options: [],
  effort: '',
  risk: '',
  recommendation: 'x'.repeat(200),
  recommendedOption: 'A',
  partial: false,
  digDeeperUsd: null,
});

const digest = (over: Partial<InitiativeDigest> = {}): InitiativeDigest => ({
  personalityId: 'pm',
  generatedAt: '2026-11-28T08:00:00.000Z',
  since: '2026-11-27T08:00:00.000Z',
  ownWork: { windows: 0, spentUsd: 0, explorations: [] },
  needsYes: [{ explorationId: 'EXP-0002', question: 'q2', estimateUsd: 0.5 }],
  agentInitiatives: [],
  briefs: [],
  questions: [],
  suggestions: [],
  ...over,
});

const keyboardData = (call: number): string[] => {
  const opts = mockApi.sendMessage.mock.calls[call]?.[2] as
    | { reply_markup?: { buttons: Array<{ data: string }> } }
    | undefined;
  return opts?.reply_markup?.buttons.map((b) => b.data) ?? [];
};

describe('TelegramAdapter.sendInitiativeDigest', () => {
  it('digest send produces a keyboard carrying init: action ids', async () => {
    const res = await adapter().sendInitiativeDigest('77', digest(), { text: 'md fallback' });
    expect(res).toEqual({ ok: true, messageId: '42' });
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(1);
    const data = keyboardData(0);
    expect(data).toContain('init:approve:EXP-0002');
    for (const d of data) expect(parseInitiativeAction(d)).not.toBeNull();
  });

  it('a digest too long for one message goes out as a header card plus one brief card each', async () => {
    const briefs = Array.from({ length: 8 }, (_, i) => brief(i + 1));
    const res = await adapter().sendInitiativeDigest(
      '77',
      digest({ briefs, ownWork: { windows: 1, spentUsd: 1, explorations: [] } }),
      { text: 'md fallback' },
    );
    expect(res.ok).toBe(true);
    const texts = mockApi.sendMessage.mock.calls.map((c) => c[1] as string);
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.every((t) => t.length <= 4096)).toBe(true);
    expect(keyboardData(1)).toContain('init:adopt:EXP-0001');
  });

  it('when the card build fails, the text fallback still delivers', async () => {
    const broken = { ...digest(), needsYes: null } as unknown as InitiativeDigest;
    const res = await adapter().sendInitiativeDigest('77', broken, { text: 'md fallback' });
    expect(res.ok).toBe(true);
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockApi.sendMessage.mock.calls[0]?.[1]).toBe('md fallback');
    expect(mockApi.sendMessage.mock.calls[0]?.[2]).not.toHaveProperty('reply_markup');
  });

  it('a digest with no button anywhere is sent as the text', async () => {
    const res = await adapter().sendInitiativeDigest(
      '77',
      digest({ needsYes: [], questions: [{ id: 'Q1', initiativeId: 'grow', text: 'why?' }] }),
      { text: 'md fallback' },
    );
    expect(res.ok).toBe(true);
    expect(mockApi.sendMessage.mock.calls[0]?.[1]).toBe('md fallback');
  });

  it('an unconfirmed card is { ok: false } so the ledger keeps the obligation', async () => {
    mockApi.sendMessage.mockRejectedValue(new Error('Too Many Requests'));
    const res = await adapter().sendInitiativeDigest('77', digest(), { text: 'md fallback' });
    expect(res.ok).toBe(false);
  });

  it('carries the thread', async () => {
    await adapter().sendInitiativeDigest('77', digest(), { text: 'md', threadId: '9' });
    expect(mockApi.sendMessage.mock.calls[0]?.[2]).toMatchObject({ message_thread_id: 9 });
  });
});
