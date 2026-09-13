// @vitest-environment jsdom
//
// The Library `/plugins` page's install is a GLOBAL install — the web's
// `ethos plugin install <pkg>` without `--personality`. It must send no
// `personalityId`, so `PluginsService.install` records the capability grant and
// writes no `plugins.lock` entry. Driven in jsdom the same way `Mcp.test.ts`
// drives its page; the create wizard's install, also global, is pinned in
// `personalities-wizard-plugin-install.test.ts`.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

vi.mock('react-router-dom', () => ({
  useParams: () => ({}),
  useNavigate: () => () => {},
  useSearchParams: () => [new URLSearchParams(), () => {}],
}));

const installFn = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    plugins: {
      list: async () => ({ plugins: [], mcpServers: [] }),
      install: (...args: unknown[]) => installFn(...args),
    },
    personalities: {
      list: async () => ({ items: [] }),
    },
  },
  client: {},
}));

const { Plugins } = await import('../Plugins');

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function buttonByText(text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!match) throw new Error(`no button "${text}"`);
  return match;
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  installFn.mockReset();
  installFn.mockResolvedValue({ ok: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Plugins page install', () => {
  it('sends no personalityId', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(AntApp, null, createElement(Plugins, null)),
        ),
      );
    });
    await flush();

    await act(async () => buttonByText('+ New Plugin').click());
    const input = container.querySelector<HTMLInputElement>('input[placeholder^="Package spec"]');
    if (!input) throw new Error('install input not rendered');
    await typeInto(input, 'my-plugin@1.0.0');
    await act(async () => buttonByText('Install').click());
    await flush();

    expect(installFn).toHaveBeenCalledTimes(1);
    const [arg] = installFn.mock.calls[0] ?? [];
    expect(arg).toEqual({ packageSpec: 'my-plugin@1.0.0' });
    expect(arg).not.toHaveProperty('personalityId');
  });
});
