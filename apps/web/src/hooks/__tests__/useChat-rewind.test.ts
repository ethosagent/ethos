// @vitest-environment jsdom
//
// `rewindTo` — branch before an earlier prompt, load the cut history, switch the
// chat onto the branch and send the edited text there. A refusal leaves the
// session exactly as it was. Same harness as `useChat-failed-sends.test.ts`.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseChatResult } from '../useChat';

const sessionsGet = vi.fn();
const sessionsMessages = vi.fn();
const sessionsRewind = vi.fn();
const tasksList = vi.fn();
const clarifyListPending = vi.fn();
const chatSend = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    sessions: {
      get: (...args: unknown[]) => sessionsGet(...args),
      messages: (...args: unknown[]) => sessionsMessages(...args),
      rewind: (...args: unknown[]) => sessionsRewind(...args),
    },
    tasks: { list: (...args: unknown[]) => tasksList(...args) },
    clarify: { listPending: (...args: unknown[]) => clarifyListPending(...args) },
    chat: { send: (...args: unknown[]) => chatSend(...args) },
  },
}));

vi.mock('../../sse', () => ({
  subscribeToSession: () => ({ close: () => undefined, lastSeq: 0 }),
}));

const { useChat } = await import('../useChat');

const SESSION_ID = 'sess-r1';

function row(sessionId: string, id: string, role: 'user' | 'assistant', ms: number) {
  return {
    id,
    sessionId,
    role,
    content: `${role} ${id}`,
    toolCallId: null,
    toolName: null,
    toolCalls: null,
    timestamp: new Date(ms).toISOString(),
  };
}

let container: HTMLDivElement;
let root: Root;
let latest: UseChatResult | null = null;

function Harness() {
  latest = useChat({ initialSessionId: SESSION_ID, personalityId: 'test' });
  return null;
}

async function mount() {
  await act(async () => {
    root.render(createElement(Harness));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of [sessionsGet, sessionsMessages, sessionsRewind, tasksList, clarifyListPending]) {
    fn.mockReset();
  }
  chatSend.mockReset();
  chatSend.mockResolvedValue({ sessionId: 'branch-1' });
  sessionsGet.mockResolvedValue({ session: { id: SESSION_ID, key: 'web:r1' } });
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

describe('useChat.rewindTo', () => {
  it('rewinds, loads the cut history, switches session and sends the edited text there', async () => {
    sessionsMessages
      .mockResolvedValueOnce({
        messages: [
          row(SESSION_ID, 'u1', 'user', 1000),
          row(SESSION_ID, 'a1', 'assistant', 2000),
          row(SESSION_ID, 'u2', 'user', 3000),
          row(SESSION_ID, 'a2', 'assistant', 4000),
        ],
        cards: [],
        decisions: [],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        messages: [row('branch-1', 'bu1', 'user', 1000), row('branch-1', 'ba1', 'assistant', 2000)],
        cards: [],
        decisions: [],
        nextCursor: null,
      });
    sessionsRewind.mockResolvedValue({
      session: { id: 'branch-1' },
      prompt: 'user u2',
      turnsBack: 1,
      hadAttachments: false,
    });
    await mount();
    const lastUser = latest?.state.messages.filter((m) => m.role === 'user').at(-1);
    if (!lastUser) throw new Error('no user bubble');

    await act(async () => {
      expect(await latest?.rewindTo(lastUser.id, 'b edited')).toBe('branch-1');
    });

    expect(sessionsRewind).toHaveBeenCalledWith({ id: SESSION_ID, messageId: lastUser.id });
    expect(sessionsMessages).toHaveBeenLastCalledWith({ id: 'branch-1' });
    expect(chatSend).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'branch-1', text: 'b edited' }),
    );
    expect(latest?.currentSessionId).toBe('branch-1');
    expect(latest?.state.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('falls back to turnsBack for a prompt sent in this tab (local id)', async () => {
    sessionsMessages.mockResolvedValue({
      messages: [],
      cards: [],
      decisions: [],
      nextCursor: null,
    });
    sessionsRewind.mockResolvedValue({
      session: { id: 'branch-1' },
      prompt: 'hello',
      turnsBack: 1,
      hadAttachments: false,
    });
    await mount();
    await act(async () => {
      await latest?.sendMessage('hello');
    });
    const local = latest?.state.messages.find((m) => m.role === 'user');
    if (!local) throw new Error('no user bubble');
    expect(local.id.startsWith('user-')).toBe(true);

    await act(async () => {
      await latest?.rewindTo(local.id, 'hello again');
    });
    expect(sessionsRewind).toHaveBeenCalledWith({ id: SESSION_ID, turnsBack: 1 });
  });

  it('leaves the session untouched and rethrows when the server refuses', async () => {
    sessionsMessages.mockResolvedValue({
      messages: [row(SESSION_ID, 'u1', 'user', 1000), row(SESSION_ID, 'a1', 'assistant', 2000)],
      cards: [],
      decisions: [],
      nextCursor: null,
    });
    sessionsRewind.mockRejectedValue(new Error('stop the turn first'));
    await mount();
    const target = latest?.state.messages.find((m) => m.role === 'user');
    if (!target) throw new Error('no user bubble');

    let caught: unknown;
    await act(async () => {
      try {
        await latest?.rewindTo(target.id, 'x');
      } catch (err) {
        caught = err;
      }
    });
    expect(caught).toBeInstanceOf(Error);
    expect(latest?.currentSessionId).toBe(SESSION_ID);
    expect(chatSend).not.toHaveBeenCalled();
    expect(latest?.state.messages).toHaveLength(2);
  });

  it('throws before any RPC when the bubble is unknown', async () => {
    sessionsMessages.mockResolvedValue({
      messages: [],
      cards: [],
      decisions: [],
      nextCursor: null,
    });
    await mount();
    await expect(latest?.rewindTo('user-0', 'x')).rejects.toThrow(/can no longer be edited/);
    expect(sessionsRewind).not.toHaveBeenCalled();
  });
});
