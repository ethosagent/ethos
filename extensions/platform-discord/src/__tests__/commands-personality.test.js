import { describe, expect, it } from 'vitest';
import { handlePersonality } from '../commands/personality';

describe('commands/personality', () => {
  const baseCtx = {
    binding: { type: 'personality', name: 'default' },
    defaultChannelMode: 'mention_only',
    personalityCard: {
      get: async () => ({
        name: 'Atlas',
        description: 'An explorer',
        model: 'claude-opus-4-6',
        toolset: ['file', 'web'],
      }),
      list: async () => [
        { name: 'Atlas', description: 'An explorer' },
        { name: 'Nova', description: 'A builder' },
      ],
    },
  };
  it('lists personalities when action is list', async () => {
    const payload = {
      commandName: 'personality',
      options: { action: 'list' },
      channelId: 'ch1',
      userId: 'user1',
    };
    const result = await handlePersonality(payload, baseCtx);
    expect(result.ephemeral).toBe(true);
    expect(result.embeds[0].description).toContain('Atlas');
    expect(result.embeds[0].description).toContain('Nova');
  });
  it('shows active personality when no action', async () => {
    const payload = {
      commandName: 'personality',
      options: {},
      channelId: 'ch1',
      userId: 'user1',
    };
    const result = await handlePersonality(payload, baseCtx);
    expect(result.ephemeral).toBe(true);
  });
  it('returns not available when no personalityCard reader', async () => {
    const ctx = {
      binding: { type: 'personality', name: 'default' },
      defaultChannelMode: 'mention_only',
    };
    const payload = {
      commandName: 'personality',
      options: {},
      channelId: 'ch1',
      userId: 'user1',
    };
    const result = await handlePersonality(payload, ctx);
    expect(result.embeds[0].description).toContain('not available');
  });
});
