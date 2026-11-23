// @vitest-environment jsdom
//
// Compact now lives in a popover rendered through the Composer's contextMeter
// slot. Pressing it must not touch the draft: the Composer never reads the slot.

import type { ContextAnatomyWire } from '@ethosagent/web-contracts';
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
const { ContextMeter } = await import('../ContextMeter');

const anatomy: ContextAnatomyWire = {
  system: 1000,
  tools: 400,
  messages: 5000,
  total: 6400,
  inputTokens: 6400,
  cacheReadTokens: 0,
  cacheHitRate: 0,
  llmCallCount: 1,
  memory: 200,
  skills: 100,
  contextWindow: 200_000,
  compactAtTokens: 100_000,
};

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function render(compactDisabled: boolean, onCompact: () => void): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Composer, {
          personalityId: 'researcher',
          onSend: () => undefined,
          contextMeter: createElement(ContextMeter, {
            anatomy,
            usedTokens: null,
            compactDisabled,
            onCompact,
          }),
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

function compactNow(): HTMLButtonElement {
  const btn = [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Compact now'),
  );
  if (!btn) throw new Error('no Compact now button');
  return btn;
}

async function openPanel(): Promise<void> {
  const trigger = container.querySelector('button.context-meter');
  if (!trigger) throw new Error('no context meter trigger');
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
});

describe('Composer + ContextMeter Compact now', () => {
  it('fires onCompact once with no args and leaves the draft untouched', async () => {
    const spy = vi.fn();
    await render(false, spy);
    await type('half-written thought');
    await openPanel();
    await act(async () => {
      compactNow().click();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual([]);
    expect(textarea().value).toBe('half-written thought');
  });

  it('disables Compact now while a turn is busy', async () => {
    const spy = vi.fn();
    await render(true, spy);
    await openPanel();
    expect(compactNow().disabled).toBe(true);
    await act(async () => {
      compactNow().click();
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
