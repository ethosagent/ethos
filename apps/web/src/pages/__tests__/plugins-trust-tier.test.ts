// @vitest-environment jsdom
//
// U10 (openclaw-9.6-gaps) — the Library `/plugins` matrix shows each plugin's
// trust tier: the tier recorded in its install grant, the same value
// `ethos plugin grants` prints. A plugin with no grant reads as an em dash,
// never as a tier it was not given.

import type { PluginInfo } from '@ethosagent/web-contracts';
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

function plugin(id: string, trustTier: PluginInfo['trustTier']): PluginInfo {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: null,
    source: 'user',
    path: `/data/plugins/${id}`,
    pluginContractMajor: 2,
    status: null,
    error: null,
    trustTier,
  };
}

vi.mock('../../rpc', () => ({
  rpc: {
    plugins: {
      list: async () => ({
        plugins: [plugin('granted-plugin', 'community'), plugin('dropped-plugin', null)],
        mcpServers: [],
      }),
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

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { writable: true, value: 1200 });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Plugins page trust tier', () => {
  it('renders the granted tier in a Trust column, and a dash with no grant', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
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

    const headers = [...container.querySelectorAll('th')].map((th) => th.textContent?.trim());
    expect(headers).toContain('Trust');

    const tierOf = (id: string) => {
      const row = container.querySelector(`tr[data-row-key="${id}"]`);
      return row?.querySelector('[data-testid="plugin-trust-tier"]')?.textContent;
    };
    expect(tierOf('granted-plugin')).toBe('community');
    expect(tierOf('dropped-plugin')).toBe('—');
  });
});
