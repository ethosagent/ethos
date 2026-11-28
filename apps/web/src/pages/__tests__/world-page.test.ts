// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
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

const listFn = vi.fn();
const schemaFn = vi.fn();
const graphFn = vi.fn();
const treeFn = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: { worlds: { list: listFn, schema: schemaFn, graph: graphFn, tree: treeFn } },
}));

const { World } = await import('../World');

const summary = (entities: number) => ({
  id: 'world:acme',
  title: 'Acme',
  audience: 'shareable',
  backend: 'sqlite',
  counts: { entities, liveEdges: 3, pendingProposals: 0 },
  mountedBy: [
    { personalityId: 'researcher', mode: 'read', effective: 'read' },
    { personalityId: 'engineer', mode: 'propose', effective: 'read', note: 'world is owner_only' },
  ],
});

const schemaOut = (edgeType: string) => ({
  version: 1,
  yaml: '',
  parsed: {
    version: 1,
    entities: { Person: { attrs: {} }, Team: { attrs: {} } },
    edges: { [edgeType]: { from: ['Person'], to: ['Team'], attrs: {} } },
  },
  sensitive: [],
  changelog: [],
  versions: [],
  loadErrors: [],
});

let root: Root;
let host: HTMLElement;

async function mount(url = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MemoryRouter, { initialEntries: [url] }, createElement(World)),
      ),
    );
  });
  // Worlds, then the schema, then the view's own query: let each settle.
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  graphFn.mockResolvedValue({ nodes: [], edges: [], truncated: false });
  treeFn.mockResolvedValue({
    groups: [{ type: 'Person', entities: [{ id: 'e1', name: 'Ada', edgeCount: 1, isNew: false }] }],
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe('World page', () => {
  it('header lists mounting personalities and inert mounts', async () => {
    listFn.mockResolvedValue({ worlds: [summary(10)] });
    schemaFn.mockResolvedValue(schemaOut('works_with'));
    await mount();
    const header = host.querySelector('.world-header')?.textContent ?? '';
    expect(header).toContain('Acme');
    expect(header).toContain('shareable');
    expect(header).toContain('researcher');
    expect(header).toContain('engineer');
    expect(header).toContain('inert: world is owner_only');
    const inert = [...host.querySelectorAll('[data-inert="true"]')];
    expect(inert).toHaveLength(1);
    expect(inert[0]?.textContent).toContain('engineer');
  });

  it('large world opens on search', async () => {
    listFn.mockResolvedValue({ worlds: [summary(501)] });
    schemaFn.mockResolvedValue(schemaOut('works_with'));
    await mount();
    expect(host.querySelector('input[aria-label="Search entities"]')).not.toBeNull();
    expect(host.querySelector('.world-canvas')).toBeNull();
    expect(graphFn).not.toHaveBeenCalled();
    expect(treeFn).toHaveBeenCalled();
  });

  it('opens on the tree when the schema has member_of', async () => {
    listFn.mockResolvedValue({ worlds: [summary(10)] });
    schemaFn.mockResolvedValue(schemaOut('member_of'));
    await mount();
    expect(host.querySelector('.world-tree')?.textContent).toContain('Ada');
    expect(graphFn).not.toHaveBeenCalled();
  });

  it('says so when there are no worlds', async () => {
    listFn.mockResolvedValue({ worlds: [] });
    await mount();
    expect(host.textContent).toContain('No worlds yet.');
  });
});
