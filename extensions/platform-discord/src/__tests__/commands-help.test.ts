import { describe, expect, it } from 'vitest';
import type { CommandContext, CommandPayload } from '../commands';
import { handleHelp } from '../commands/help';

describe('commands/help', () => {
  const ctx: CommandContext = {
    binding: { type: 'personality', name: 'default' },
    defaultChannelMode: 'mention_only',
  };

  const payload: CommandPayload = {
    commandName: 'help',
    options: {},
    channelId: 'ch1',
    userId: 'user1',
  };

  it('returns an ephemeral embed', () => {
    const result = handleHelp(payload, ctx);
    expect(result.ephemeral).toBe(true);
    expect(result.embeds).toHaveLength(1);
  });

  it('embed contains slash command listing', () => {
    const result = handleHelp(payload, ctx);
    const embed = result.embeds[0];
    expect(embed.description).toContain('/ethos ask');
    expect(embed.description).toContain('/ethos help');
    expect(embed.description).toContain('/ethos personality');
  });

  it('embed shows binding info', () => {
    const result = handleHelp(payload, ctx);
    const embed = result.embeds[0];
    expect(embed.description).toContain('default');
    expect(embed.description).toContain('personality');
  });

  it('shows channel mode', () => {
    const result = handleHelp(payload, ctx);
    const embed = result.embeds[0];
    expect(embed.description).toContain('mention_only');
  });

  it('in a thread, asks the room hook for the parent channel plus the thread id', () => {
    const seen: unknown[] = [];
    handleHelp(
      { ...payload, channelId: 'thr1', threadId: 'thr1', parentChannelId: 'ch1', guildId: 'g1' },
      {
        ...ctx,
        roomModeDefault: (i) => {
          seen.push(i);
          return undefined;
        },
      },
    );
    expect(seen).toEqual([{ chatId: 'ch1', threadId: 'thr1', isDm: false }]);
  });
});
