import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import type { ChannelFilterConfig } from '@ethosagent/safety-channel';
import type { DeliveryResult, InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { Gateway } from '../index';

// Plan openclaw-advisory-fixes L-a (D20/D21): a group `/personality <id>`
// switch is owner-only; a group with no owner configured refuses; DMs and the
// read-only forms stay open.

function makeFakeLoop(): AgentLoop & { runArgs: Array<string | undefined> } {
  const runArgs: Array<string | undefined> = [];
  return {
    hooks: new DefaultHookRegistry(),
    async *run(_text: string, opts?: { personalityId?: string }) {
      runArgs.push(opts?.personalityId);
      yield { type: 'done' as const, text: '', turnCount: 1 };
    },
    runArgs,
  } as unknown as AgentLoop & { runArgs: Array<string | undefined> };
}

function makeFakeAdapter(): PlatformAdapter & { sentMessages: string[] } {
  const sentMessages: string[] = [];
  return {
    id: 'telegram:bot-1',
    displayName: 'Telegram',
    capabilities: { platform: 'test' },
    canSendTyping: false,
    canEditMessage: true,
    canReact: true,
    canSendFiles: false,
    maxMessageLength: 4096,
    async start() {},
    async stop() {},
    async send(_chatId: string, msg: { text: string }): Promise<DeliveryResult> {
      sentMessages.push(msg.text);
      return { ok: true, messageId: 'm1' };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
    sentMessages,
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
    messageId: `msg-${Date.now()}-${Math.random()}`,
    raw: null,
    ...overrides,
  };
}

function makeGateway(loop: AgentLoop, channelFilter?: ChannelFilterConfig): Gateway {
  return new Gateway({
    bots: [
      {
        botKey: 'bot-1',
        loop,
        binding: { type: 'personality', name: 'researcher', allowSlashSwitch: true },
      },
    ],
    clarifySweepIntervalMs: 0,
    personalityDirectory: {
      refresh: async () => {},
      has: (id) => id === 'researcher' || id === 'engineer',
      list: () => [
        { id: 'researcher', name: 'Researcher', isDefault: true },
        { id: 'engineer', name: 'Engineer', isDefault: false },
      ],
    },
    ...(channelFilter ? { channelFilter } : {}),
  });
}

const withOwner: ChannelFilterConfig = {
  telegram: { ownerUserId: 'owner', recipientAllowlist: ['member'] },
};

describe('gateway /personality — owner check in groups (L-a)', () => {
  it('refuses a non-owner in a group and leaves the lane personality unchanged', async () => {
    const loop = makeFakeLoop();
    const adapter = makeFakeAdapter();
    const gateway = makeGateway(loop, withOwner);

    await gateway.handleMessage(inbound('/personality engineer'), adapter);
    expect(adapter.sentMessages[0]).toBe('Only the bot owner can switch personalities in a group.');

    await gateway.handleMessage(inbound('/personality'), adapter);
    expect(adapter.sentMessages[1]).toBe('Current personality: researcher');

    await gateway.handleMessage(inbound('hello'), adapter);
    expect(loop.runArgs.at(-1)).toBe('researcher');
  });

  it('lets the owner switch in a group', async () => {
    const loop = makeFakeLoop();
    const adapter = makeFakeAdapter();
    const gateway = makeGateway(loop, withOwner);

    await gateway.handleMessage(inbound('/personality engineer', { userId: 'owner' }), adapter);
    expect(adapter.sentMessages[0]).toContain('Switched to engineer');

    await gateway.handleMessage(inbound('hello', { userId: 'owner' }), adapter);
    expect(loop.runArgs.at(-1)).toBe('engineer');
  });

  it('refuses in a group when no owner is configured, pointing at the config key (D21)', async () => {
    const loop = makeFakeLoop();
    const adapter = makeFakeAdapter();
    const gateway = makeGateway(loop); // no channel_filter at all

    await gateway.handleMessage(inbound('/personality engineer'), adapter);
    expect(adapter.sentMessages[0]).toContain('channel_filter.telegram.ownerUserId');

    await gateway.handleMessage(inbound('hello'), adapter);
    expect(loop.runArgs.at(-1)).toBe('researcher');
  });

  it('lets any allowed user switch in a DM', async () => {
    const loop = makeFakeLoop();
    const adapter = makeFakeAdapter();
    const gateway = makeGateway(loop, withOwner);

    await gateway.handleMessage(
      inbound('/personality engineer', { isDm: true, chatId: 'D1' }),
      adapter,
    );
    expect(adapter.sentMessages[0]).toContain('Switched to engineer');
  });

  it('keeps `/personality list` and `/personality` open to a non-owner in a group', async () => {
    const loop = makeFakeLoop();
    const adapter = makeFakeAdapter();
    const gateway = makeGateway(loop, withOwner);

    await gateway.handleMessage(inbound('/personality list'), adapter);
    expect(adapter.sentMessages[0]).toContain('engineer — Engineer');

    await gateway.handleMessage(inbound('/personality'), adapter);
    expect(adapter.sentMessages[1]).toBe('Current personality: researcher');
  });
});
