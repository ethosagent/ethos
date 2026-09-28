// plan personality-memory-boundary D17 — `/learn` writes private memory, so in
// a shared room (`Gateway.audienceFor`) it replies that learning works in a
// private chat and runs NO turn. A DM, or a room the operator listed in
// `gateway.private_chats`, runs the learn turn as before.

import { type AgentLoop, privateChatSetFrom } from '@ethosagent/core';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway, type GatewayConfig, LEARN_SHARED_ROOM_REPLY } from '../index';

function adapter() {
  const sends: string[] = [];
  const a = {
    id: 'telegram:bot-a',
    displayName: 'Telegram',
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (_chatId: string, m: { text: string }) => {
      sends.push(m.text);
      return { ok: true, messageId: String(sends.length) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return { adapter: a, sends };
}

function loop() {
  return {
    run: vi.fn(async function* () {
      yield { type: 'done' as const, text: 'learned', turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  };
}

function learn(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    botKey: 'bot-a',
    chatId: '42',
    userId: 'user-1',
    text: '/learn the deploy is on Fridays',
    isDm: true,
    isGroupMention: false,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: {},
    ...overrides,
  };
}

async function send(message: InboundMessage, extra: Partial<GatewayConfig> = {}) {
  const l = loop();
  const out = adapter();
  const gw = new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: l as unknown as AgentLoop,
        binding: { type: 'personality', name: 'default' },
      },
    ],
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    ...extra,
  });
  await gw.handleMessage(message, out.adapter);
  return { runs: l.run.mock.calls.length, sends: out.sends };
}

describe('/learn and the room audience (D17)', () => {
  it('in a group: replies with the private-chat note and runs no turn', async () => {
    const r = await send(learn({ chatId: '-100g', isDm: false, isGroupMention: true }));
    expect(r.runs).toBe(0);
    expect(r.sends).toEqual([LEARN_SHARED_ROOM_REPLY]);
  });

  it('in a DM hinted shared (e.g. an unverified email): the same refusal', async () => {
    const r = await send(learn({ audienceHint: 'shared' }));
    expect(r.runs).toBe(0);
    expect(r.sends).toEqual([LEARN_SHARED_ROOM_REPLY]);
  });

  it('in a DM: runs the learn turn', async () => {
    const r = await send(learn());
    expect(r.runs).toBe(1);
    expect(r.sends).toEqual(['learned']);
  });

  it('in a group listed in gateway.private_chats: runs the learn turn', async () => {
    const r = await send(learn({ chatId: '-100g', isDm: false, isGroupMention: true }), {
      privateChats: privateChatSetFrom({ telegram: ['-100g'] }),
    });
    expect(r.runs).toBe(1);
  });
});
