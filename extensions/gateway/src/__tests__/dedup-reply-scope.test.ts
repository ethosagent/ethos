// UBP-014 (plan/phases/upstream-bug-parity.md, owner decision D2) — reply-path
// dedup is keyed on the INBOUND message (ARCHITECTURE.md §V S3 as amended
// 2026-09-28). A correct reply to a new message used to be dropped when its
// text equalled the previous reply in the lane inside the 30s TTL: "delete
// a.txt" → "Done.", "delete b.txt" → (nothing). Each inbound now gets its own
// terminal delivery; a double send of ONE reply is still a silent drop.

import type { AgentLoop } from '@ethosagent/core';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { MessageDedupCache } from '../dedup';
import { Gateway } from '../index';
import { DraftStreamer } from '../streaming';

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

function doneLoop(text: string) {
  return {
    run: vi.fn(async function* () {
      yield { type: 'text_delta', text };
      yield { type: 'done', text, turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  } as unknown as AgentLoop;
}

function msg(text: string, messageId: string): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'group-1',
    userId: 'user-1',
    text,
    // A group: `streamingEdits.group` defaults to false, so the reply takes the
    // non-streamed path that gates on dedup.
    isDm: false,
    isGroupMention: true,
    botKey: 'bot-a',
    messageId,
    raw: {},
  };
}

function gateway(loop: AgentLoop, adapter: PlatformAdapter): Gateway {
  return new Gateway({
    bots: [{ botKey: 'bot-a', loop, binding: { type: 'personality', name: 'default' } }],
    adapters: new Map([['telegram', adapter]]),
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
  });
}

describe('reply dedup is scoped to the inbound message (UBP-014)', () => {
  it('two different messages whose correct replies are identical both get the reply', async () => {
    const out = recordingAdapter();
    const gw = gateway(doneLoop('Done.'), out.adapter);
    await gw.handleMessage(msg('delete a.txt', 'm-1'), out.adapter);
    await gw.handleMessage(msg('delete b.txt', 'm-2'), out.adapter);
    expect(out.sends).toEqual(['Done.', 'Done.']);
  });

  it('the same inbound message delivered twice is still answered once', async () => {
    const out = recordingAdapter();
    const loop = doneLoop('Done.');
    const gw = gateway(loop, out.adapter);
    // Inbound dedup drops the platform's redelivery before a turn runs; the
    // reply-path key covers a second answer to the SAME message.
    await gw.handleMessage(msg('delete a.txt', 'm-1'), out.adapter);
    await gw.handleMessage(msg('delete a.txt', 'm-1'), out.adapter);
    expect(out.sends).toEqual(['Done.']);
  });

  it('the streamed final registers under its inbound message, not the lane', async () => {
    const dedup = new MessageDedupCache({ ttlMs: 60_000 });
    const adapter = {
      send: vi.fn(async (): Promise<DeliveryResult> => ({ ok: true, messageId: 'd1' })),
      editMessage: vi.fn(async (): Promise<DeliveryResult> => ({ ok: true })),
    };
    const streamer = new DraftStreamer({
      adapter,
      chatId: 'c1',
      threadId: undefined,
      sessionKey: 's1',
      dedup,
      inboundId: 'in-1',
      minEditIntervalMs: 0,
    });
    await streamer.pushText('Done.');
    await streamer.finalize('Done.');
    expect(dedup.wouldSend('s1', 'Done.', { inboundId: 'in-1' })).toBe(false);
    expect(dedup.wouldSend('s1', 'Done.', { inboundId: 'in-2' })).toBe(true);
  });
});
