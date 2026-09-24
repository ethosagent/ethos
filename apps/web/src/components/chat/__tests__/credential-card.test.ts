// openclaw-9.5 item 1 — the masked credential prompt in the chat pane.
//
// Two halves: the markup (a password field with autocomplete off, naming the
// plugin, key, label and description), asserted with `renderToStaticMarkup`
// like `clarify-card-takeover.test.ts`; and `submitCredential`'s order — store
// through `plugins.setCredential` FIRST, resend `pendingUserMessage` only on
// success, and never resend when the store is refused.

import type { CredentialRequiredEvent } from '@ethosagent/web-contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CredentialCard, submitCredential } from '../CredentialCard';

const REQUEST: CredentialRequiredEvent = {
  type: 'credential_required',
  pluginId: 'weather',
  credentialKey: 'WEATHER_API_KEY',
  kind: 'api_key',
  label: 'Weather API key',
  description: 'From your weather dashboard',
  pendingUserMessage: 'weather in Pune?',
};

describe('CredentialCard markup', () => {
  const html = renderToStaticMarkup(
    createElement(CredentialCard, {
      request: REQUEST,
      resend: async () => {},
      onDismiss: () => {},
    }),
  );

  it('renders a masked input with autocomplete off', () => {
    expect(html).toMatch(/<input[^>]*type="password"/);
    expect(html).toMatch(/<input[^>]*autocomplete="off"/i);
  });

  it('names the plugin, key, label and description', () => {
    expect(html).toContain('weather');
    expect(html).toContain('WEATHER_API_KEY');
    expect(html).toContain('Weather API key');
    expect(html).toContain('From your weather dashboard');
  });
});

describe('submitCredential', () => {
  it('stores through setCredential, then resends the pending message', async () => {
    const calls: string[] = [];
    const setCredential = vi.fn(async () => {
      calls.push('set');
      return { ok: true as const };
    });
    const resend = vi.fn(async () => {
      calls.push('resend');
    });

    const error = await submitCredential(REQUEST, 'sk-123', { setCredential, resend });

    expect(error).toBeNull();
    expect(setCredential).toHaveBeenCalledWith({
      pluginId: 'weather',
      key: 'WEATHER_API_KEY',
      value: 'sk-123',
    });
    expect(resend).toHaveBeenCalledWith('weather in Pune?');
    expect(calls).toEqual(['set', 'resend']);
  });

  it('returns the RPC error and does NOT resend when the store is refused', async () => {
    const setCredential = vi.fn(async () => {
      throw new Error('Plugin "weather" is not loaded');
    });
    const resend = vi.fn(async () => {});

    const error = await submitCredential(REQUEST, 'sk-123', { setCredential, resend });

    expect(error).toBe('Plugin "weather" is not loaded');
    expect(resend).not.toHaveBeenCalled();
  });

  it('never passes the value to resend', async () => {
    const resend = vi.fn(async (_text: string) => {});
    await submitCredential(REQUEST, 'sk-secret', {
      setCredential: async () => ({ ok: true as const }),
      resend,
    });
    expect(JSON.stringify(resend.mock.calls)).not.toContain('sk-secret');
  });
});
