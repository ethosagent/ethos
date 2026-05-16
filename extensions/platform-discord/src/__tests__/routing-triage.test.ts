import { describe, expect, it } from 'vitest';
import type { TriageContext } from '../routing/triage';
import { resolveChannelMode, stripMentions, triageMessage } from '../routing/triage';

describe('routing triage', () => {
  const ctx: TriageContext = {
    botKey: 'test-bot',
    defaultChannelMode: 'mention_only',
  };

  it('triageMessage drops empty text', async () => {
    const result = await triageMessage(
      {
        channelId: 'ch1',
        userId: 'user1',
        text: '',
        messageId: 'msg1',
        isDm: false,
        isThread: false,
        isMention: false,
        raw: {},
      },
      ctx,
    );
    expect(result.drop).toBe('no_text');
  });

  it('triageMessage produces envelope for DMs', async () => {
    const result = await triageMessage(
      {
        channelId: 'dm-ch',
        userId: 'user1',
        text: 'hello',
        messageId: 'msg1',
        isDm: true,
        isThread: false,
        isMention: false,
        raw: {},
      },
      ctx,
    );
    expect(result.envelope).toBeDefined();
    expect(result.envelope?.platform).toBe('discord');
    expect(result.envelope?.botKey).toBe('test-bot');
    expect(result.envelope?.isDm).toBe(true);
  });

  it('triageMessage drops non-DM non-mention in mention_only mode', async () => {
    const result = await triageMessage(
      {
        channelId: 'ch1',
        userId: 'user1',
        text: 'hello',
        messageId: 'msg1',
        isDm: false,
        isThread: false,
        isMention: false,
        raw: {},
      },
      ctx,
    );
    expect(result.drop).toBe('channel_mode');
  });

  it('triageMessage accepts @mentions in mention_only mode', async () => {
    const result = await triageMessage(
      {
        channelId: 'ch1',
        userId: 'user1',
        text: '<@bot123> what is this?',
        messageId: 'msg1',
        isDm: false,
        isThread: false,
        isMention: true,
        raw: {},
      },
      ctx,
    );
    expect(result.envelope).toBeDefined();
    expect(result.envelope?.isGroupMention).toBe(true);
  });

  it('triageMessage sets threadId for threaded messages', async () => {
    const result = await triageMessage(
      {
        channelId: 'thread-ch',
        userId: 'user1',
        text: 'reply in thread',
        messageId: 'msg1',
        isDm: true,
        isThread: true,
        threadId: 'thread-ch',
        parentChannelId: 'parent-ch',
        isMention: false,
        raw: {},
      },
      ctx,
    );
    expect(result.envelope?.chatId).toBe('parent-ch');
    expect(result.envelope?.threadId).toBe('thread-ch');
  });

  it('resolveChannelMode uses default when no override', () => {
    expect(resolveChannelMode('ch1', ctx)).toBe('mention_only');
  });

  it('stripMentions removes Discord mentions', () => {
    expect(stripMentions('<@123> hi').trim()).toBe('hi');
  });
});
