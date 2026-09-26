// @vitest-environment jsdom
//
// W3 (ux-feedback plan) — QuickChat is no longer a black box. These cases pin
// the three promises: an error renders through the shared A3 banner, Stop is
// bound to the abort RPC, and a reply that finishes while the window is
// hidden raises the OS notification through the desktop bridge
// (`window.ethos.quickChat.notifyDone` → `showBackgroundNotification` →
// `navigate:session`). Same jsdom + react-dom/client harness as
// `useChat-abort.test.ts`.

import type { SseEvent } from '@ethosagent/web-contracts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionsGet = vi.fn();
const sessionsMessages = vi.fn();
const tasksList = vi.fn();
const clarifyListPending = vi.fn();
const chatAbort = vi.fn();
const chatSend = vi.fn();
let emit: ((event: SseEvent) => void) | null = null;

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
  subscribeToSession: (_id: string, opts: { onEvent: (event: SseEvent) => void }) => {
    emit = opts.onEvent;
    return { close: () => undefined, lastSeq: 0, connectionState: 'open' };
  },
}));

vi.mock('../../hooks/useActivePersonality', () => ({
  useActivePersonality: () => ({ id: 'researcher', model: 'claude-sonnet-5', isLoading: false }),
}));

const { QuickChat, extractText } = await import('../QuickChat');

const SESSION_ID = 'sess-q1';

let container: HTMLDivElement;
let root: Root;
let notifyDone: ReturnType<typeof vi.fn>;
let hidden = false;

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(QuickChat));
  });
}

async function sendAndStream(): Promise<void> {
  await mount();
  const textarea = container.querySelector('textarea');
  if (!textarea) throw new Error('no composer');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, 'hi there');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });
  await act(async () => {
    emit?.({ type: 'text_delta', text: 'an answer' });
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  emit = null;
  hidden = false;
  for (const fn of [
    sessionsGet,
    sessionsMessages,
    tasksList,
    clarifyListPending,
    chatAbort,
    chatSend,
  ]) {
    fn.mockReset();
  }
  chatSend.mockResolvedValue({ sessionId: SESSION_ID });
  chatAbort.mockResolvedValue({ ok: true });
  sessionsGet.mockResolvedValue({ session: { id: SESSION_ID, key: 'web:q' }, messages: [] });
  sessionsMessages.mockResolvedValue({ messages: [], cards: [], nextCursor: null });
  tasksList.mockResolvedValue([]);
  clarifyListPending.mockResolvedValue([]);
  notifyDone = vi.fn();
  Object.defineProperty(window, 'ethos', {
    configurable: true,
    value: { quickChat: { notifyDone } },
  });
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  Reflect.deleteProperty(window, 'ethos');
});

describe('QuickChat — errors render through the shared banner (A3 pieces)', () => {
  it('shows title + action from describeChatError and Dismiss clears it', async () => {
    await sendAndStream();
    await act(async () => {
      emit?.({ type: 'error', error: 'raw provider text', code: 'llm_error' });
    });
    expect(container.textContent).toContain('the model call failed');
    expect(container.textContent).toContain('retry; if it repeats');

    const dismiss = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Dismiss',
    );
    await act(async () => {
      dismiss?.click();
    });
    expect(container.textContent).not.toContain('the model call failed');
  });
});

describe('QuickChat — Stop', () => {
  it('binds the Stop control to the abort RPC while streaming', async () => {
    await sendAndStream();
    const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop"]');
    expect(stop).not.toBeNull();
    await act(async () => {
      stop?.click();
    });
    expect(chatAbort).toHaveBeenCalledWith({ sessionId: SESSION_ID });
  });
});

describe('QuickChat — background notification (W3)', () => {
  it('fires quickChat.notifyDone when done arrives while the window is hidden', async () => {
    await sendAndStream();
    hidden = true;
    await act(async () => {
      emit?.({ type: 'done', text: 'an answer', turnCount: 1 });
    });
    expect(notifyDone).toHaveBeenCalledTimes(1);
    expect(notifyDone).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      title: 'researcher replied',
      body: 'an answer',
    });
  });

  it('stays quiet when the window is visible', async () => {
    await sendAndStream();
    await act(async () => {
      emit?.({ type: 'done', text: 'an answer', turnCount: 1 });
    });
    expect(notifyDone).not.toHaveBeenCalled();
  });
});

describe('QuickChat — Enter while streaming queues instead of dropping', () => {
  it('keeps the draft, says queued, and sends it when the turn ends', async () => {
    await sendAndStream();
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('no composer');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'follow-up');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    // Still streaming: nothing sent, nothing lost.
    expect(chatSend).toHaveBeenCalledTimes(1);
    expect(container.querySelector('textarea')?.value).toBe('follow-up');
    expect(container.textContent).toContain('queued');

    await act(async () => {
      emit?.({ type: 'done', text: 'an answer', turnCount: 1 });
    });
    expect(chatSend).toHaveBeenCalledTimes(2);
    expect(chatSend.mock.calls[1]?.[0]).toMatchObject({ text: 'follow-up' });
  });
});

describe('extractText — non-text blocks survive', () => {
  it('represents artifact blocks instead of reading as empty', () => {
    expect(
      extractText({
        id: 'a1',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          { kind: 'text', content: 'see:' },
          { kind: 'image', toolCallId: 'tc1', src: 'data:image/png;base64,x' },
          { kind: 'pdf', toolCallId: 'tc2', src: 'data:application/pdf;base64,x' },
        ],
      }),
    ).toBe('see: [image] [pdf]');
  });
});
