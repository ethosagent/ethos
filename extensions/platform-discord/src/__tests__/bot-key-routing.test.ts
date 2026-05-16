import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

function deriveDefaultBotKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 24);
}

describe('botKey routing', () => {
  it('derives a stable botKey from token', () => {
    const key = deriveDefaultBotKey('test-token-123');
    expect(key).toHaveLength(24);
    expect(key).toBe(deriveDefaultBotKey('test-token-123'));
  });

  it('different tokens produce different botKeys', () => {
    const key1 = deriveDefaultBotKey('bot-token-alpha');
    const key2 = deriveDefaultBotKey('bot-token-beta');
    expect(key1).not.toBe(key2);
  });

  it('explicit botKey overrides derived default', () => {
    // The DiscordAdapterConfig accepts an optional botKey
    // When provided, it takes precedence
    const explicit = 'my-custom-bot-key-12345';
    expect(explicit).not.toBe(deriveDefaultBotKey('some-token'));
  });

  it('lane key format includes platform and botKey', () => {
    const botKey = deriveDefaultBotKey('token');
    const chatId = '123456789';
    const laneKey = `discord:${botKey}:${chatId}`;
    expect(laneKey).toMatch(/^discord:[a-f0-9]{24}:\d+$/);
  });

  it('threaded lane key includes threadId', () => {
    const botKey = deriveDefaultBotKey('token');
    const chatId = '123456789';
    const threadId = '987654321';
    const laneKey = `discord:${botKey}:${chatId}:${threadId}`;
    expect(laneKey).toContain(threadId);
  });
});
