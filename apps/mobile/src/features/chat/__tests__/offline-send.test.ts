import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import { useChatStore } from '../../../state/chat-store';
import { sendMessage } from '../session';

function fakeRpc() {
  const chat = {
    send: vi.fn(async () => ({ sessionId: 's1', turnId: 't1' })),
    steer: vi.fn(async () => ({ ok: true })),
  };
  return { chat, api: { chat } as unknown as Parameters<typeof sendMessage>[0] };
}

beforeEach(() => useChatStore.getState().reset(null));

describe('send while offline (case 8)', () => {
  it('never calls chat.send, leaves a resolved row and queues nothing', async () => {
    const { chat, api } = fakeRpc();
    const id = await sendMessage(api, {
      text: 'deploy it',
      online: false,
      personalityId: 'engineer',
    });
    expect(id).toBeNull();
    expect(chat.send).not.toHaveBeenCalled();
    expect(useChatStore.getState().notices).toEqual([
      expect.objectContaining({ glyph: '✗', word: 'offline', result: 'not sent' }),
    ]);
    expect(useChatStore.getState().chat.messages).toEqual([]);

    // Back online, only the next message goes — the refused one is not replayed.
    await sendMessage(api, { text: 'again', online: true, personalityId: 'engineer' });
    expect(chat.send).toHaveBeenCalledTimes(1);
    expect(chat.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'again', personalityId: 'engineer' }),
    );
  });

  it('a turn in flight is steered, not sent', async () => {
    const { chat, api } = fakeRpc();
    useChatStore.getState().reset('s1');
    useChatStore.setState((s) => ({ chat: { ...s.chat, isStreaming: true } }));
    const id = await sendMessage(api, {
      text: 'use the staging db',
      online: true,
      personalityId: null,
    });
    expect(id).toBe('s1');
    expect(chat.steer).toHaveBeenCalledWith({ sessionId: 's1', text: 'use the staging db' });
    expect(chat.send).not.toHaveBeenCalled();
  });
});
