// @vitest-environment jsdom
//
// B3 follow-up — version skew on `config.get`. The contract marks `resolved`
// required, but an OLDER backend simply does not send it, and the type being
// required does not make the wire honest: `SettingsShell` read
// `data.resolved.warnings` and `GeneralPane` read `config.resolved`, so the
// whole Settings surface crashed against a backend one release behind. Both
// sites feature-detect now, and an `apiKey.source` this build does not know
// (a NEWER backend, e.g. `missing`) renders verbatim instead of masquerading
// as "inline in config.yaml".
//
// Mounted for real — shell, rail, form, General pane — on the same complete
// fixture the callouts test uses; `matchMedia`/`ResizeObserver` stubs as in
// `models-pane.test.ts`.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

const configGet = vi.fn();
const configUpdate = vi.fn();
const personalitiesList = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    config: {
      get: (...args: unknown[]) => configGet(...args),
      update: (...args: unknown[]) => configUpdate(...args),
    },
    personalities: { list: (...args: unknown[]) => personalitiesList(...args) },
  },
}));

const { SettingsShell } = await import('../SettingsShell');
const { GeneralPane } = await import('../panes/general');
const { configGetFixture } = await import('./config-get-fixture');

let container: HTMLDivElement;
let root: Root;

async function mountSettings(config: unknown): Promise<void> {
  // Seeded into the cache (the `models-pane.test.ts` pattern) so the shell
  // renders with data on the first pass instead of racing an async fetch
  // through `act`.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  queryClient.setQueryData(['config'], config);
  queryClient.setQueryData(['personalities', 'list'], { items: [] });
  configGet.mockResolvedValue(config);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          AntApp,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: ['/settings/general'] },
            createElement(
              Routes,
              null,
              createElement(
                Route,
                { path: '/settings', element: createElement(SettingsShell) },
                createElement(Route, { path: ':category', element: createElement(GeneralPane) }),
              ),
            ),
          ),
        ),
      ),
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  configGet.mockReset();
  configUpdate.mockReset();
  personalitiesList.mockReset();
  personalitiesList.mockResolvedValue({ items: [] });
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

describe('Settings — config.get without `resolved` (older backend)', () => {
  it('renders the surface instead of crashing, with no Resolved block', async () => {
    const { resolved: _resolved, ...withoutResolved } = configGetFixture();

    await mountSettings(withoutResolved);

    // The shell and the General pane both rendered.
    expect(container.textContent).toContain('Settings');
    expect(container.textContent).toContain('basics');
    // No Resolved block — feature-detected, not faked.
    expect(container.querySelector('[data-testid="settings-resolved"]')).toBeNull();
  });
});

describe('Settings — an unknown apiKey.source renders verbatim', () => {
  it('shows the unfamiliar source string, never "inline in config.yaml"', async () => {
    const cfg = configGetFixture();
    await mountSettings({
      ...cfg,
      resolved: {
        ...cfg.resolved,
        // A newer backend's widened enum — this build has no branch for it.
        apiKey: { provider: 'anthropic', source: 'missing' },
      },
    });

    const block = container.querySelector('[data-testid="settings-resolved"]');
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain('missing');
    expect(block?.textContent).not.toContain('inline in config.yaml');
  });
});
