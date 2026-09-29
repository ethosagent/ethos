// Plan personality-presence-and-initiative §3 — the bound personality shown on
// Slack. Slack reacts with emoji NAMES, not glyphs: the personality's
// `display.emoji` is used when `slackEmojiName` knows its name, otherwise the
// configured `receiptReaction` (default `eyes`) — never dropped. And
// `mentionByName: true` lets a channel message that names the personality
// count as a mention.

import type { ChannelPresence } from '@ethosagent/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SlackAdapter, slackEmojiName } from '../adapter';
import { registerMessageEvents } from '../events/messages';
import { type RawSlackMessage, triageMessage } from '../routing/triage';
import { loadSlackSdk } from '../sdk';

beforeAll(async () => {
  await loadSlackSdk();
});

describe('slackEmojiName', () => {
  it('maps a common glyph to its Slack name', () => {
    expect(slackEmojiName('🦉')).toBe('owl');
    expect(slackEmojiName('🔥')).toBe('fire');
    // The emoji-presentation selector does not change the lookup.
    expect(slackEmojiName('❤️')).toBe('heart');
  });

  it('returns undefined for a glyph outside the table', () => {
    expect(slackEmojiName('🫎')).toBeUndefined();
    expect(slackEmojiName(undefined)).toBeUndefined();
  });
});

function makeAdapter(opts: { receiptReaction?: string; presence?: ChannelPresence } = {}) {
  const adapter = new SlackAdapter({
    botToken: 'xoxb-fake',
    appToken: 'xapp-fake',
    signingSecret: 'sig-fake',
    botKey: 'test-bot',
    ...(opts.receiptReaction ? { receiptReaction: opts.receiptReaction } : {}),
  });
  if (opts.presence) {
    const presence = opts.presence;
    adapter.setPresenceResolver(() => presence);
  }
  const calls: Array<{ op: 'add' | 'remove'; name: string }> = [];
  const stub = {
    add: vi.fn(async (args: { name: string }) => {
      calls.push({ op: 'add', name: args.name });
    }),
    remove: vi.fn(async (args: { name: string }) => {
      calls.push({ op: 'remove', name: args.name });
    }),
  };
  (adapter as unknown as { client: { reactions: typeof stub } }).client = {
    reactions: stub,
  } as never;
  const internals = adapter as unknown as {
    addReceiptReaction: (msg: unknown, meta?: { nameOnly?: boolean }) => void;
    clearReceiptReaction: (chatId: string, threadTs: string | undefined) => void;
  };
  return { internals, calls };
}

const inbound = { platform: 'slack', botKey: 'b', chatId: 'C1', messageId: '1.1' };

describe('Slack receipt reaction follows the bound personality', () => {
  it('with no presence, reacts `eyes` exactly as before', () => {
    const { internals, calls } = makeAdapter();
    internals.addReceiptReaction(inbound);
    expect(calls).toEqual([{ op: 'add', name: 'eyes' }]);
  });

  it("reacts with the personality's emoji name, and clears that same name", () => {
    const { internals, calls } = makeAdapter({ presence: { name: 'Owl', emoji: '🦉' } });
    internals.addReceiptReaction(inbound);
    internals.clearReceiptReaction('C1', undefined);
    expect(calls).toEqual([
      { op: 'add', name: 'owl' },
      { op: 'remove', name: 'owl' },
    ]);
  });

  it('falls back to the configured receiptReaction when the glyph has no known name', () => {
    const { internals, calls } = makeAdapter({
      presence: { name: 'Moose', emoji: '🫎' },
      receiptReaction: 'thinking_face',
    });
    internals.addReceiptReaction(inbound);
    expect(calls).toEqual([{ op: 'add', name: 'thinking_face' }]);
  });

  it('an explicitly configured receiptReaction wins over a known personality emoji', () => {
    const { internals, calls } = makeAdapter({
      presence: { name: 'Owl', emoji: '🦉' },
      receiptReaction: 'thinking_face',
    });
    internals.addReceiptReaction(inbound);
    expect(calls).toEqual([{ op: 'add', name: 'thinking_face' }]);
  });

  it('does not react to a message that reached the bot only by naming the personality', () => {
    const { internals, calls } = makeAdapter({ presence: { name: 'Owl', emoji: '🦉' } });
    internals.addReceiptReaction(inbound, { nameOnly: true });
    expect(calls).toEqual([]);
  });
});

