import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import type { DeliveryResult, InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { Gateway } from '../index';

// `/mute <duration>` and `/mute off` change a lane's notices for everyone in
// it, so in a group they take `/personality`'s rule (plan openclaw-advisory-fixes
// D20/D21): owner only, and a group on a platform with no owner refuses. DMs and
// the read-only `/mute` stay open.

function makeLoop(): AgentLoop {
  return {
    hooks: new DefaultHookRegistry(),
    async *run() {
      yield { type: 'done' as const, text: '', turnCount: 1 };
    },
  } as unknown as AgentLoop;
}

function makeAdapter(): PlatformAdapter & { sent: string[] } {
  const sent: string[] = [];
  return {
    id: 'telegram:bot-1',
    displayName: 'Telegram',
    capabilities: { platform: 'test' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    async start() {},
    async stop() {},
    async send(_chatId: string, msg: { text: string }): Promise<DeliveryResult> {
      sent.push(msg.text);
      return { ok: true, messageId: `m${sent.length}` };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
    sent,
  };
}

function inbound(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    botKey: 'bot-1',
    chatId: 'G1',
    userId: 'member',
    text,
    isDm: false,
    isGroupMention: true,
    messageId: `msg-${Math.random()}`,
    raw: null,
    ...overrides,
  };
}

function gateway(withOwner: boolean): Gateway {
  return new Gateway({
    bots: [{ botKey: 'bot-1', loop: makeLoop(), binding: { type: 'personality', name: 'r' } }],
    clarifySweepIntervalMs: 0,
    ...(withOwner
      ? {
          channelFilter: {
            telegram: { ownerUserId: 'owner', recipientAllowlist: ['member', 'owner'] },
          },
        }
      : {}),
  });
}

const MUTED = /Notices muted in this chat until/;

describe('gateway /mute owner rule in groups', () => {
  it('a non-owner cannot mute or unmute a group; the owner can', async () => {
    const gw = gateway(true);
    const adapter = makeAdapter();

    await gw.handleMessage(inbound('/mute 2h'), adapter);
    expect(adapter.sent.at(-1)).toBe('Only the bot owner can mute notices in a group.');
    await gw.handleMessage(inbound('/mute'), adapter);
    expect(adapter.sent.at(-1)).not.toMatch(MUTED);

    await gw.handleMessage(inbound('/mute 2h', { userId: 'owner' }), adapter);
    expect(adapter.sent.at(-1)).toMatch(MUTED);

    await gw.handleMessage(inbound('/mute off'), adapter);
    expect(adapter.sent.at(-1)).toBe('Only the bot owner can mute notices in a group.');
    // The read-only form stays open to members, and the owner's mute held.
    await gw.handleMessage(inbound('/mute'), adapter);
    expect(adapter.sent.at(-1)).toMatch(MUTED);
  });

  it('a group with no owner configured refuses and names the key', async () => {
    const gw = gateway(false);
    const adapter = makeAdapter();
    await gw.handleMessage(inbound('/mute 2h'), adapter);
    expect(adapter.sent.at(-1)).toContain('channel_filter.telegram.ownerUserId');
    await gw.handleMessage(inbound('/mute'), adapter);
    expect(adapter.sent.at(-1)).not.toMatch(MUTED);
  });

  it('a DM stays open without an owner', async () => {
    const gw = gateway(false);
    const adapter = makeAdapter();
    await gw.handleMessage(inbound('/mute 2h', { chatId: 'D1', isDm: true }), adapter);
    expect(adapter.sent.at(-1)).toMatch(MUTED);
  });
});
