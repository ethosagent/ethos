// @vitest-environment jsdom
//
// Communications > Tabs + useSearchParams (plan/phases/channel-prompts-ui.md L5):
// `?tab=slack` selects Slack, clicking a tab rewrites the URL with replace (no
// history entry), and `#rooms` scrolls the active platform's Rooms section.
// Every rpc call except the two the page needs resolves never, so each panel
// sits in its loading state; only the wiring is under test.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
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
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const never = () => new Promise<never>(() => {});
const overrides: Record<string, Record<string, (input?: never) => Promise<unknown>>> = {
  platforms: {
    list: async () => ({ platforms: [] }),
    listRoomPolicies: async (input?: { platform: string }) => ({
      platform: input?.platform,
      allowNameMatching: false,
      fetchMetadata: false,
      modes: [],
      entries: [],
      warnings: [],
    }),
  },
};

vi.mock('../../rpc', () => ({
  rpc: new Proxy(
    {},
    {
      get: (_t, ns: string) =>
        new Proxy(
          {},
          {
            get: (_n, method: string) =>
              (overrides[ns]?.[method] as ((...a: unknown[]) => Promise<unknown>) | undefined) ??
              never,
          },
        ),
    },
  ),
}));

const { Communications } = await import('../Communications');

let navType = '';
let search = '';
function Probe() {
  navType = useNavigationType();
  search = useLocation().search;
  return null;
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(entry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc } as { client: QueryClient; children?: never },
        createElement(
          AntApp,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: [entry] },
            createElement(Probe),
            createElement(Communications),
          ),
        ),
      ),
    );
  });
  await flush();
}

const activeTab = () =>
  container.querySelector('.ant-tabs-tab-active')?.textContent?.trim() ?? null;
const tabNamed = (name: string) =>
  [...container.querySelectorAll<HTMLElement>('.ant-tabs-tab')].find((t) =>
    t.textContent?.trim().startsWith(name),
  );

beforeEach(() => {
  navType = '';
  search = '';
  window.location.hash = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('Communications tabs and the URL', () => {
  it('?tab=slack selects Slack; a missing or unknown tab opens Telegram', async () => {
    await mount('/communications?tab=slack');
    expect(activeTab()).toBe('Slack');
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount('/communications?tab=nope');
    expect(activeTab()).toBe('Telegram');
  });

  it('clicking a tab updates ?tab= with replace, not push', async () => {
    await mount('/communications');
    expect(activeTab()).toBe('Telegram');
    await act(async () => {
      tabNamed('WhatsApp')?.click();
    });
    await flush();
    expect(search).toBe('?tab=whatsapp');
    expect(navType).toBe('REPLACE');
    expect(activeTab()).toBe('WhatsApp');
  });

  it('#rooms scrolls the active platform section only', async () => {
    const scroll = vi.fn(function (this: Element) {});
    Element.prototype.scrollIntoView = scroll;
    window.location.hash = '#rooms';
    await mount('/communications?tab=slack#rooms');
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(document.getElementById('rooms-slack'));
    expect(document.getElementById('rooms-telegram')).toBeNull();
  });
});
