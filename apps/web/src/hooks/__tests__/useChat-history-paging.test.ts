// @vitest-environment jsdom
//
// Paged chat history. A long session used to open by downloading every stored
// row (`sessions.get`); `useChat` now asks `sessions.messages` for the newest
// whole turns and walks back with the cursor only when the reader scrolls up.
// These drive the real hook against a mocked RPC client and assert what it
// asks for, what it ignores, and what it keeps.

import type { SseEvent } from '@ethosagent/web-contracts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseChatResult } from '../useChat';

const sessionsGet = vi.fn();
const sessionsMessages = vi.fn();
const tasksList = vi.fn();
const clarifyListPending = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    sessions: {
      get: (...args: unknown[]) => sessionsGet(...args),
      messages: (...args: unknown[]) => sessionsMessages(...args),
    },
    tasks: { list: (...args: unknown[]) => tasksList(...args) },
    clarify: { listPending: (...args: unknown[]) => clarifyListPending(...args) },
  },
}));

/** Push an event to whatever `useChat` subscribed with. */
let emit: ((event: SseEvent) => void) | null = null;

vi.mock('../../sse', () => ({
  subscribeToSession: (_id: string, opts: { onEvent: (event: SseEvent) => void }) => {
    emit = opts.onEvent;
    return { close: () => undefined, lastSeq: 0 };
  },
}));

const { useChat } = await import('../useChat');

const SESSION_ID = 'sess-1';
const SESSION_KEY = 'web:sess-1';

function row(id: string, role: 'user' | 'assistant', timestamp: number) {
  return {
    id,
    sessionId: SESSION_ID,
    role,
    content: `${role} ${id}`,
    toolCallId: null,
    toolName: null,
    toolCalls: null,
    timestamp: new Date(timestamp).toISOString(),
  };
}

function page(ids: Array<[string, 'user' | 'assistant', number]>, nextCursor: string | null) {
  return { messages: ids.map(([id, role, ts]) => row(id, role, ts)), cards: [], nextCursor };
}

const NEWEST = page(
  [
    ['u3', 'user', 30],
    ['a3', 'assistant', 31],
  ],
  'cursor-u3',
);
const OLDER = page(
  [
    ['u1', 'user', 10],
    ['a1', 'assistant', 11],
  ],
  null,
);

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (err: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let latest: UseChatResult | null = null;
const onSessionNotFound = vi.fn();

function Harness() {
  latest = useChat({
    initialSessionId: SESSION_ID,
    personalityId: 'test',
    onSessionNotFound,
    sessionKey: SESSION_KEY,
  });
  return null;
}

function hook(): UseChatResult {
  if (!latest) throw new Error('not mounted');
  return latest;
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(Harness));
  });
}

const ids = () => hook().state.messages.map((m) => m.id);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  latest = null;
  emit = null;
  sessionsGet.mockReset();
  sessionsMessages.mockReset();
  tasksList.mockReset();
  clarifyListPending.mockReset();
  onSessionNotFound.mockReset();
  sessionsGet.mockImplementation(({ id }: { id: string }) =>
    Promise.resolve({ session: { id, key: `web:${id}` }, messages: [], cards: [] }),
  );
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

/** A host that hands `useChat` a NEW inline `onSessionNotFound` on every render. */
function InlineCallbackHarness({ tick }: { tick: number }) {
  latest = useChat({
    initialSessionId: SESSION_ID,
    personalityId: 'test',
    onSessionNotFound: () => onSessionNotFound(tick),
  });
  return null;
}

describe('useChat — the history load is independent of callback identity', () => {
  it('re-rendering with a fresh inline onSessionNotFound does not restart the load', async () => {
    const first = deferred<typeof NEWEST>();
    // Every call gets the same pending page, so a restarted load shows up as
    // an extra call rather than as a crash.
    sessionsMessages.mockReturnValue(first.promise);

    for (let tick = 0; tick < 4; tick++) {
      await act(async () => {
        root.render(createElement(InlineCallbackHarness, { tick }));
      });
    }
    await act(async () => {
      first.resolve(NEWEST);
    });

    expect(sessionsMessages).toHaveBeenCalledTimes(1);
    expect(sessionsGet).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(['u3', 'a3']);
  });
});

