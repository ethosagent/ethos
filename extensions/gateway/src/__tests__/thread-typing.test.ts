// UBP-017 (plan/phases/upstream-bug-parity.md) — a turn in a thread or forum
// topic shows its typing indicator (and Discord's "Thinking…" placeholder) in
// THAT thread, and a streamed draft is edited where it was posted. The gateway
// used to call `sendTyping(chatId)` and `editMessage(chatId, id, body)` with no
// thread, so Discord posted the placeholder in the parent channel and a thread
// draft's edits missed.

import type { AgentLoop } from '@ethosagent/core';
import type { DeliveryResult, InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { MessageDedupCache } from '../dedup';
import { Gateway } from '../index';
import { DraftStreamer } from '../streaming';

function typingAdapter() {
  const sendTyping = vi.fn(async (_chatId: string, _opts?: { threadId?: string }) => {});
  const adapter = {
    id: 'discord:bot-a',
    displayName: 'Discord',
    canSendTyping: true,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 2000,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (): Promise<DeliveryResult> => ({ ok: true, messageId: 'm1' })),
    sendTyping,
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return { adapter, sendTyping };
}

function msg(threadId?: string): InboundMessage {
  return {
    platform: 'discord',
    chatId: 'parent-channel',
    userId: 'user-1',
    text: 'hello',
    isDm: false,
    isGroupMention: true,
    botKey: 'bot-a',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    ...(threadId ? { threadId } : {}),
    raw: {},
  };
}

function gateway(adapter: PlatformAdapter): Gateway {
  const loop = {
    run: vi.fn(async function* () {
      yield { type: 'done', text: 'hi', turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  } as unknown as AgentLoop;
  return new Gateway({
    bots: [{ botKey: 'bot-a', loop, binding: { type: 'personality', name: 'default' } }],
    adapters: new Map([['discord', adapter]]),
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
  });
}

describe('typing lands in the thread the turn is in (UBP-017)', () => {
  it('a thread turn calls sendTyping with the thread id', async () => {
    const { adapter, sendTyping } = typingAdapter();
    await gateway(adapter).handleMessage(msg('thread-7'), adapter);
    expect(sendTyping).toHaveBeenCalledWith('parent-channel', { threadId: 'thread-7' });
  });

  it('a root-chat turn passes no thread', async () => {
    const { adapter, sendTyping } = typingAdapter();
    await gateway(adapter).handleMessage(msg(), adapter);
    expect(sendTyping).toHaveBeenCalledWith('parent-channel', undefined);
  });
});

describe('a streamed thread draft is edited in its thread (UBP-017)', () => {
  it('intermediate and final edits both carry the thread id', async () => {
    const editMessage = vi.fn(
      async (
        _c: string,
        _id: string,
        _t: string,
        _o?: { final?: boolean; threadId?: string },
      ): Promise<DeliveryResult> => ({ ok: true }),
    );
    const streamer = new DraftStreamer({
      adapter: {
        send: vi.fn(async (): Promise<DeliveryResult> => ({ ok: true, messageId: 'd1' })),
        editMessage,
      },
      chatId: 'parent-channel',
      threadId: 'thread-7',
      sessionKey: 's1',
      dedup: new MessageDedupCache(),
      minEditIntervalMs: 0,
    });
    await streamer.pushText('first');
    await streamer.pushText('first and second');
    await streamer.finalize('first and second and done');
    const opts = editMessage.mock.calls.map((c) => c[3]);
    expect(opts.length).toBeGreaterThanOrEqual(2);
    for (const o of opts) expect(o?.threadId).toBe('thread-7');
    expect(opts.at(-1)).toEqual({ final: true, threadId: 'thread-7' });
  });
});
