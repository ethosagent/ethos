// openclaw-9.5 item 1 — the `credential_required` SSE event is a prompt for a
// masked credential, never a carrier of one. These tests pin that the event
// survives a round trip through the shared `SseEventSchema` union intact, and
// that a stray value-shaped key is stripped rather than passed to the client.

import { describe, expect, it } from 'vitest';
import { CredentialRequiredEventSchema, SseEventSchema } from '../events';

const EVENT = {
  type: 'credential_required' as const,
  pluginId: 'weather',
  credentialKey: 'WEATHER_API_KEY',
  kind: 'api_key' as const,
  label: 'Weather API key',
  description: 'From your weather.example dashboard',
  authUrl: 'https://weather.example/keys',
  pendingUserMessage: 'what is the weather in Pune?',
};

describe('CredentialRequiredEventSchema', () => {
  it('round-trips through the SSE union with every field intact', () => {
    const parsed = SseEventSchema.parse(JSON.parse(JSON.stringify(EVENT)));
    expect(parsed).toEqual(EVENT);
  });

  it('accepts the minimal shape — description and authUrl are optional', () => {
    const { description: _description, authUrl: _authUrl, ...minimal } = EVENT;
    const parsed = CredentialRequiredEventSchema.parse(minimal);
    expect(parsed.description).toBeUndefined();
    expect(parsed.authUrl).toBeUndefined();
  });

  it('strips any value-shaped key — the event never carries a secret', () => {
    const parsed = SseEventSchema.parse({ ...EVENT, value: 'sk-live-123' });
    expect(Object.keys(parsed)).not.toContain('value');
    expect(JSON.stringify(parsed)).not.toContain('sk-live-123');
  });

  it('rejects a kind outside the union', () => {
    expect(CredentialRequiredEventSchema.safeParse({ ...EVENT, kind: 'password' }).success).toBe(
      false,
    );
  });

  it('rejects an event missing pendingUserMessage', () => {
    const { pendingUserMessage: _p, ...rest } = EVENT;
    expect(SseEventSchema.safeParse(rest).success).toBe(false);
  });
});