describe('useChat — paged history', () => {
  it('opens with one sessions.messages call and never downloads the full history', async () => {
    sessionsMessages.mockResolvedValueOnce(NEWEST);

    await mount();

    expect(sessionsMessages).toHaveBeenCalledTimes(1);
    expect(sessionsMessages).toHaveBeenCalledWith({ id: SESSION_ID });
    // The session row is still read — for the run restore's key — but never
    // with its history attached.
    for (const [input] of sessionsGet.mock.calls) {
      expect(input).toEqual({ id: SESSION_ID, withMessages: false });
    }
    expect(tasksList).toHaveBeenCalledWith({ rootSessionKey: SESSION_KEY });
    expect(ids()).toEqual(['u3', 'a3']);
    expect(hook().hasOlder).toBe(true);
    expect(hook().olderStatus).toBe('idle');
  });

  it('loadOlder passes the cursor, prepends the page, and stops once nextCursor is null', async () => {
    sessionsMessages.mockResolvedValueOnce(NEWEST).mockResolvedValueOnce(OLDER);
    await mount();

    await act(async () => {
      await hook().loadOlder();
    });

    expect(sessionsMessages).toHaveBeenLastCalledWith({ id: SESSION_ID, before: 'cursor-u3' });
    expect(ids()).toEqual(['u1', 'a1', 'u3', 'a3']);
    expect(hook().hasOlder).toBe(false);
    expect(hook().olderStatus).toBe('idle');

    await act(async () => {
      await hook().loadOlder();
    });
    expect(sessionsMessages).toHaveBeenCalledTimes(2);
  });

  it('ignores a loadOlder call while one is already in flight', async () => {
    const older = deferred<typeof OLDER>();
    sessionsMessages.mockResolvedValueOnce(NEWEST).mockReturnValueOnce(older.promise);
    await mount();

    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = hook().loadOlder();
    });
    expect(hook().olderStatus).toBe('loading');
    await act(async () => {
      await hook().loadOlder();
      await hook().loadOlder();
    });
    expect(sessionsMessages).toHaveBeenCalledTimes(2);

    await act(async () => {
      older.resolve(OLDER);
      await first;
    });
    expect(ids()).toEqual(['u1', 'a1', 'u3', 'a3']);
  });

  it('drops an older page that lands after the session was switched away', async () => {
    const older = deferred<typeof OLDER>();
    sessionsMessages
      .mockResolvedValueOnce(NEWEST)
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce({
        messages: [{ ...row('u9', 'user', 90), sessionId: 'sess-2' }],
        cards: [],
        nextCursor: null,
      });
    await mount();

    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = hook().loadOlder();
    });
    await act(async () => {
      hook().switchSession('sess-2');
    });
    expect(sessionsMessages).toHaveBeenLastCalledWith({ id: 'sess-2' });
    expect(ids()).toEqual(['u9']);

    await act(async () => {
      older.resolve(OLDER);
      await pending;
    });

    expect(ids()).toEqual(['u9']);
    expect(hook().hasOlder).toBe(false);
    expect(hook().olderStatus).toBe('idle');
  });

  it('resets to a fresh chat when the session is not found', async () => {
    sessionsMessages.mockRejectedValueOnce(new Error(`Session ${SESSION_ID} not found`));
    sessionsGet.mockRejectedValue(new Error(`Session ${SESSION_ID} not found`));

    await mount();

    expect(onSessionNotFound).toHaveBeenCalledWith(SESSION_ID);
    expect(hook().currentSessionId).toBeNull();
    expect(hook().state.messages).toEqual([]);
    expect(hook().hasOlder).toBe(false);
    expect(hook().state.error).toBeNull();
  });

  it('a failed older page leaves the cursor in place so Retry can fetch it', async () => {
    sessionsMessages
      .mockResolvedValueOnce(NEWEST)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(OLDER);
    await mount();

    await act(async () => {
      await hook().loadOlder();
    });
    expect(hook().olderStatus).toBe('error');
    expect(hook().hasOlder).toBe(true);
    expect(ids()).toEqual(['u3', 'a3']);

    await act(async () => {
      await hook().loadOlder();
    });
    expect(sessionsMessages).toHaveBeenLastCalledWith({ id: SESSION_ID, before: 'cursor-u3' });
    expect(hook().olderStatus).toBe('idle');
    expect(ids()).toEqual(['u1', 'a1', 'u3', 'a3']);
  });
});

