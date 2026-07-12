import type { AgentLoop } from '@ethosagent/core';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

// ---------------------------------------------------------------------------
// P5.1 — Discord/Email botKey registration + routing
//
// Before P5.1, Discord and Email had no botKey and were never registered as
// bots, so their inbound messages dropped at the unknown-botKey gate. Now
// wiring computes a botKey once, stamps it on the adapter AND registers a
// matching bot entry — so an inbound carrying that botKey resolves to the
// bot's loop. These tests exercise that routing contract at the Gateway.
// ---------------------------------------------------------------------------

function stubAdapter(id: string): PlatformAdapter {
  return {
    id,
    displayName: id,
    capabilities: { platform: id.split(':')[0] ?? id },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ ok: true, messageId: '1' }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function stubLoop() {
  return {
    run: vi.fn(async function* () {
      yield { type: 'text_delta' as const, text: 'reply' };
      yield { type: 'done' as const, text: 'reply', turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  };
}

function makeMessage(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    platform: 'discord',
    chatId: '100',
    userId: '200',
    text: 'hello',
    isDm: true,
    isGroupMention: false,
    messageId: '1',
    botKey: 'discord-key',
    raw: {},
    ...overrides,
  };
}

const DISCORD_KEY = 'discordbotkey0000000abcd';
const EMAIL_KEY = 'emailbotkey00000000abcd0';

describe('Gateway — Discord/Email inbound routes to the registered bot loop', () => {
  it('routes a Discord inbound stamped with the wired botKey to its loop', async () => {
    const discordLoop = stubLoop();
    const emailLoop = stubLoop();
    const gw = new Gateway({
      bots: [
        {
          botKey: DISCORD_KEY,
          loop: discordLoop as unknown as AgentLoop,
          binding: { type: 'personality', name: 'default' },
        },
        {
          botKey: EMAIL_KEY,
          loop: emailLoop as unknown as AgentLoop,
          binding: { type: 'personality', name: 'default' },
        },
      ],
      clarifySweepIntervalMs: 0,
    });

    await gw.handleMessage(
      makeMessage({ platform: 'discord', botKey: DISCORD_KEY, chatId: 'c1', messageId: 'd1' }),
      stubAdapter(`discord:${DISCORD_KEY}`),
    );

    expect(discordLoop.run).toHaveBeenCalledTimes(1);
    expect(emailLoop.run).not.toHaveBeenCalled();
  });

  it('routes an Email inbound stamped with the wired botKey to its loop', async () => {
    const discordLoop = stubLoop();
    const emailLoop = stubLoop();
    const gw = new Gateway({
      bots: [
        {
          botKey: DISCORD_KEY,
          loop: discordLoop as unknown as AgentLoop,
          binding: { type: 'personality', name: 'default' },
        },
        {
          botKey: EMAIL_KEY,
          loop: emailLoop as unknown as AgentLoop,
          binding: { type: 'personality', name: 'default' },
        },
      ],
      clarifySweepIntervalMs: 0,
    });

    await gw.handleMessage(
      makeMessage({ platform: 'email', botKey: EMAIL_KEY, chatId: 'e1', messageId: 'm1' }),
      stubAdapter('email'),
    );

    expect(emailLoop.run).toHaveBeenCalledTimes(1);
    expect(discordLoop.run).not.toHaveBeenCalled();
  });

  it('drops an inbound whose botKey matches no registered bot (multi-bot gate)', async () => {
    const discordLoop = stubLoop();
    const emailLoop = stubLoop();
    const gw = new Gateway({
      bots: [
        {
          botKey: DISCORD_KEY,
          loop: discordLoop as unknown as AgentLoop,
          binding: { type: 'personality', name: 'default' },
        },
        {
          botKey: EMAIL_KEY,
          loop: emailLoop as unknown as AgentLoop,
          binding: { type: 'personality', name: 'default' },
        },
      ],
      clarifySweepIntervalMs: 0,
    });

    await gw.handleMessage(
      makeMessage({ platform: 'discord', botKey: 'unknown-key', chatId: 'x1', messageId: 'u1' }),
      stubAdapter('discord:unknown-key'),
    );

    expect(discordLoop.run).not.toHaveBeenCalled();
    expect(emailLoop.run).not.toHaveBeenCalled();
  });
});
