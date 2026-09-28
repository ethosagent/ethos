// UBP-017 — a turn inside a Discord thread showed typing and its "Thinking…"
// placeholder in the PARENT channel (the gateway's chatId), and a streamed
// edit fetched the message from the parent, where it does not exist. The
// optional `opts.threadId` on `sendTyping`/`editMessage` now targets the thread.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DiscordAdapter } from '../index';
import { loadDiscordSdk } from '../sdk';

interface FakeChannel {
  id: string;
  sent: Array<{ content?: string }>;
  deleted: string[];
  edited: Array<[string, string]>;
  typing: number;
}

function makeAdapter() {
  const adapter = new DiscordAdapter({ token: 'fake-token', botKey: 'test-bot' });
  const channels = new Map<string, FakeChannel>();
  let n = 0;
  const channelFor = (id: string) => {
    const existing = channels.get(id);
    if (existing) return existing;
    const state: FakeChannel = { id, sent: [], deleted: [], edited: [], typing: 0 };
    channels.set(id, state);
    return state;
  };
  const fetch = vi.fn(async (id: string) => {
    const state = channelFor(id);
    return {
      send: async (payload: { content?: string }) => {
        state.sent.push(payload);
        n++;
        return { id: `${id}-m${n}` };
      },
      sendTyping: async () => {
        state.typing++;
      },
      messages: {
        fetch: async (mid: string) => {
          if (!mid.startsWith(`${id}-`)) throw new Error('Unknown Message');
          return {
            delete: async () => {
              state.deleted.push(mid);
            },
            edit: async (text: string) => {
              state.edited.push([mid, text]);
              return { id: mid };
            },
          };
        },
      },
    };
  });
  (adapter as unknown as { client: { channels: unknown } }).client = {
    channels: { fetch },
  } as never;
  return { adapter, channelFor, fetch };
}

describe('DiscordAdapter thread-targeted typing and edits', () => {
  beforeAll(async () => {
    await loadDiscordSdk();
  });

  it('sends typing and the Thinking… placeholder into the thread, not the parent', async () => {
    const { adapter, channelFor } = makeAdapter();
    await adapter.sendTyping('parent', { threadId: 'thread-1' });
    expect(channelFor('thread-1').typing).toBe(1);
    expect(channelFor('thread-1').sent.map((p) => p.content)).toEqual(['Thinking…']);
    expect(channelFor('parent').typing).toBe(0);
    expect(channelFor('parent').sent).toEqual([]);
  });

  it('keeps one placeholder per thread, and the thread reply clears only its own', async () => {
    const { adapter, channelFor } = makeAdapter();
    await adapter.sendTyping('parent', { threadId: 'thread-1' });
    await adapter.sendTyping('parent', { threadId: 'thread-2' });
    expect(channelFor('thread-1').sent).toHaveLength(1);
    expect(channelFor('thread-2').sent).toHaveLength(1);

    await adapter.send('parent', { text: 'answer', threadId: 'thread-1' });
    expect(channelFor('thread-1').deleted).toEqual(['thread-1-m1']);
    expect(channelFor('thread-2').deleted).toEqual([]);
  });

  it('a streamed edit for a thread message fetches it from the thread', async () => {
    const { adapter, channelFor } = makeAdapter();
    const sent = await adapter.send('parent', { text: 'draft', threadId: 'thread-1' });
    expect(sent.ok).toBe(true);
    const id = sent.messageId ?? '';
    const edited = await adapter.editMessage('parent', id, 'final', { threadId: 'thread-1' });
    expect(edited.ok).toBe(true);
    expect(channelFor('thread-1').edited).toEqual([[id, 'final']]);
  });

  it('without a threadId typing still targets the chat itself', async () => {
    const { adapter, channelFor } = makeAdapter();
    await adapter.sendTyping('parent');
    expect(channelFor('parent').typing).toBe(1);
    expect(channelFor('parent').sent.map((p) => p.content)).toEqual(['Thinking…']);
  });
});
