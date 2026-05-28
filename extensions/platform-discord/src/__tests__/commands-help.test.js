import { describe, expect, it } from 'vitest';
import { handleHelp } from '../commands/help';

describe('commands/help', () => {
  const ctx = {
    binding: { type: 'personality', name: 'default' },
    defaultChannelMode: 'mention_only',
  };
  const payload = {
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
});
