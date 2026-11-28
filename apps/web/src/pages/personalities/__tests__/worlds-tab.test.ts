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

const mountsFn = vi.fn();
const mountsSaveFn = vi.fn();
const listFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: { worlds: { mounts: mountsFn, mountsSave: mountsSaveFn, list: listFn } },
}));

const { WorldsTab } = await import('../WorldsTab');

const summary = (slug: string, title: string) => ({
  id: `world:${slug}`,
  title,
  audience: 'shareable',
  backend: 'sqlite',
  counts: { entities: 1, liveEdges: 0, pendingProposals: 0 },
  mountedBy: [],
});

let root: Root;
let host: HTMLElement;

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          null,
          createElement(WorldsTab, { id: 'engineer', onDirtyChange: () => {} }),
        ),
      ),
    );
  });
  await settle();
}

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function saveButton(): HTMLButtonElement | null {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Save');
  return b ?? null;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  listFn.mockResolvedValue({
    worlds: [
      summary('acme', 'Acme'),
      summary('ops', 'Ops'),
      { ...summary('x', 'engineer (private)'), id: 'personality:engineer' },
    ],
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe('Worlds tab', () => {
  it('inert mount shows the reason', async () => {
    mountsFn.mockResolvedValue({
      mounts: [{ world: 'acme', mode: 'propose' }],
      effective: [{ world: 'acme', effective: 'read', note: 'inert: not in readers or proposers' }],
    });
    await render();
    const row = host.querySelector('[data-world="acme"]');
    expect(row?.textContent).toContain('acme does not list engineer as a reader');
    const link = row?.querySelector('a');
    expect(link?.getAttribute('href')).toContain('world=world%3Aacme');
    expect(link?.getAttribute('href')).toContain('view=settings');
  });

  it('alias collision blocks save', async () => {
    mountsFn.mockResolvedValue({
      mounts: [
        { world: 'acme', mode: 'read' },
        { world: 'ops', mode: 'read' },
      ],
      effective: [
        { world: 'acme', effective: 'read' },
        { world: 'ops', effective: 'read' },
      ],
    });
    await render();
    const alias = host.querySelector<HTMLInputElement>(
      '[data-world="ops"] input[aria-label="Alias for ops"]',
    );
    expect(alias).not.toBeNull();
    await act(async () => {
      if (alias) type(alias, 'acme');
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('another mounted world');
    expect(saveButton()?.disabled).toBe(true);
    await act(async () => {
      saveButton()?.click();
    });
    expect(mountsSaveFn).not.toHaveBeenCalled();

    // A free alias saves.
    await act(async () => {
      if (alias) type(alias, 'operations');
    });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    mountsSaveFn.mockResolvedValue({ ok: true, effective: [] });
    await act(async () => {
      saveButton()?.click();
    });
    expect(mountsSaveFn).toHaveBeenCalledWith({
      personalityId: 'engineer',
      mounts: [
        { world: 'acme', mode: 'read' },
        { world: 'ops', mode: 'read', as: 'operations' },
      ],
    });
  });

  it('private world is listed, not removable', async () => {
    mountsFn.mockResolvedValue({
      mounts: [{ world: 'acme', mode: 'read' }],
      effective: [{ world: 'acme', effective: 'read' }],
    });
    await render();
    const priv = host.querySelector('[data-private="true"]');
    expect(priv?.textContent).toContain('engineer');
    expect(priv?.querySelector('button')).toBeNull();
    const acme = host.querySelector('[data-world="acme"]');
    expect(acme?.textContent).toContain('Unmount');
  });
});