function cronFired(sessionKey: string): SseEvent {
  return {
    type: 'cron.fired',
    jobId: 'job-9',
    ranAt: '2026-09-13T00:00:00.000Z',
    outputPath: null,
    sessionKey,
  };
}

/** Let a fire-and-forget merge settle. */
async function emitAndSettle(event: SseEvent): Promise<void> {
  await act(async () => {
    emit?.(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const MIDDLE = page(
  [
    ['u2', 'user', 20],
    ['a2', 'assistant', 21],
  ],
  'cursor-u2',
);

describe('useChat — a cron turn reaches the chat', () => {
  it('a matching cron.fired merges the newest page, keeping older pages and the cursor', async () => {
    sessionsMessages
      .mockResolvedValueOnce(NEWEST)
      .mockResolvedValueOnce(MIDDLE)
      .mockResolvedValueOnce(
        page(
          [
            ['u3', 'user', 30],
            ['a3', 'assistant', 31],
            ['u5', 'user', 50],
            ['a5', 'assistant', 51],
          ],
          'cursor-u3',
        ),
      )
      .mockResolvedValueOnce(OLDER);
    await mount();
    await act(async () => {
      await hook().loadOlder();
    });
    expect(ids()).toEqual(['u2', 'a2', 'u3', 'a3']);

    await emitAndSettle(cronFired(SESSION_KEY));

    expect(sessionsMessages).toHaveBeenNthCalledWith(3, { id: SESSION_ID });
    expect(ids()).toEqual(['u2', 'a2', 'u3', 'a3', 'u5', 'a5']);
    expect(hook().hasOlder).toBe(true);

    await act(async () => {
      await hook().loadOlder();
    });
    expect(sessionsMessages).toHaveBeenLastCalledWith({ id: SESSION_ID, before: 'cursor-u2' });
    expect(ids()).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u5', 'a5']);
  });

  it('replaces everything and resets the cursor when the page does not start inside what is loaded', async () => {
    sessionsMessages
      .mockResolvedValueOnce(NEWEST)
      .mockResolvedValueOnce(
        page(
          [
            ['u7', 'user', 70],
            ['a7', 'assistant', 71],
            ['u8', 'user', 80],
            ['a8', 'assistant', 81],
          ],
          'cursor-u7',
        ),
      )
      .mockResolvedValueOnce(OLDER);
    await mount();

    await emitAndSettle(cronFired(SESSION_KEY));

    expect(ids()).toEqual(['u7', 'a7', 'u8', 'a8']);
    expect(hook().hasOlder).toBe(true);
    await act(async () => {
      await hook().loadOlder();
    });
    expect(sessionsMessages).toHaveBeenLastCalledWith({ id: SESSION_ID, before: 'cursor-u7' });
  });

  it('a cron.fired for another session key does nothing', async () => {
    sessionsMessages.mockResolvedValueOnce(NEWEST);
    await mount();

    await emitAndSettle(cronFired('web:some-other-session'));

    expect(sessionsMessages).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(['u3', 'a3']);
    expect(hook().hasOlder).toBe(true);
  });

  it('drops a merge that lands after the session was switched away', async () => {
    const merge = deferred<typeof NEWEST>();
    sessionsMessages
      .mockResolvedValueOnce(NEWEST)
      .mockReturnValueOnce(merge.promise)
      .mockResolvedValueOnce({
        messages: [{ ...row('u9', 'user', 90), sessionId: 'sess-2' }],
        cards: [],
        nextCursor: null,
      });
    await mount();

    await emitAndSettle(cronFired(SESSION_KEY));
    await act(async () => {
      hook().switchSession('sess-2');
    });
    expect(ids()).toEqual(['u9']);

    await act(async () => {
      merge.resolve(
        page(
          [
            ['u3', 'user', 30],
            ['a3', 'assistant', 31],
            ['u5', 'user', 50],
            ['a5', 'assistant', 51],
          ],
          'cursor-u3',
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(ids()).toEqual(['u9']);
    expect(hook().hasOlder).toBe(false);
  });
});
