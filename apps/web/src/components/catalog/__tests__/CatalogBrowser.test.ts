// @vitest-environment jsdom
//
// Same rendering approach as the retired McpCatalogSection test: the catalog
// is seeded into the query cache rather than fetched, and assertions run
// against `document.body` because Antd portals render outside the container.

import type { CatalogListEntry } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogKeys } from '../../../features/catalog/api/queries';

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

const listFn = vi.fn();
const addServerFn = vi.fn();
const startFn = vi.fn();
const installFn = vi.fn();
const statusFn = vi.fn();
const cancelFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    catalog: {
      list: (...a: unknown[]) => listFn(...a),
      install: (...a: unknown[]) => installFn(...a),
    },
    mcp: {
      addServer: (...a: unknown[]) => addServerFn(...a),
      start: (...a: unknown[]) => startFn(...a),
      status: (...a: unknown[]) => statusFn(...a),
      cancel: (...a: unknown[]) => cancelFn(...a),
    },
  },
}));

const { CatalogBrowser } = await import('../CatalogBrowser');

function make(over: Partial<CatalogListEntry> & { id: string; name: string }): CatalogListEntry {
  return {
    kind: 'mcp',
    description: `${over.name} description`,
    category: 'Productivity',
    publisher: 'pub',
    tier: 'verified',
    pin: {
      type: 'remote',
      url: `https://mcp.${over.id}.example/mcp`,
      transport: 'streamable-http',
    },
    capabilities: { network: [], auth: 'none', env: [], filesystem: 'none', shell: false },
    license: null,
    reviewedAt: '2026-09-04',
    installed: false,
    action: { type: 'add', name: over.id, url: `https://mcp.${over.id}.example/mcp` },
    ...over,
  };
}

const ENTRIES: CatalogListEntry[] = [
  make({ id: 'context7', name: 'Context7', category: 'Docs & knowledge' }),
  make({
    id: 'linear',
    name: 'Linear',
    capabilities: { network: [], auth: 'oauth', env: [], filesystem: 'none', shell: false },
    action: { type: 'oauth', url: 'https://mcp.linear.app/mcp', name: 'linear' },
  }),
  make({
    id: 'filesystem',
    name: 'filesystem',
    category: 'Developer tools',
    tier: 'community',
    pin: { type: 'npm', package: '@scope/fs', version: '1.0.0', integrity: 'sha512-x' },
    capabilities: { network: [], auth: 'none', env: [], filesystem: 'user-path', shell: false },
    action: { type: 'cli', command: 'ethos catalog install filesystem --arg ALLOWED_PATH=<path>' },
  }),
  make({
    id: 'toolbox',
    name: 'Toolbox',
    kind: 'plugin',
    category: 'Utilities',
    action: { type: 'install' },
  }),
  make({ id: 'done', name: 'AlreadyHere', installed: true }),
];

let container: HTMLDivElement;
let root: Root;

let queryClient: QueryClient;

