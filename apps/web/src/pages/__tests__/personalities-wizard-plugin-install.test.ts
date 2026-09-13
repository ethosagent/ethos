// @vitest-environment jsdom
//
// The "New personality" wizard's Plugins tab installs GLOBALLY — the web's
// `ethos plugin install <pkg>` without `--personality`. It must send no
// `personalityId`: the tab runs inside the create wizard, and the personality is
// not created until the wizard is submitted (`rpc.personalities.create` in
// `CreateWizard`). Sending the half-typed id failed installs on an empty id field,
// left orphaned `personalities/<id>/plugins.lock` files on cancel or rename, and
// wrote no `plugins:` line because there was no `config.yaml` yet. The Library
// page's install is pinned the same way in `plugins-install-global.test.ts`.

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

const installFn = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    plugins: {
      list: async () => ({ plugins: [], mcpServers: [] }),
      install: (...args: unknown[]) => installFn(...args),
    },
  },
}));

const { WizardPluginsTab } = await import('../Personalities');

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

async function renderTab(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          AntApp,
          null,
          createElement(WizardPluginsTab, { selected: [], onChange: () => {} }),
        ),
      ),
    );
  });
  await flush();
}

async function installSpec(spec: string): Promise<void> {
  await act(async () => buttonByText('Install plugin').click());
  const input = container.querySelector<HTMLInputElement>(
    'input[placeholder="npm package name or path"]',
  );
  if (!input) throw new Error('install input not rendered');
  await typeInto(input, spec);
  await act(async () => buttonByText('Install').click());
  await flush();
}

describe('create wizard Plugins tab install', () => {
  it('sends exactly { packageSpec } — the personality is not created until the wizard is submitted', async () => {
    await renderTab();
    await installSpec('my-plugin@1.0.0');

    expect(installFn).toHaveBeenCalledTimes(1);
    const arg = installFn.mock.calls[0]?.[0];
    expect(arg).toEqual({ packageSpec: 'my-plugin@1.0.0' });
    expect(arg).not.toHaveProperty('personalityId');
  });

  it('completes an install while the wizard has no personality id yet', async () => {
    await renderTab();
    await installSpec('my-plugin');

    expect(installFn).toHaveBeenCalledTimes(1);
    // On success the install row closes and the "Install plugin" button returns.
    expect(container.querySelector('input[placeholder="npm package name or path"]')).toBeNull();
    expect(buttonByText('Install plugin')).toBeTruthy();
  });
});
