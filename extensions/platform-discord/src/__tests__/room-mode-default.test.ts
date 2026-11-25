// Plan channel-prompts L12: room config default reply mode in Discord's triage.

import type { InboundMessage } from '@ethosagent/types';
import type { Client, Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { registerMessageHandler } from '../events/messages';
import type { RawDiscordMessage, TriageContext } from '../routing/triage';
import { resolveChannelModeSource, triageMessage } from '../routing/triage';

const post: RawDiscordMessage = {
  channelId: 'ch1',
  userId: 'u1',
  text: 'hello room',
  messageId: 'm1',
  isDm: false,
  isThread: false,
  isMention: false,
  sentAt: 1_700_000_000_000,
  raw: {},
};

const override = (mode: string) =>
  ({ get: () => ({ mode, updatedAt: 1 }) }) as unknown as TriageContext['channelOverrides'];

const ctx = (extra: Partial<TriageContext> = {}): TriageContext => ({
  botKey: 'bot-a',
  defaultChannelMode: 'mention_only',
  ...extra,
});

describe('discord room mode default (L12)', () => {
  it('uses the room mode when there is no runtime override', async () => {
    const r = await triageMessage(post, ctx({ roomModeDefault: () => 'all' }));
    expect(r.effectiveMode).toBe('all');
    expect(r.modeSource).toBe('room');
    expect(r.envelope?.recordOnly).toBe(false);
  });

  it('looks the room up by the parent channel, with the thread id', async () => {
    const seen: unknown[] = [];
    await triageMessage(
      { ...post, channelId: 'thr1', isThread: true, threadId: 'thr1', parentChannelId: 'ch1' },
      ctx({
        roomModeDefault: (i) => {
          seen.push(i);
          return undefined;
        },
      }),
    );
    expect(seen).toEqual([{ chatId: 'ch1', threadId: 'thr1', isDm: false }]);
  });

  it('a runtime override beats the room mode', async () => {
    const r = await triageMessage(
      post,
      ctx({ channelOverrides: override('observe'), roomModeDefault: () => 'all' }),
    );
    expect(r.effectiveMode).toBe('observe');
    expect(r.modeSource).toBe('runtime');
    expect(r.envelope?.recordOnly).toBe(true);
  });

  it('falls to the platform default, then the built-in, when the room has no mode', async () => {
    const platform = await triageMessage(
      post,
      ctx({
        defaultChannelMode: 'observe',
        defaultChannelModeConfigured: true,
        roomModeDefault: () => undefined,
      }),
    );
    expect(platform.modeSource).toBe('platform');
    expect(platform.effectiveMode).toBe('observe');
    const builtin = await triageMessage(post, ctx({ roomModeDefault: () => undefined }));
    expect(builtin.modeSource).toBe('default');
  });

  it('an unreadable room mode fails closed', async () => {
    const r = await triageMessage(post, ctx({ roomModeDefault: () => 'regex_match' }));
    expect(r.envelope).toBeUndefined();
    expect(r.drop).toBe('channel_mode');
    const mentioned = await triageMessage(
      { ...post, isMention: true },
      ctx({ roomModeDefault: () => 'regex_match' }),
    );
    expect(mentioned.envelope).toBeUndefined();
  });

  it('a DM is not a room: the room mode cannot silence it', async () => {
    const r = await triageMessage(
      { ...post, isDm: true },
      ctx({ roomModeDefault: () => 'observe' }),
    );
    expect(r.envelope?.recordOnly).toBe(false);
  });

  it('resolveChannelModeSource passes isDm through', () => {
    expect(
      resolveChannelModeSource('c', ctx({ roomModeDefault: (i) => (i.isDm ? 'all' : 'observe') }), {
        isDm: true,
      }),
    ).toEqual({ mode: 'all', source: 'room' });
  });
});

describe('discord channelModeSource stamp (L12)', () => {
  async function deliver(extra: Record<string, unknown>): Promise<InboundMessage> {
    const handlers = new Map<string, (message: Message) => Promise<void>>();
    const client = {
      on: (e: string, h: (message: Message) => Promise<void>) => handlers.set(e, h),
      user: undefined,
    } as unknown as Client;
    const envelopes: InboundMessage[] = [];
    registerMessageHandler({
      client,
      botKey: 'bot-1',
      defaultChannelMode: 'mention_only',
      receiptReaction: '',
      onMessage: (m) => envelopes.push(m),
      onReceipt: () => {},
      ...extra,
    });
    await handlers.get('messageCreate')?.({
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
      },
      react: async () => {},
    } as unknown as Message);
    await new Promise((r) => setTimeout(r, 0));
    expect(envelopes).toHaveLength(1);
    return envelopes[0] as InboundMessage;
  }

  it('stamps mode and source when room policies configure the platform, without fetch_metadata', async () => {
    const e = await deliver({ roomModeDefault: () => 'all' });
    expect(e.channelMode).toBe('all');
    expect(e.channelModeSource).toBe('room');
    expect(e.roomMetadata).toBeUndefined();
  });

  it('stamps nothing without room policies or fetch_metadata', async () => {
    const e = await deliver({ defaultChannelMode: 'all' });
    expect(e.channelMode).toBeUndefined();
    expect(e.channelModeSource).toBeUndefined();
  });
});
