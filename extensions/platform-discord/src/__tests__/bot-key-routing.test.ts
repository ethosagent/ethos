import { describe, expect, it } from 'vitest';
import { DiscordAdapter } from '../index';

describe('botKey routing', () => {
  it('derives a stable botKey from token', () => {
    const adapter = new DiscordAdapter({ token: 'test-token-123' });
    expect(adapter.botKey).toHaveLength(24);
    const adapter2 = new DiscordAdapter({ token: 'test-token-123' });
    expect(adapter.botKey).toBe(adapter2.botKey);
  });

  it('different tokens produce different botKeys', () => {
    const a1 = new DiscordAdapter({ token: 'bot-token-alpha' });
    const a2 = new DiscordAdapter({ token: 'bot-token-beta' });
    expect(a1.botKey).not.toBe(a2.botKey);
  });

  it('explicit botKey overrides derived default', () => {
    const adapter = new DiscordAdapter({ token: 'some-token', botKey: 'my-custom-key' });
    expect(adapter.botKey).toBe('my-custom-key');
  });

  it('adapter id includes platform and botKey', () => {
    const adapter = new DiscordAdapter({ token: 'token-abc' });
    expect(adapter.id).toBe(`discord:${adapter.botKey}`);
  });

  it('lane key format with threadId for threaded routing', () => {
    const adapter = new DiscordAdapter({ token: 'token' });
    const chatId = '123456789';
    const threadId = '987654321';
    const laneKey = `discord:${adapter.botKey}:${chatId}:${threadId}`;
    expect(laneKey).toContain(adapter.botKey);
    expect(laneKey).toContain(threadId);
  });
});
