// @vitest-environment jsdom
//
// W1 follow-up — a failed send's Discard hands its text back to the composer
// through the suggestion path, flagged `onlyIfEmpty`. That flag is the fix for
// a real data-loss bug: Discard used to REPLACE the composer draft, destroying
// whatever the user had typed after the failed send. Both branches are pinned:
// an empty composer takes the restored draft; a non-empty one keeps the
// user's newer text. A plain (pill) suggestion still replaces.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock('../../../rpc', () => ({
  rpc: {
    meta: { capabilities: () => Promise.resolve({ capabilities: { voice_stt: false } }) },
    slashCommands: { list: () => Promise.resolve({ commands: [] }) },
    files: { list: () => Promise.resolve({ paths: [] }) },
    context: { resolve: () => Promise.resolve({ resolved: [] }) },
  },
}));

const { Composer } = await import('../Composer');

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

type Suggestion = { text: string; seq: number; onlyIfEmpty?: boolean };

async function render(suggestion?: Suggestion): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Composer, {
          personalityId: 'researcher',
          onSend: () => undefined,
          ...(suggestion ? { suggestion } : {}),
        }),
      ),
    );
  });
}

function textarea(): HTMLTextAreaElement {
  const el = container.querySelector('textarea');
  if (!el) throw new Error('no composer textarea');
  return el;
}

async function type(value: string): Promise<void> {
  const el = textarea();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

describe('Composer — onlyIfEmpty suggestion (Discard restore)', () => {
  it('fills an empty composer with the recovered draft', async () => {
    await render();
    await render({ text: 'the failed draft', seq: 1, onlyIfEmpty: true });
    expect(textarea().value).toBe('the failed draft');
  });

  it('never clobbers text the user typed since the failed send', async () => {
    await render();
    await type('typed after the failure');
    await render({ text: 'the failed draft', seq: 1, onlyIfEmpty: true });
    expect(textarea().value).toBe('typed after the failure');
  });

  it('a plain pill suggestion still replaces the draft', async () => {
    await render();
    await type('half-typed');
    await render({ text: 'pill text', seq: 1 });
    expect(textarea().value).toBe('pill text');
  });
});
