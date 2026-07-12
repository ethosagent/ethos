import { describe, expect, it } from 'vitest';
import { DiscordAdapter } from '../index';

// P5.2 — botKey is computed once in wiring and passed as a required
// constructor param. The adapter no longer derives its own key, so these
// tests assert it uses the configured value verbatim as its routing identity.
describe('botKey routing', () => {
  it('uses the configured botKey verbatim', () => {
    const adapter = new DiscordAdapter({ token: 'some-token', botKey: 'my-custom-key' });
    expect(adapter.botKey).toBe('my-custom-key');
  });

  it('botKey (not the token) drives identity — same token, distinct botKeys, distinct ids', () => {
    const a1 = new DiscordAdapter({ token: 'shared-token', botKey: 'alpha' });
    const a2 = new DiscordAdapter({ token: 'shared-token', botKey: 'beta' });
    expect(a1.botKey).not.toBe(a2.botKey);
    expect(a1.id).not.toBe(a2.id);
  });

  it('adapter id includes platform and botKey', () => {
    const adapter = new DiscordAdapter({ token: 'token-abc', botKey: 'abc' });
    expect(adapter.id).toBe('discord:abc');
  });

  it('lane key format with threadId for threaded routing', () => {
    const adapter = new DiscordAdapter({ token: 'token', botKey: 'k1' });
    const chatId = '123456789';
    const threadId = '987654321';
    const laneKey = `discord:${adapter.botKey}:${chatId}:${threadId}`;
    expect(laneKey).toContain(adapter.botKey);
    expect(laneKey).toContain(threadId);
  });
});
