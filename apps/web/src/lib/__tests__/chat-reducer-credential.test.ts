// openclaw-9.5 item 1 — the chat store's side of the masked credential prompt.
// The store holds WHICH credential is missing and the message to resend; it
// never holds a value. The prompt closes on the next submission (the resend
// included), on dismiss, and on a session reset.

import type { CredentialRequiredEvent } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { applyAction, applyEvent, initialChatState } from '../chat-reducer';

const PROMPT: CredentialRequiredEvent = {
  type: 'credential_required',
  pluginId: 'weather',
  credentialKey: 'WEATHER_API_KEY',
  kind: 'api_key',
  label: 'Weather API key',
  pendingUserMessage: 'weather in Pune?',
};

describe('chat reducer — credential_required', () => {
  it('opens the prompt, and the refused turn’s empty done leaves it open', () => {
    let state = applyAction(initialChatState, {
      type: 'submit-user-message',
      id: 'u1',
      text: 'weather in Pune?',
      timestamp: 1,
    });
    state = applyEvent(state, PROMPT, 2);
    state = applyEvent(state, { type: 'done', text: '', turnCount: 0 }, 3);
    expect(state.pendingCredential).toEqual(PROMPT);
    expect(state.isStreaming).toBe(false);
  });

  it('keeps only the latest prompt', () => {
    let state = applyEvent(initialChatState, PROMPT, 1);
    const second = { ...PROMPT, credentialKey: 'OTHER', label: 'Other' };
    state = applyEvent(state, second, 2);
    expect(state.pendingCredential).toEqual(second);
  });

  it('closes on the next submission (the resend)', () => {
    let state = applyEvent(initialChatState, PROMPT, 1);
    state = applyAction(state, {
      type: 'submit-user-message',
      id: 'u2',
      text: PROMPT.pendingUserMessage,
      timestamp: 2,
    });
    expect(state.pendingCredential).toBeNull();
  });

  it('closes on dismiss and on reset', () => {
    const open = applyEvent(initialChatState, PROMPT, 1);
    expect(applyAction(open, { type: 'dismiss-credential' }).pendingCredential).toBeNull();
    expect(applyAction(open, { type: 'reset' }).pendingCredential).toBeNull();
  });

  it('stores nothing value-shaped anywhere in state', () => {
    const state = applyEvent(initialChatState, PROMPT, 1);
    expect(Object.keys(state.pendingCredential ?? {})).not.toContain('value');
  });
});
