// UBP-020 (plan/phases/upstream-bug-parity.md) — a turn that ends with no
// reply text used to deliver NOTHING to the channel: the typing indicator
// stopped and the user was left waiting. Core now ends such a turn with an
// `error` coded `empty_completion` (`emptyCompletionError`,
// packages/core/src/agent-loop/output-cap.ts); a loop that still yields a blank
// `done` is covered too. Either way the user gets one tracked notice and a
// `gateway.empty_reply` event is recorded.

import type { AgentLoop } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_REPLY_NOTICE, Gateway } from '../index';

function recordingAdapter() {
  const sends: string[] = [];
  const adapter = {
    id: 'telegram:bot-a',
    displayName: 'Telegram',
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (_chatId: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sends.push(m.text);
      return { ok: true, messageId: String(sends.length) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return { adapter, sends };
}

function loopYielding(events: Array<Record<string, unknown>>) {
  return {
    run: vi.fn(async function* () {
      for (const e of events) yield e;
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  } as unknown as AgentLoop;
}

function msg(): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'summarise the report',
    isDm: true,
    isGroupMention: false,
    botKey: 'bot-a',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: {},
  };
}

function gateway(loop: AgentLoop, adapter: PlatformAdapter) {
  const events: Array<{ code: string }> = [];
  const ledger = new SQLiteDeliveryLedger(':memory:');
  const gw = new Gateway({
    bots: [{ botKey: 'bot-a', loop, binding: { type: 'personality', name: 'default' } }],
    adapters: new Map([['telegram', adapter]]),
    deliveryLedger: ledger,
    observability: {
      recordSafetyBlock: (e: { code: string }) => events.push(e),
    } as never,
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
  });
  return { gw, events, ledger };
}

describe('an empty final reaches the user as one notice (UBP-020)', () => {
  it('a blank done sends one tracked notice and records gateway.empty_reply', async () => {
    const out = recordingAdapter();
    const { gw, events, ledger } = gateway(
      loopYielding([{ type: 'done', text: '', turnCount: 1 }]),
      out.adapter,
    );
    await gw.handleMessage(msg(), out.adapter);
    expect(out.sends).toEqual([EMPTY_REPLY_NOTICE]);
    expect(events.filter((e) => e.code === 'gateway.empty_reply')).toHaveLength(1);
    // Tracked: it is this inbound message's reply obligation.
    const rows = await ledger.findBySession('telegram:bot-a:chat-1');
    expect(rows.map((r) => r.content)).toEqual([EMPTY_REPLY_NOTICE]);
  });

  it('an empty_completion error names the cause and records gateway.empty_reply', async () => {
    const out = recordingAdapter();
    const { gw, events } = gateway(
      loopYielding([
        {
          type: 'error',
          code: 'empty_completion',
          error: 'The model reached its output token limit before writing any reply.',
        },
      ]),
      out.adapter,
    );
    await gw.handleMessage(msg(), out.adapter);
    expect(out.sends).toHaveLength(1);
    expect(out.sends[0]).toContain('output token limit');
    expect(out.sends[0]).not.toBe('');
    expect(events.filter((e) => e.code === 'gateway.empty_reply')).toHaveLength(1);
  });

  it('a normal reply records no empty_reply event', async () => {
    const out = recordingAdapter();
    const { gw, events } = gateway(
      loopYielding([
        { type: 'text_delta', text: 'hello' },
        { type: 'done', text: 'hello', turnCount: 1 },
      ]),
      out.adapter,
    );
    await gw.handleMessage(msg(), out.adapter);
    expect(out.sends).toEqual(['hello']);
    expect(events.filter((e) => e.code === 'gateway.empty_reply')).toHaveLength(0);
  });
});
