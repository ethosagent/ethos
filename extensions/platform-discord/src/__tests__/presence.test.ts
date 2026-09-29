// Plan personality-presence-and-initiative §3 — the bound personality shown on
// Discord, driven through the real `registerMessageHandler` with a fake
// discord.js client. Discord reacts with unicode, so the personality's
// `display.emoji` is used as-is; a refusal falls back to `receiptReaction`
// rather than dropping the reaction. `mentionByName: true` makes a message
// that names the personality a mention.

import type { ChannelPresence } from '@ethosagent/core';
import type { InboundMessage } from '@ethosagent/types';
import type { Client, Message } from 'discord.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChannelMode } from '../config';
import { registerMessageHandler } from '../events/messages';
import { DiscordAdapter } from '../index';
import { loadDiscordSdk } from '../sdk';

beforeAll(async () => {
  await loadDiscordSdk();
});

function guildMessage(content: string, react: (emoji: string) => Promise<void>): Message {
  return {
    id: 'm1',
    channelId: 'C1',
    content,
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
    },
    react,
  } as unknown as Message;
}

interface Opts {
  mode?: ChannelMode;
  text?: string;
  presence?: ChannelPresence;
  mentionByName?: boolean;
  reactFails?: (emoji: string) => boolean;
}

async function deliver(opts: Opts) {
  const handlers = new Map<string, (message: Message) => Promise<void>>();
  const client = {
    on: (event: string, handler: (message: Message) => Promise<void>) => {
      handlers.set(event, handler);
    },
    user: undefined,
  } as unknown as Client;
  const envelopes: InboundMessage[] = [];
  const reacted: string[] = [];
  const receipts: Array<{ messageId: string; reactions: string[] }> = [];
  const react = vi.fn(async (emoji: string) => {
    reacted.push(emoji);
    if (opts.reactFails?.(emoji)) throw new Error('Unknown Emoji');
  });
  const presence = opts.presence;

  registerMessageHandler({
    client,
    botKey: 'bot-1',
    defaultChannelMode: opts.mode ?? 'all',
    receiptReaction: '👀',
    ...(presence ? { presence: () => presence } : {}),
    ...(opts.mentionByName !== undefined ? { mentionByName: opts.mentionByName } : {}),
    onMessage: (msg: InboundMessage) => envelopes.push(msg),
    onReceipt: (_channelId: string, messageId: string, reactions: string[]) => {
      receipts.push({ messageId, reactions });
    },
  });
  await handlers.get('messageCreate')?.(guildMessage(opts.text ?? 'hello', react));
  await new Promise((r) => setTimeout(r, 0));
  return { envelopes, reacted, receipts };
}

describe('Discord receipt reaction follows the bound personality', () => {
  it('with no presence, reacts 👀 exactly as before', async () => {
    const { reacted } = await deliver({});
    expect(reacted).toEqual(['👀']);
  });

  it("reacts with the personality's emoji", async () => {
    const { reacted, receipts } = await deliver({ presence: { name: 'Owl', emoji: '🦉' } });
    expect(reacted).toEqual(['🦉']);
    // Both candidates are tracked so the clear removes whichever landed.
    expect(receipts).toEqual([{ messageId: 'm1', reactions: ['🦉', '👀'] }]);
  });

  it('falls back to receiptReaction when Discord refuses the emoji — never drops it', async () => {
    const { reacted } = await deliver({
      presence: { name: 'Owl', emoji: '🦉' },
      reactFails: (e) => e === '🦉',
    });
    expect(reacted).toEqual(['🦉', '👀']);
  });
});

describe('Discord mentionByName', () => {
  const owl = { name: 'Owl' };

  it('"hey Owl, …" is a mention only with mentionByName on', async () => {
    const on = await deliver({
      mode: 'mention_only',
      presence: owl,
      mentionByName: true,
      text: 'hey Owl, status?',
    });
    expect(on.envelopes).toHaveLength(1);
    expect(on.envelopes[0]?.isGroupMention).toBe(true);

    const off = await deliver({ mode: 'mention_only', presence: owl, text: 'hey Owl, status?' });
    expect(off.envelopes).toHaveLength(0);
  });

  it('"Owlish" does not match', async () => {
    const { envelopes } = await deliver({
      mode: 'mention_only',
      presence: owl,
      mentionByName: true,
      text: 'very Owlish',
    });
    expect(envelopes).toHaveLength(0);
  });
});

describe('Discord receipt reaction is for messages addressed to the bot', () => {
  const owl = { name: 'Owl', emoji: '🦉' };

  it('does not react to a guild message that only names the personality', async () => {
    // The channel filter may still drop it (a non-allowlisted member saying
    // "Owl"), and nothing would ever clear a reaction placed on it.
    const { envelopes, reacted, receipts } = await deliver({
      mode: 'mention_only',
      presence: owl,
      mentionByName: true,
      text: 'hey Owl, status?',
    });
    expect(envelopes).toHaveLength(1);
    expect(reacted).toEqual([]);
    expect(receipts).toEqual([]);
  });

  it('still reacts when the channel would answer without the name (`all`)', async () => {
    const { reacted } = await deliver({
      mode: 'all',
      presence: owl,
      mentionByName: true,
      text: 'hey Owl, status?',
    });
    expect(reacted).toEqual(['🦉']);
  });
});

describe('Discord explicit receiptReaction', () => {
  async function adapterDelivery(receiptReaction: string | undefined): Promise<string[]> {
    const adapter = new DiscordAdapter({
      token: 'token',
      botKey: 'bot-1',
      defaultChannelMode: 'all',
      ...(receiptReaction !== undefined ? { receiptReaction } : {}),
    });
    const handlers = new Map<string, (message: Message) => Promise<void>>();
    (adapter as unknown as { client: unknown }).client = {
      on: (event: string, handler: (message: Message) => Promise<void>) => {
        handlers.set(event, handler);
      },
      login: async () => 'ok',
      user: undefined,
    };
    adapter.setPresenceResolver(() => ({ name: 'Owl', emoji: '🦉' }));
    await adapter.start();
    const reacted: string[] = [];
    await handlers.get('messageCreate')?.(
      guildMessage('hello', async (emoji) => {
        reacted.push(emoji);
      }),
    );
    return reacted;
  }

  it('a configured receiptReaction wins over the personality emoji', async () => {
    expect(await adapterDelivery('✅')).toEqual(['✅']);
  });

  it('absent, the personality emoji is used', async () => {
    expect(await adapterDelivery(undefined)).toEqual(['🦉']);
  });
});
