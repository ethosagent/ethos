// @vitest-environment jsdom
//
// `useSessionGet` feeds the chat title, the session key and the chat redirect —
// every consumer reads `session.*` only. History is paged by `useChat` through
// `sessions.messages`, so this query must never download it.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionsGet = vi.fn();

vi.mock('../../../../rpc', () => ({
  rpc: { sessions: { get: (...args: unknown[]) => sessionsGet(...args) } },
}));

const { useSessionGet } = await import('../queries');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionsGet.mockReset();
  sessionsGet.mockResolvedValue({
    session: { id: 'sess-1', key: 'web:sess-1', title: null },
    messages: [],
    cards: [],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Harness({ id }: { id: string | null }) {
  useSessionGet(id);
  return null;
}

describe('useSessionGet', () => {
  it('reads the session row without its history', async () => {
    const client = new QueryClient();
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client }, createElement(Harness, { id: 'sess-1' })),
      );
    });

    expect(sessionsGet).toHaveBeenCalledTimes(1);
    expect(sessionsGet).toHaveBeenCalledWith({ id: 'sess-1', withMessages: false });
  });

  it('does not fetch without a session id', async () => {
    const client = new QueryClient();
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client }, createElement(Harness, { id: null })),
      );
    });
    expect(sessionsGet).not.toHaveBeenCalled();
  });
});
