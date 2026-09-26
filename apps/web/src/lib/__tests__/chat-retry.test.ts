import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../chat-reducer';
import { retryTurnText } from '../chat-retry';

// A3 — the error banner's Retry re-sends the last user message, but only when
// that is the WHOLE of what was sent. The user bubble keeps render-only
// attachment metadata (no bytes), so a send that carried attachments is not
// recoverable: `retryTurnText` returns null and the banner hides Retry rather
// than silently re-asking a degraded, text-only question.

function user(id: string, content: string, withAttachment = false): ChatMessage {
  return {
    id,
    role: 'user',
    content,
    timestamp: 1,
    ...(withAttachment
      ? {
          attachments: [
            {
              localId: 'a1',
              state: 'ready' as const,
              type: 'image' as const,
              name: 'shot.png',
              mimeType: 'image/png',
              sizeBytes: 10,
            },
          ],
        }
      : {}),
  };
}

function assistant(id: string): ChatMessage {
  return { id, role: 'assistant', timestamp: 2, blocks: [{ kind: 'text', content: 'hi' }] };
}

describe('retryTurnText', () => {
  it('returns the last user message text for a text-only send', () => {
    expect(retryTurnText([user('u1', 'first'), assistant('a1'), user('u2', 'second')])).toBe(
      'second',
    );
  });

  it('returns null when the last user send carried attachments (bytes unrecoverable)', () => {
    expect(retryTurnText([user('u1', 'look at this', true), assistant('a1')])).toBeNull();
  });

  it('returns null when no user message exists', () => {
    expect(retryTurnText([assistant('a1')])).toBeNull();
    expect(retryTurnText([])).toBeNull();
  });
});
