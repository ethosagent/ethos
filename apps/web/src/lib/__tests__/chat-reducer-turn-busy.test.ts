import { describe, expect, it } from 'vitest';
import { applyAction, applyEvent, initialChatState, isTurnBusy } from '../chat-reducer';

const NOW = 1000;
const submit = (state = initialChatState) =>
  applyAction(state, { type: 'submit-user-message', id: 'u1', text: 'hi', timestamp: NOW });

describe('isTurnBusy', () => {
  it('is false when idle', () => {
    expect(isTurnBusy(initialChatState)).toBe(false);
  });

  it('is true between send and the first stream event (isStreaming is still false)', () => {
    const sent = submit();
    expect(sent.isStreaming).toBe(false);
    expect(isTurnBusy(sent)).toBe(true);
  });

  it('is true while streaming and false again once the turn is done', () => {
    const streaming = applyEvent(submit(), { type: 'text_delta', text: 'a' }, NOW);
    expect(isTurnBusy(streaming)).toBe(true);
    expect(isTurnBusy(applyEvent(streaming, { type: 'done', text: 'a', turnCount: 1 }, NOW))).toBe(
      false,
    );
  });

  it('is false again after a failed send', () => {
    const failed = applyAction(submit(), {
      type: 'send-failed',
      userMessageId: 'u1',
      error: 'nope',
    });
    expect(isTurnBusy(failed)).toBe(false);
  });
});
