// openclaw-9.5 item 1 — the chat store's side of the masked credential prompt.
// The store holds WHICH credential is missing and the message to resend; it
// never holds a value. The prompt closes on the next submission (the resend
// included), on dismiss, and on a session reset.

import type { CredentialRequiredEvent } from '@ethosagent/web-contracts';
import { describe, expect, it, vi } from 'vitest';
import { submitCredential } from '../../components/chat/CredentialCard';
import { applyAction, applyEvent, type ChatState, initialChatState } from '../chat-reducer';

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

// The resend is the refused turn asked again, so the chat shows the user's
// message ONCE: the resend's bubble replaces the refused turn's optimistic one
// (`replacesRefused`). A store that fails resends nothing, so the bubble stays.
describe('chat reducer — a credential resend shows the message once', () => {
  const TYPED = 'typed-credential-value';
  const userBubbles = (state: ChatState, text: string) =>
    state.messages.filter((m) => m.role === 'user' && m.content === text);

  function refused(): ChatState {
    let state = applyAction(initialChatState, {
      type: 'submit-user-message',
      id: 'u1',
      text: PROMPT.pendingUserMessage,
      timestamp: 1,
    });
    state = applyEvent(state, PROMPT, 2);
    return applyEvent(state, { type: 'done', text: '', turnCount: 0 }, 3);
  }

  // What Chat.tsx's `resend` does: useChat.sendMessage with `replacesRefused`.
  const resendInto = (get: () => ChatState, set: (s: ChatState) => void) =>
    vi.fn(async (text: string) => {
      set(
        applyAction(get(), {
          type: 'submit-user-message',
          id: 'u2',
          text,
          timestamp: 4,
          replacesRefused: true,
        }),
      );
    });

  it('refusal -> store -> resend leaves exactly one user bubble with that text', async () => {
    let state = refused();
    expect(userBubbles(state, PROMPT.pendingUserMessage)).toHaveLength(1);
    const resend = resendInto(
      () => state,
      (s) => {
        state = s;
      },
    );

    const error = await submitCredential(PROMPT, TYPED, {
      setCredential: async () => ({}),
      resend,
    });

    expect(error).toBeNull();
    expect(resend).toHaveBeenCalledOnce();
    const bubbles = userBubbles(state, PROMPT.pendingUserMessage);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]?.id).toBe('u2');
    expect(state.pendingCredential).toBeNull();
    expect(state.credentialRefusedMessageId).toBeNull();
    expect(JSON.stringify(state)).not.toContain(TYPED);
  });

  it('a failed setCredential resends nothing: the original bubble stays and the error is returned', async () => {
    let state = refused();
    const resend = resendInto(
      () => state,
      (s) => {
        state = s;
      },
    );

    const error = await submitCredential(PROMPT, TYPED, {
      setCredential: async () => {
        throw new Error('Plugin "weather" is not loaded');
      },
      resend,
    });

    // The card renders this string in its role="alert" line.
    expect(error).toBe('Plugin "weather" is not loaded');
    expect(resend).not.toHaveBeenCalled();
    const bubbles = userBubbles(state, PROMPT.pendingUserMessage);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]?.id).toBe('u1');
    expect(state.pendingCredential).toEqual(PROMPT);
  });

  it('an ordinary send with the same text is never merged into the refused bubble', () => {
    const state = applyAction(refused(), {
      type: 'submit-user-message',
      id: 'u3',
      text: PROMPT.pendingUserMessage,
      timestamp: 5,
    });
    expect(userBubbles(state, PROMPT.pendingUserMessage)).toHaveLength(2);
  });
});