function mount(entries: CatalogListEntry[] = ENTRIES): void {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(catalogKeys.list('mcp'), { version: 1, entries });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AntApp, null, createElement(CatalogBrowser, { kind: 'mcp', mode: 'inline' })),
      ),
    );
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  );
  expect(button, `missing button: ${text}`).toBeDefined();
  return button as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  listFn.mockResolvedValue({ version: 1, entries: ENTRIES });
  addServerFn.mockResolvedValue({ ok: true, serverName: 'context7' });
  startFn.mockResolvedValue({
    ok: true,
    state: 'state-1',
    authorizeUrl: 'https://example.com/authorize',
    serverName: 'linear',
  });
  vi.stubGlobal(
    'open',
    vi.fn(() => ({ closed: false }) as unknown as Window),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('CatalogBrowser', () => {
  it('omits installed entries', () => {
    mount();
    expect(document.body.textContent).not.toContain('AlreadyHere');
    expect(document.body.textContent).toContain('Context7');
  });

  it('groups by category in server order', () => {
    mount();
    const labels = Array.from(document.body.querySelectorAll('.ant-typography'))
      .map((el) => el.textContent?.trim())
      .filter((t) => ['Docs & knowledge', 'Productivity', 'Developer tools'].includes(t ?? ''));
    expect(labels).toEqual(['Docs & knowledge', 'Productivity', 'Developer tools']);
  });

  it('community shows the ⚠ glyph and the word', () => {
    mount();
    expect(document.body.textContent).toContain('⚠ community');
  });

  it('renders the capability line and the matching button copy', () => {
    mount();
    expect(document.body.textContent).toContain('mcp.linear.example · OAuth · no files');
    expect(document.body.textContent).toContain('npm @scope/fs@1.0.0 · your path');
    expect(buttonByText('Connect')).toBeDefined();
    expect(buttonByText('Add')).toBeDefined();
    expect(buttonByText('Copy command')).toBeDefined();
  });

  it('oauth click calls mcp.start with name=id and no personalityId', async () => {
    mount();
    await act(async () => {
      buttonByText('Connect').click();
      await Promise.resolve();
    });
    expect(startFn).toHaveBeenCalledWith({ url: 'https://mcp.linear.app/mcp', name: 'linear' });
    expect(startFn.mock.calls[0]?.[0]).not.toHaveProperty('personalityId');
    expect(addServerFn).not.toHaveBeenCalled();
  });

  it('add click calls mcp.addServer and shows a persistent registered row', async () => {
    mount();
    await act(async () => {
      buttonByText('Add').click();
      await Promise.resolve();
    });
    expect(addServerFn).toHaveBeenCalledWith({
      name: 'context7',
      url: 'https://mcp.context7.example/mcp',
      transport: 'streamable-http',
      authType: 'none',
    });
    expect(startFn).not.toHaveBeenCalled();
    expect(document.body.querySelector('.activity-row')?.textContent).toContain('✓ ok');
    expect(document.body.querySelector('.activity-row')?.textContent).toContain('registered');
  });

  it('a failed add shows the reason in the row, not a toast', async () => {
    addServerFn.mockResolvedValue({ ok: false, code: 'DUPLICATE', detail: 'already there' });
    mount();
    await act(async () => {
      buttonByText('Add').click();
      await Promise.resolve();
    });
    expect(document.body.querySelector('.activity-row')?.textContent).toContain('✗ failed');
    expect(document.body.querySelector('.activity-row')?.textContent).toContain('already there');
    expect(document.body.querySelector('.ant-notification')).toBeNull();
  });

  it('cli rows copy the command and call no RPC', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    mount();
    await act(async () => {
      buttonByText('Copy command').click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(
      'ethos catalog install filesystem --arg ALLOWED_PATH=<path>',
    );
    expect(addServerFn).not.toHaveBeenCalled();
    expect(startFn).not.toHaveBeenCalled();
  });

  it('with no clipboard (non-secure context) the command stays on screen as selectable text', async () => {
    vi.stubGlobal('navigator', {});
    mount();
    await act(async () => {
      buttonByText('Copy command').click();
      await Promise.resolve();
    });
    const code = document.body.querySelector('code');
    expect(code?.textContent).toBe('ethos catalog install filesystem --arg ALLOWED_PATH=<path>');
    expect(document.body.querySelector('.activity-row')?.textContent).toContain(
      'Clipboard unavailable',
    );
    expect(addServerFn).not.toHaveBeenCalled();
  });

  it('an acted-on entry stays visible with its row after the refetch marks it installed', async () => {
    mount();
    await act(async () => {
      buttonByText('Add').click();
      await Promise.resolve();
    });
    await act(async () => {
      queryClient.setQueryData(catalogKeys.list('mcp'), {
        version: 1,
        entries: ENTRIES.map((e) => (e.id === 'context7' ? { ...e, installed: true } : e)),
      });
    });
    expect(document.body.textContent).toContain('Context7');
    expect(document.body.querySelector('.activity-row')?.textContent).toContain('registered');
  });

  it('modal empty state for plugins has no inline manual link (only the bottom one)', async () => {
    listFn.mockResolvedValue({ version: 1, entries: [] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(catalogKeys.list('plugin'), { version: 1, entries: [] });
    const onManual = vi.fn();
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(
            AntApp,
            null,
            createElement(CatalogBrowser, {
              kind: 'plugin',
              mode: 'modal',
              open: true,
              onManual,
            }),
          ),
        ),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.body.textContent).toContain('No reviewed plugins yet.');
    const links = Array.from(document.body.querySelectorAll('button')).filter(
      (b) => b.textContent?.trim() === 'Install by npm spec…',
    );
    expect(links).toHaveLength(1);
  });

  it('install click calls catalog.install with exactly {id} and shows the grantHint', async () => {
    installFn.mockResolvedValue({
      ok: true,
      kind: 'plugin',
      id: 'toolbox',
      installedAs: 'toolbox',
      grantHint: 'Grant it on the Plugins page.',
    });
    mount();
    await act(async () => {
      buttonByText('Install').click();
      await Promise.resolve();
    });
    expect(installFn).toHaveBeenCalledTimes(1);
    expect(installFn.mock.calls[0]).toEqual([{ id: 'toolbox' }]);
    const row = document.body.querySelector('.activity-row')?.textContent;
    expect(row).toContain('✓ ok');
    expect(row).toContain('Grant it on the Plugins page.');
  });

  it('a CATALOG_SCAN_BLOCKED error shows a failed row and no toast', async () => {
    installFn.mockRejectedValue(new Error('Blocked by the scanner: 1 red finding'));
    mount();
    await act(async () => {
      buttonByText('Install').click();
      await Promise.resolve();
    });
    const row = document.body.querySelector('.activity-row')?.textContent;
    expect(row).toContain('✗ failed');
    expect(row).toContain('Blocked by the scanner');
    expect(document.body.querySelector('.ant-notification')).toBeNull();
  });
});
