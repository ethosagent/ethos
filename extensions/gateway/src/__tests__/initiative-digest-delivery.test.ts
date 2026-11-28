// The owner digest as a button card, delivered through `Gateway.notifyTracked`: the ledger row is
// written before the platform call, confirmed only on `DeliveryResult.ok === true`, and an adapter
// with no card surface (or one whose card path fails) still delivers the Markdown text.

import { type AgentLoop, DefaultHookRegistry } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import type {
  DeliveryResult,
  InitiativeDigest,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

const digest: InitiativeDigest = {
  personalityId: 'pm',
  generatedAt: '2026-11-28T08:00:00.000Z',
  since: '2026-11-27T08:00:00.000Z',
  ownWork: { windows: 0, spentUsd: 0, explorations: [] },
  needsYes: [{ explorationId: 'EXP-0002', question: 'q2', estimateUsd: 0.5 }],
  agentInitiatives: [],
  briefs: [],
  questions: [],
  suggestions: [],
};

function adapterWith(opts: { cards: boolean; ok?: boolean }) {
  const texts: OutboundMessage[] = [];
  const cards: Array<{ chatId: string; digest: InitiativeDigest; text: string }> = [];
  const result = (): DeliveryResult =>
    opts.ok === false ? { ok: false, error: 'refused' } : { ok: true, messageId: '1' };
  const adapter = {
    id: 'telegram:test',
    displayName: 'Telegram',
    capabilities: { platform: 'telegram' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (_c: string, m: OutboundMessage) => {
      texts.push(m);
      return result();
    }),
    ...(opts.cards
      ? {
          sendInitiativeDigest: vi.fn(
            async (chatId: string, d: InitiativeDigest, o: { text: string }) => {
              cards.push({ chatId, digest: d, text: o.text });
              return result();
            },
          ),
        }
      : {}),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return Object.assign(adapter, { texts, cards });
}

function gatewayWith(ledger: SQLiteDeliveryLedger, adapter: PlatformAdapter) {
  return new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: {
          run: vi.fn(async function* () {
            yield { type: 'done' as const, text: '', turnCount: 1 };
          }),
          hooks: new DefaultHookRegistry(),
        } as unknown as AgentLoop,
        binding: { type: 'personality' as const, name: 'default' },
      },
    ],
    deliveryLedger: ledger,
    adapters: new Map([['telegram', adapter]]),
    clarifySweepIntervalMs: 0,
  });
}

const TARGET = { platform: 'telegram', chatId: 'C1' };

describe('digest card delivery through notifyTracked', () => {
  it('hands the digest and the Markdown text to a card-capable adapter, through the ledger', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const adapter = adapterWith({ cards: true });
    const gw = gatewayWith(ledger, adapter);

    await expect(gw.notifyTracked(TARGET, 'digest md', { initiativeDigest: digest })).resolves.toBe(
      true,
    );

    expect(adapter.cards).toEqual([{ chatId: 'C1', digest, text: 'digest md' }]);
    expect(adapter.texts).toEqual([]);
    expect(await ledger.listPending(['bot-a'])).toHaveLength(0);
  });

  it('an unconfirmed card leaves the text obligation pending for the sweep', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const gw = gatewayWith(ledger, adapterWith({ cards: true, ok: false }));

    await expect(gw.notifyTracked(TARGET, 'digest md', { initiativeDigest: digest })).resolves.toBe(
      false,
    );

    const pending = await ledger.listPending(['bot-a']);
    expect(pending.map((p) => p.content)).toEqual(['digest md']);
    const healthy = adapterWith({ cards: true });
    const rebooted = gatewayWith(ledger, healthy);
    expect(await rebooted.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });
    expect(healthy.texts.map((m) => m.text)).toEqual(['digest md']);
  });

  it('a card path that throws leaves the row pending, like a refused send', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const adapter = adapterWith({ cards: true });
    vi.mocked(
      (adapter as unknown as { sendInitiativeDigest: () => Promise<DeliveryResult> })
        .sendInitiativeDigest,
    ).mockRejectedValue(new Error('socket hangup'));
    const gw = gatewayWith(ledger, adapter);

    await expect(gw.notifyTracked(TARGET, 'digest md', { initiativeDigest: digest })).resolves.toBe(
      false,
    );
    expect(await ledger.listPending(['bot-a'])).toHaveLength(1);
  });

  it('an adapter without a card surface still gets the Markdown text', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const adapter = adapterWith({ cards: false });
    const gw = gatewayWith(ledger, adapter);

    await expect(gw.notifyTracked(TARGET, 'digest md', { initiativeDigest: digest })).resolves.toBe(
      true,
    );
    expect(adapter.texts.map((m) => m.text)).toEqual(['digest md']);
  });
});
