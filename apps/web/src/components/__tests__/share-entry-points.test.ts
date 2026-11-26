// @vitest-environment jsdom
//
// Where "Share…" is offered (plan share-links.md D11; review F7, F13): the
// sidebar's right-click menu and the Sessions page row actions. Offered only
// once `shares.list` says enabled: true, never for an incognito row.
// `.test.ts` + createElement on purpose: the root vitest glob runs only
// `*.test.ts`.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import type { ComponentType } from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewSessionModalProvider } from '../../hooks/useNewSessionModal';

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

const sharesList = vi.fn();
const sharesPreview = vi.fn();
const sessionsList = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    shares: {
      list: (...a: unknown[]) => sharesList(...a),
      preview: (...a: unknown[]) => sharesPreview(...a),
      create: () => Promise.reject(new Error('not used')),
      revoke: () => Promise.reject(new Error('not used')),
    },
    sessions: { list: (...a: unknown[]) => sessionsList(...a) },
    personalities: {
      list: () =>
        Promise.resolve({ items: [{ id: 'engineer', name: 'Engineer' }], defaultId: null }),
      skillsList: () => Promise.resolve({ skills: [] }),
    },
    teams: { list: () => Promise.resolve({ items: [] }) },
    skills: { list: () => Promise.resolve({ skills: [] }) },
    plugins: { list: () => Promise.resolve({ plugins: [], mcpServers: [] }) },
    config: { get: () => Promise.resolve({ adminEnabled: false, personality: 'engineer' }) },
  },
}));

const { ScopeNav } = await import('../ScopeNav');
const { Sessions } = await import('../../pages/Sessions');

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    key: `web:${id}`,
    platform: 'web',
    model: 'm',
    provider: 'p',
    personalityId: 'engineer',
    parentSessionId: null,
    workingDir: null,
    title: `Title ${id}`,
    pinned: false,
    usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(component: ComponentType, path: string): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Number.POSITIVE_INFINITY } },
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          AntApp,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: [path] },
            createElement(NewSessionModalProvider, null, createElement(component)),
          ),
        ),
      ),
    );
  });
  await flush();
}

beforeEach(() => {
  sharesList.mockResolvedValue({ enabled: true, links: [] });
  sharesPreview.mockResolvedValue({ ok: false, reason: 'empty' });
  sessionsList.mockResolvedValue({
    items: [row('s-ok'), row('s-incog', { incognito: true })],
    nextCursor: null,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const menuItems = () =>
  [...document.querySelectorAll('.session-context-menu-item')].map((b) => b.textContent ?? '');
const hasShare = (items: string[]) => items.some((t) => t.includes('Share…'));

function sidebarRow(title: string): Element {
  const el = [...container.querySelectorAll('.sidebar-session-row')].find((r) =>
    r.textContent?.includes(title),
  );
  if (!el) throw new Error(`no sidebar row ${title}`);
  return el;
}

/** Right-click without awaiting any promise: what the user sees on the first frame. */
function rightClickNow(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
}

describe('sidebar right-click menu', () => {
  it('has Share… on the first frame, because ScopeNav already asked shares.list (F7)', async () => {
    await mount(ScopeNav, '/p/engineer/chat');
    expect(sharesList).toHaveBeenCalled();
    rightClickNow(sidebarRow('Title s-ok'));
    expect(menuItems().some((t) => t.includes('Export'))).toBe(true);
    expect(hasShare(menuItems())).toBe(true);
  });

  it('opens the share dialog from Share…', async () => {
    await mount(ScopeNav, '/p/engineer/chat');
    rightClickNow(sidebarRow('Title s-ok'));
    const item = [...document.querySelectorAll('.session-context-menu-item')].find((b) =>
      b.textContent?.includes('Share…'),
    );
    await act(async () => {
      item?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(document.querySelector('.share-dialog')).not.toBeNull();
    expect(document.body.textContent).toContain('Share session');
  });

  it('is hidden for an incognito row (F13)', async () => {
    await mount(ScopeNav, '/p/engineer/chat');
    rightClickNow(sidebarRow('Title s-incog'));
    expect(menuItems().length).toBeGreaterThan(0);
    expect(hasShare(menuItems())).toBe(false);
  });

  it('is hidden when sharing is off', async () => {
    sharesList.mockResolvedValue({ enabled: false, links: [] });
    await mount(ScopeNav, '/p/engineer/chat');
    rightClickNow(sidebarRow('Title s-ok'));
    expect(menuItems().length).toBeGreaterThan(0);
    expect(hasShare(menuItems())).toBe(false);
  });

  it('is hidden while shares.list is loading', async () => {
    sharesList.mockReturnValue(new Promise(() => {}));
    await mount(ScopeNav, '/p/engineer/chat');
    rightClickNow(sidebarRow('Title s-ok'));
    await flush();
    expect(menuItems().length).toBeGreaterThan(0);
    expect(hasShare(menuItems())).toBe(false);
  });

  it('is hidden when shares.list fails', async () => {
    sharesList.mockRejectedValue(new Error('boom'));
    await mount(ScopeNav, '/p/engineer/chat');
    rightClickNow(sidebarRow('Title s-ok'));
    expect(menuItems().length).toBeGreaterThan(0);
    expect(hasShare(menuItems())).toBe(false);
  });
});

describe('Sessions page row actions', () => {
  async function openActions(title: string): Promise<void> {
    const tr = [...document.querySelectorAll('tr.ant-table-row')].find((r) =>
      r.textContent?.includes(title),
    );
    const trigger = tr?.querySelector('.sessions-row-trigger');
    if (!trigger) throw new Error(`no row actions for ${title}`);
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flush();
  }
  const menuLabels = () =>
    [...document.querySelectorAll('.ant-dropdown-menu-item')].map((i) => i.textContent ?? '');

  it('Share… opens the dialog for that row', async () => {
    await mount(Sessions, '/library/sessions');
    await openActions('Title s-ok');
    const item = [...document.querySelectorAll('.ant-dropdown-menu-item')].find(
      (i) => i.textContent === 'Share…',
    );
    expect(item).toBeDefined();
    await act(async () => {
      item?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(document.querySelector('.share-dialog')).not.toBeNull();
    expect(sharesPreview).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's-ok' }));
  });

  it('hides Share… for an incognito row (F13)', async () => {
    await mount(Sessions, '/library/sessions');
    await openActions('Title s-incog');
    expect(menuLabels()).toContain('Rename');
    expect(menuLabels()).not.toContain('Share…');
  });

  it('hides Share… while shares.list loads', async () => {
    sharesList.mockReturnValue(new Promise(() => {}));
    await mount(Sessions, '/library/sessions');
    await openActions('Title s-ok');
    expect(menuLabels()).toContain('Rename');
    expect(menuLabels()).not.toContain('Share…');
  });

  it('hides Share… when shares.list fails', async () => {
    sharesList.mockRejectedValue(new Error('boom'));
    await mount(Sessions, '/library/sessions');
    await openActions('Title s-ok');
    expect(menuLabels()).not.toContain('Share…');
  });
});
