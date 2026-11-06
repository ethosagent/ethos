// @vitest-environment jsdom
//
// The MCP and Skills header buttons, and StageHeader's `?create=1`, open the
// catalog browser modal (plan/phases/unified-catalog.md §5.3); the modal's
// manual link then reaches the page's existing manual path.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
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

let search = '';
vi.mock('react-router-dom', () => ({
  useParams: () => ({}),
  useNavigate: () => () => {},
  useSearchParams: () => [new URLSearchParams(search), () => {}],
  Link: ({ children }: { children: unknown }) => children,
}));

vi.mock('../../rpc', () => ({
  rpc: {
    catalog: { list: async () => ({ version: 1, entries: [] }) },
    plugins: { list: async () => ({ plugins: [], mcpServers: [] }) },
    skills: { list: async () => ({ skills: [], pendingCount: 0 }) },
    personalities: { list: async () => ({ items: [] }) },
    mcp: { list: async () => ({ servers: [] }) },
  },
  client: {},
}));

const { Mcp } = await import('../Mcp');
const { Skills } = await import('../Skills');

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(page: typeof Mcp): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AntApp, null, createElement(page)),
      ),
    );
  });
  await flush();
}

function button(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

const hasModal = () => document.body.textContent?.includes('Add from catalog') ?? false;

beforeEach(() => {
  search = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe.each([
  ['MCP', Mcp, '+ New MCP Server', 'Custom server…'],
  ['Skills', Skills, '+ New Skill', 'Write a skill…'],
] as const)('%s page opens the catalog modal', (_name, page, header, manual) => {
  it('header button opens it, and the manual link is offered', async () => {
    await mount(page);
    expect(hasModal()).toBe(false);
    await act(async () => button(header)?.click());
    await flush();
    expect(hasModal()).toBe(true);
    expect(button(manual)).toBeDefined();
  });

  it('?create=1 opens it', async () => {
    search = 'create=1';
    await mount(page);
    expect(hasModal()).toBe(true);
  });
});
