// @vitest-environment jsdom
//
// W1 (ux-feedback plan) — a failed send loses nothing. The chosen composer
// flow: the draft CLEARS optimistically on send (typing stays responsive for
// the next message); recovery lives on the failed bubble, whose Discard hands
// the text back. These cases pin both halves where they render:
//   • Composer clears the draft before onSend resolves,
//   • a failed UserBubble shows `⚠ not sent` + the reason, and its Retry /
//     Discard verbs fire with the message id.
// Same jsdom + react-dom/client harness as `status-line.test.ts` — the repo
// has no testing-library.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserMessage } from '../../lib/chat-reducer';
import { Composer } from '../chat/Composer';
import { UserBubble } from '../chat/MessageBubble';

vi.mock('../../rpc', () => ({
  rpc: {
    meta: { capabilities: vi.fn().mockResolvedValue({ capabilities: {} }) },
    files: { list: vi.fn().mockResolvedValue({ paths: [] }) },
    slashCommands: { list: vi.fn().mockResolvedValue({ commands: [] }) },
    context: { resolve: vi.fn().mockResolvedValue({ resolved: [] }) },
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

describe('Composer — the send flow keeps typing responsive', () => {
  it('clears the draft before onSend resolves', async () => {
    let resolveSend: (() => void) | undefined;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(Composer, {
            personalityId: 'researcher',
            onSend,
            // The suggestion path fills the draft the way a pill does.
            suggestion: { text: 'hello there', seq: 1 },
          }),
        ),
      );
    });

    const textarea = container.querySelector('textarea');
    expect(textarea?.value).toBe('hello there');

    const send = container.querySelector<HTMLButtonElement>('[aria-label="Send message"]');
    await act(async () => {
      send?.click();
    });

    // onSend is still pending — and the draft is already clear, so the user
    // can type the next message while this one is on the wire.
    expect(onSend).toHaveBeenCalledWith('hello there');
    expect(resolveSend).toBeDefined();
    expect(container.querySelector('textarea')?.value).toBe('');
    resolveSend?.();
  });
});

describe('UserBubble — a failed send keeps the words on screen', () => {
  const failed: UserMessage = {
    id: 'u1',
    role: 'user',
    content: 'important question',
    timestamp: 1,
    status: 'failed',
    error: 'offline',
  };

  it('renders ⚠ not sent with the reason, and the two verbs fire with the id', async () => {
    const onRetry = vi.fn();
    const onDiscard = vi.fn();
    await act(async () => {
      root.render(createElement(UserBubble, { message: failed, onRetry, onDiscard }));
    });

    expect(container.textContent).toContain('important question');
    expect(container.textContent).toContain('⚠ not sent');
    expect(container.textContent).toContain('offline');

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.message-send-failed-btn')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Retry', 'Discard']);

    await act(async () => {
      buttons[0]?.click();
    });
    expect(onRetry).toHaveBeenCalledWith('u1');

    await act(async () => {
      buttons[1]?.click();
    });
    expect(onDiscard).toHaveBeenCalledWith('u1');
  });

  it('a message that sent fine renders no failed row', async () => {
    await act(async () => {
      root.render(
        createElement(UserBubble, {
          message: { id: 'u2', role: 'user', content: 'fine', timestamp: 1 },
          onRetry: vi.fn(),
          onDiscard: vi.fn(),
        }),
      );
    });
    expect(container.querySelector('.message-send-failed')).toBeNull();
  });
});