describe('Slack mentionByName (triage)', () => {
  const channelPost = (text: string): RawSlackMessage => ({
    channel: 'C123',
    user: 'U1',
    text,
    ts: '111.222',
    channel_type: 'channel',
  });
  const ctx = (named: boolean) => ({
    botKey: 'bot-a',
    defaultChannelMode: 'mention_only' as const,
    ...(named
      ? {
          mentionsByName: (_c: string, _t: string | undefined, text: string) =>
            /\bowl\b/i.test(text),
        }
      : {}),
  });

  it('a message the name-check matches is a group mention', async () => {
    const result = await triageMessage(channelPost('hey Owl, status?'), ctx(true));
    expect(result.envelope?.isGroupMention).toBe(true);
    expect(result.envelope?.recordOnly).toBe(false);
  });

  it('flags a message that reaches the agent only because of the name', async () => {
    const named = await triageMessage(channelPost('hey Owl, status?'), ctx(true));
    expect(named.nameOnly).toBe(true);
    // In an `all` channel it would be answered anyway: not name-only.
    const all = await triageMessage(channelPost('hey Owl, status?'), {
      ...ctx(true),
      defaultChannelMode: 'all' as const,
    });
    expect(all.envelope?.recordOnly).toBe(false);
    expect(all.nameOnly).toBeUndefined();
    // A DM is addressed to the bot whatever it says.
    const dm = await triageMessage(
      { ...channelPost('hey Owl'), channel: 'D1', channel_type: 'im' },
      ctx(true),
    );
    expect(dm.nameOnly).toBeUndefined();
  });

  it('registerMessageEvents hands the name-only flag to onEnvelope', async () => {
    const handlers = new Map<string, (args: unknown) => Promise<void>>();
    const app = {
      message: (fn: (args: unknown) => Promise<void>) => handlers.set('message', fn),
      event: (name: string, fn: (args: unknown) => Promise<void>) =>
        handlers.set(`event:${name}`, fn),
    };
    const seen: Array<{ nameOnly?: boolean } | undefined> = [];
    registerMessageEvents(app as never, ctx(true), {
      onEnvelope: (_m, meta) => seen.push(meta),
    });
    await handlers.get('message')?.({ message: channelPost('hey Owl, status?') });
    expect(seen).toEqual([{ nameOnly: true }]);
  });

  it('without the name-check, the same message is dropped in mention_only', async () => {
    const result = await triageMessage(channelPost('hey Owl, status?'), ctx(false));
    expect(result.envelope).toBeUndefined();
  });
});

describe('Slack mentionByName (adapter)', () => {
  const adapterWith = (mentionByName: boolean | undefined) => {
    const adapter = new SlackAdapter({
      botToken: 'xoxb-fake',
      appToken: 'xapp-fake',
      signingSecret: 'sig-fake',
      botKey: 'test-bot',
      ...(mentionByName !== undefined ? { mentionByName } : {}),
    });
    adapter.setPresenceResolver(() => ({ name: 'Owl' }));
    return adapter as unknown as {
      mentionsByName: (channel: string, threadTs: string | undefined, text: string) => boolean;
    };
  };

  it('"hey Owl, …" matches only with mentionByName on; "Owlish" never does', () => {
    expect(adapterWith(true).mentionsByName('C1', undefined, 'hey Owl, status?')).toBe(true);
    expect(adapterWith(undefined).mentionsByName('C1', undefined, 'hey Owl, status?')).toBe(false);
    expect(adapterWith(true).mentionsByName('C1', undefined, 'that is Owlish')).toBe(false);
  });
});
