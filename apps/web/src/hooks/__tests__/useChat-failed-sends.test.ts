// @vitest-environment jsdom
//
// W1 — the failed-send registry (`failedSendsRef`). Three facts pinned here:
// Retry re-submits the failed text, Discard hands it back exactly once, and —
// the pruning fix — a session switch or reset clears the registry, so a
// failed send from a previous session can neither be discarded into the new
// session's composer nor accumulate forever. Same harness as
// `useChat-abort.test.ts`.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseChatResult } from '../useChat';

const sessionsGet = vi.fn();
const sessionsMessages = vi.fn();
const tasksList = vi.fn();
const clarifyListPending = vi.fn();
const chatAbort = vi.fn();
const chatSend = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    sessions: {
      get: (...args: unknown[]) => sessionsGet(...args),
      messages: (...args: unknown[]) => sessionsMessages(...args),
    },
    tasks: { list: (...args: unknown[]) => tasksList(...args) },
    clarify: { listPending: (...args: unknown[]) => clarifyListPending(...args) },
    chat: {
      abort: (...args: unknown[]) => chatAbort(...args),
      send: (...args: unknown[]) => chatSend(...args),
    },
  },
}));

vi.mock('../../sse', () => ({
  subscribeToSession: () => ({ close: () => undefined, lastSeq: 0 }),
}));

const { useChat } = await import('../useChat');

const SESSION_ID = 'sess-f1';

let container: HTMLDivElement;
let root: Root;
let latest: UseChatResult | null = null;

function Harness() {
  latest = useChat({ initialSessionId: SESSION_ID, personalityId: 'test' });
  return null;
}

async function mountWithFailedSend(): Promise<string> {
  chatSend.mockRejectedValueOnce(new Error('backend down'));
  await act(async () => {
    root.render(createElement(Harness));
  });
  await act(async () => {
    await latest?.sendMessage('the draft that failed');
  });
  const failed = latest?.state.messages.find((m) => m.role === 'user' && m.status === 'failed');
  if (!failed) throw new Error('no failed bubble');
  return failed.id;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of [sessionsGet, sessionsMessages, tasksList, clarifyListPending, chatAbort]) {
    fn.mockReset();
  }
  chatSend.mockReset();
  chatSend.mockResolvedValue({ sessionId: SESSION_ID });
  sessionsGet.mockResolvedValue({
    session: { id: SESSION_ID, key: 'web:f1' },
    messages: [],
    cards: [],
  });
  sessionsMessages.mockResolvedValue({ messages: [], cards: [], nextCursor: null });
  tasksList.mockResolvedValue([]);
  clarifyListPending.mockResolvedValue([]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('useChat — the failed-send registry', () => {
  it('Discard returns the text once, then the entry is gone', async () => {
    const id = await mountWithFailedSend();
    let draft: string | null = null;
    act(() => {
      draft = latest?.discardMessage(id) ?? null;
    });
    expect(draft).toBe('the draft that failed');
    act(() => {
      draft = latest?.discardMessage(id) ?? null;
    });
    expect(draft).toBeNull();
  });

  it('Retry re-submits the failed text', async () => {
    const id = await mountWithFailedSend();
    await act(async () => {
      await latest?.retryMessage(id);
    });
    expect(chatSend).toHaveBeenCalledTimes(2);
    expect(chatSend.mock.calls[1]?.[0]).toMatchObject({ text: 'the draft that failed' });
  });

  it('a session switch prunes the registry — no cross-session discard', async () => {
    const id = await mountWithFailedSend();
    act(() => {
      latest?.switchSession('sess-f2');
    });
    let draft: string | null = null;
    act(() => {
      draft = latest?.discardMessage(id) ?? null;
    });
    expect(draft).toBeNull();
  });

  it('a session reset prunes the registry too', async () => {
    const id = await mountWithFailedSend();
    act(() => {
      latest?.resetSession();
    });
    let draft: string | null = null;
    act(() => {
      draft = latest?.discardMessage(id) ?? null;
    });
    expect(draft).toBeNull();
  });
});
