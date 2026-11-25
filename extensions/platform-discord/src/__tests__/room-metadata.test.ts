// Plan channel-prompts L7 — Discord stamps `channel.topic`/name (from the
// message's own cached channel object, no API call) and the effective mode only
// when `fetch_metadata` is on; `selfIdentity` is `client.user`.

import type { InboundMessage } from '@ethosagent/types';
import type { Client, Message } from 'discord.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { registerMessageHandler } from '../events/messages';
import { DiscordAdapter } from '../index';
import { loadDiscordSdk } from '../sdk';

beforeAll(async () => {
  await loadDiscordSdk();
});

function guildMessage(channel: Record<string, unknown>): Message {
  return {
    id: 'm1',
    channelId: 'C1',
    content: 'hello',
    createdTimestamp: 1_699_000_000_000,
    author: { id: 'U1', username: 'someone', bot: false },
    attachments: new Map(),
    mentions: { has: () => false, everyone: false, repliedUser: undefined },
    reference: undefined,
    channel: {
      isDMBased: () => false,
      isThread: () => false,
      parentId: null,
      messages: { fetch: async () => new Map() },
      ...channel,
    },
    react: async () => {},
  } as unknown as Message;
}

async function deliver(
  channel: Record<string, unknown>,
  fetchMetadata: boolean | undefined,
): Promise<InboundMessage> {
  const handlers = new Map<string, (message: Message) => Promise<void>>();
  const client = {
    on: (event: string, h: (message: Message) => Promise<void>) => handlers.set(event, h),
    user: undefined,
  } as unknown as Client;
  const envelopes: InboundMessage[] = [];
  registerMessageHandler({
    client,
    botKey: 'bot-1',
    defaultChannelMode: 'all',
    receiptReaction: '',
    ...(fetchMetadata !== undefined ? { fetchMetadata } : {}),
    onMessage: (m) => envelopes.push(m),
    onReceipt: () => {},
  });
  await handlers.get('messageCreate')?.(guildMessage(channel));
  await new Promise((r) => setTimeout(r, 0));
  expect(envelopes).toHaveLength(1);
  return envelopes[0] as InboundMessage;
}

describe('Discord room metadata', () => {
  it('stamps topic, name and channelMode when fetch_metadata is on', async () => {
    const e = await deliver({ name: 'deploys', topic: 'Release train' }, true);
    expect(e.roomMetadata).toEqual({ topic: 'Release train', name: 'deploys' });
    expect(e.channelMode).toBe('all');
  });

  it('stamps nothing when fetch_metadata is off or unset', async () => {
    for (const flag of [false, undefined]) {
      const e = await deliver({ name: 'deploys', topic: 'Release train' }, flag);
      expect(e.roomMetadata).toBeUndefined();
      expect(e.channelMode).toBeUndefined();
    }
  });

  it('a thread falls back to its parent topic', async () => {
    const e = await deliver(
      {
        name: 'post',
        topic: null,
        isThread: () => true,
        parentId: 'P1',
        parent: { topic: 'forum rules' },
      },
      true,
    );
    expect(e.roomMetadata).toEqual({ topic: 'forum rules', name: 'post' });
  });

  it('omits roomMetadata when the channel has neither topic nor name', async () => {
    const e = await deliver({}, true);
    expect(e.roomMetadata).toBeUndefined();
    expect(e.channelMode).toBe('all');
  });
});

describe('DiscordAdapter.selfIdentity', () => {
  it('is undefined until the client is logged in, then username and id', () => {
    const adapter = new DiscordAdapter({ token: 't', botKey: 'bot-1', defaultChannelMode: 'all' });
    expect(adapter.selfIdentity()).toBeUndefined();
    (adapter as unknown as { client: unknown }).client = { user: { username: 'ethos', id: '99' } };
    expect(adapter.selfIdentity()).toEqual({ handle: 'ethos', platformUserId: '99' });
  });
});

describe('DiscordAdapter.endTurn', () => {
  it('clears the thinking placeholder for the thread, else the channel', async () => {
    const adapter = new DiscordAdapter({ token: 't', botKey: 'bot-1', defaultChannelMode: 'all' });
    const del = vi.fn(async () => {});
    (adapter as unknown as { client: unknown }).client = {
      channels: { fetch: async () => ({ messages: { fetch: async () => ({ delete: del }) } }) },
    };
    const map = (adapter as unknown as { thinkingMessages: Map<string, { messageId: string }> })
      .thinkingMessages;
    map.set('T1', { messageId: 'p1' });
    await adapter.endTurn('C1', { threadId: 'T1' });
    expect(del).toHaveBeenCalledTimes(1);
    expect(map.has('T1')).toBe(false);
    await adapter.endTurn('C1');
    expect(del).toHaveBeenCalledTimes(1);
  });
});
