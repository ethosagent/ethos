import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../chat-reducer';
import { isLocalUserMessageId, rewindTargetFor } from '../rewind';

// A prompt sent in this tab keeps its `user-<ms>` id until reload, so the
// server cannot resolve it by id. The target falls back to "N prompts back
// from the latest", counted over the bubbles the server also counts.

function user(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: 1 };
}
function steer(id: string): ChatMessage {
  return { id, role: 'user', content: 's', timestamp: 1, isSteer: true };
}
function failed(id: string): ChatMessage {
  return { id, role: 'user', content: 'f', timestamp: 1, status: 'failed', error: 'x' };
}
function asst(): ChatMessage {
  return { id: 'a1', role: 'assistant', timestamp: 2, blocks: [{ kind: 'text', content: 'hi' }] };
}

describe('isLocalUserMessageId', () => {
  it('recognises the optimistic id minted in sendMessage', () => {
    expect(isLocalUserMessageId('user-1731600000000')).toBe(true);
    expect(isLocalUserMessageId('9b1f-uuid')).toBe(false);
  });
});

describe('rewindTargetFor', () => {
  it('uses the persisted id when it has one', () => {
    expect(rewindTargetFor([user('9b1f-uuid', 'a')], '9b1f-uuid')).toEqual({
      messageId: '9b1f-uuid',
    });
  });

  it('counts back over user bubbles, skipping steers and failed sends, for a local id', () => {
    const msgs = [
      user('u1', 'a'),
      asst(),
      user('user-1', 'b'),
      steer('user-2'),
      failed('user-3'),
      user('user-4', 'c'),
    ];
    expect(rewindTargetFor(msgs, 'user-1')).toEqual({ turnsBack: 2 });
    expect(rewindTargetFor(msgs, 'user-4')).toEqual({ turnsBack: 1 });
  });

  it('returns null for an unknown id, a steer or a failed send', () => {
    const msgs = [user('user-1', 'a'), steer('user-2'), failed('user-3')];
    expect(rewindTargetFor(msgs, 'nope')).toBeNull();
    expect(rewindTargetFor(msgs, 'user-2')).toBeNull();
    expect(rewindTargetFor(msgs, 'user-3')).toBeNull();
  });
});

describe('rewindPromptAt', () => {
  it('picks the Nth prompt from the end, skipping steers and failed sends', async () => {
    const { rewindPromptAt } = await import('../rewind');
    const msgs = [user('u1', 'a'), asst(), steer('s1'), failed('f1'), user('u2', 'b'), asst()];
    expect(rewindPromptAt(msgs, 1)?.id).toBe('u2');
    expect(rewindPromptAt(msgs, 2)?.id).toBe('u1');
    expect(rewindPromptAt(msgs, 3)).toBeNull();
  });
});
