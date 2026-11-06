// @vitest-environment jsdom
//
// The Add-MCP dialog needs a real DOM: every case here is about what the
// catalog picker does when it is opened and clicked, and Antd's Select renders
// its option list only once open — and into a portal on `document.body`, not
// into the render container. So assertions run against `document.body`.
//
// The catalog itself is seeded into the query cache rather than fetched, the
// same way `personality-voice-fields.test.ts` seeds its provider queries: the
// component under test is the picker, not react-query's retry timing.

import type { CatalogListEntry } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogKeys } from '../../../features/catalog/api/queries';

// Two browser APIs jsdom does not implement that Antd reaches for on mount:
// the responsive observer behind `Modal`'s breakpoints, and the resize
// observer behind the Select dropdown's virtual list. Both are stubs — nothing
// here asserts on layout.
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

const startFn = vi.fn();
const addServerFn = vi.fn();
const validateConfigFn = vi.fn();
const listFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    catalog: {
      list: (...args: unknown[]) => listFn(...args),
    },
    mcp: {
      start: (...args: unknown[]) => startFn(...args),
      addServer: (...args: unknown[]) => addServerFn(...args),
      validateConfig: (...args: unknown[]) => validateConfigFn(...args),
    },
  },
}));

const { AddMcpModal, composeLocalPresetCommand, shellQuote } = await import('../AddMcpModal');

/** A remote MCP entry as `catalog.list` serves it (`id` is the preset name). */
function remote(
  id: string,
  name: string,
  url: string,
  auth: 'none' | 'oauth' | 'bearer',
  description: string,
  category: string,
): CatalogListEntry {
  return {
    id,
    kind: 'mcp',
    name,
    description,
    category,
    publisher: name,
    tier: 'verified',
    pin: { type: 'remote', url, transport: 'streamable-http' },
    capabilities: { network: [], auth, env: [], filesystem: 'none', shell: false },
    license: null,
    reviewedAt: '2026-11-05',
    installed: false,
    action: { type: 'add', name: id, url },
  };
}

function local(
  id: string,
  description: string,
  category: string,
  pkg: string,
  version: string,
  mcp: { argVars: string[]; envVars: string[] },
): CatalogListEntry {
  return {
    id,
    kind: 'mcp',
    name: id,
    description,
    category,
    publisher: 'test',
    tier: 'verified',
    pin: { type: 'npm', package: pkg, version, integrity: 'sha512-fixture' },
    capabilities: { network: [], auth: 'none', env: [], filesystem: 'none', shell: false },
    license: 'MIT',
    reviewedAt: '2026-11-05',
    mcp: { argsAfterSpec: [], ...mcp },
    installed: false,
    action: { type: 'cli', command: `ethos catalog install ${id}` },
  };
}

const CATALOG = {
  version: 1 as const,
  entries: [
    remote(
      'context7',
      'Context7',
      'https://mcp.context7.com/mcp',
      'none',
      'Up-to-date library documentation',
      'Docs & knowledge',
    ),
    remote(
      'linear',
      'Linear',
      'https://mcp.linear.app/mcp',
      'oauth',
      'Read and update Linear issues, projects, and cycles',
      'Productivity',
    ),
    remote(
      'wolfram',
      'Wolfram',
      'https://mcp.wolframalpha.com/mcp',
      'bearer',
      'Computational knowledge queries',
      'Docs & knowledge',
    ),
    // The server takes its allowed directory positionally, not from the
    // environment — hence argVars, not envVars.
    local(
      'filesystem',
      'Read/write local files under a required allowed path',
      'Developer tools',
      '@modelcontextprotocol/server-filesystem',
      '2.2.0',
      { argVars: ['ALLOWED_PATH'], envVars: [] },
    ),
    local(
      'memory',
      'Key-value memory store',
      'Utilities',
      '@modelcontextprotocol/server-memory',
      '2.1.0',
      { argVars: [], envVars: ['MEMORY_FILE_PATH'] },
    ),
  ],
};

let container: HTMLDivElement;
let root: Root;

/** Mount the modal open, with the catalog already in the query cache. */
function mount(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(catalogKeys.list('mcp'), CATALOG);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AddMcpModal, { open: true, onClose: () => {} }),
      ),
    );
  });
}

function fire(el: Element, type: string): void {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });
}

/** Switch the mode radio (Preset / Remote URL / Local Command). */
function selectMode(labelText: string): void {
  const radio = Array.from(document.body.querySelectorAll('label.ant-radio-button-wrapper')).find(
    (el) => el.textContent?.trim() === labelText,
  );
  expect(radio, `missing mode: ${labelText}`).toBeDefined();
  const input = radio?.querySelector('input') as HTMLInputElement;
  act(() => {
    input.click();
  });
}

/**
 * Open the nth Antd Select on screen. Antd v6 renders the closed control as
 * `.ant-select-content` (v5's `.ant-select-selector` is gone) and mounts the
 * option list into a portal on `document.body` only once it opens.
 */
function openSelect(index = 0): void {
  const selectors = document.body.querySelectorAll('.ant-select-content');
  const selector = selectors[index];
  expect(selector, `missing select #${index}`).toBeDefined();
  if (selector) fire(selector, 'mousedown');
}

function optionByText(text: string): Element {
  const option = Array.from(document.body.querySelectorAll('.ant-select-item-option')).find((el) =>
    el.textContent?.includes(text),
  );
  expect(option, `missing option: ${text}`).toBeDefined();
  return option as Element;
}

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = document.body.querySelector(
    `input[placeholder="${placeholder}"]`,
  ) as HTMLInputElement | null;
  expect(input, `missing input: ${placeholder}`).not.toBeNull();
  return input as HTMLInputElement;
}

/** React tracks input state off the native setter, so bypass the wrapper. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function clickRegister(): Promise<void> {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Register',
  ) as HTMLButtonElement | undefined;
  expect(button, 'missing Register button').toBeDefined();
  expect(button?.disabled, 'Register is disabled').toBe(false);
  // react-query dispatches the mutation fn in a microtask, so the RPC spy is
  // only settled after the queue drains.
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  startFn.mockResolvedValue({ ok: true, serverName: 'x' });
  addServerFn.mockResolvedValue({ ok: true, serverName: 'x' });
  validateConfigFn.mockResolvedValue({ valid: true, errors: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('AddMcpModal — remote catalog picker', () => {
  it('renders catalog entries grouped by category, with description and auth badge', () => {
    mount();
    openSelect(0);

    const groupLabels = Array.from(document.body.querySelectorAll('.ant-select-item-group')).map(
      (el) => el.textContent,
    );
    expect(groupLabels).toEqual(['Docs & knowledge', 'Productivity']);

    // Docs & knowledge holds the two entries that share it; Productivity holds
    // Linear alone — grouping, not a flat list in name order.
    const context7 = optionByText('Context7');
    expect(context7.textContent).toContain('No auth');
    expect(context7.textContent).toContain('Up-to-date library documentation');

    const linear = optionByText('Linear');
    expect(linear.textContent).toContain('OAuth');
    expect(linear.textContent).toContain('Read and update Linear issues');

    const wolfram = optionByText('Wolfram');
    expect(wolfram.textContent).toContain('API key');
    expect(wolfram.textContent).toContain('Computational knowledge queries');
  });

  it('oauth preset → mcp.start with the preset URL, no addServer', async () => {
    mount();
    openSelect(0);
    fire(optionByText('Linear'), 'click');
    await clickRegister();

    expect(startFn).toHaveBeenCalledTimes(1);
    expect(startFn).toHaveBeenCalledWith({ url: 'https://mcp.linear.app/mcp' });
    expect(addServerFn).not.toHaveBeenCalled();
  });

  it('no-auth preset → mcp.addServer with authType none and no token', async () => {
    mount();
    openSelect(0);
    fire(optionByText('Context7'), 'click');
    // No token field is offered for a no-auth entry.
    expect(document.body.querySelector('input[type="password"]')).toBeNull();
    await clickRegister();

    expect(addServerFn).toHaveBeenCalledTimes(1);
    expect(addServerFn).toHaveBeenCalledWith({
      name: 'context7',
      url: 'https://mcp.context7.com/mcp',
      transport: 'streamable-http',
      authType: 'none',
    });
    expect(startFn).not.toHaveBeenCalled();
  });

  it('bearer preset → mcp.addServer with authType bearer and the typed key', async () => {
    mount();
    openSelect(0);
    fire(optionByText('Wolfram'), 'click');

    const tokenInput = inputByPlaceholder('API key (optional)');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(tokenInput, 'sk-test');
      tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickRegister();

    expect(addServerFn).toHaveBeenCalledTimes(1);
    expect(addServerFn).toHaveBeenCalledWith({
      name: 'wolfram',
      url: 'https://mcp.wolframalpha.com/mcp',
      transport: 'streamable-http',
      authType: 'bearer',
      token: 'sk-test',
    });
    expect(startFn).not.toHaveBeenCalled();
  });
});

describe('AddMcpModal — local preset tab', () => {
  it('pre-fills command, args and name, and opens one input per arg var', () => {
    mount();
    selectMode('Local Command');
    openSelect(0);
    fire(optionByText('filesystem'), 'click');

    expect(inputByPlaceholder('Command (e.g. npx, python)').value).toBe('npx');
    expect(inputByPlaceholder('Args (comma-separated, optional)').value).toBe(
      '-y, --ignore-scripts, @modelcontextprotocol/server-filesystem@2.2.0',
    );
    expect(inputByPlaceholder('Server name (required)').value).toBe('filesystem');
    expect(document.body.textContent).toContain('ALLOWED_PATH');
    expect(inputByPlaceholder('required')).not.toBeNull();
  });

  it('opens one input per env var, marked optional', () => {
    mount();
    selectMode('Local Command');
    openSelect(0);
    fire(optionByText('memory'), 'click');

    expect(document.body.textContent).toContain('MEMORY_FILE_PATH');
    expect(inputByPlaceholder('optional')).not.toBeNull();
  });

  it('shows the CLI command that actually registers the preset, with the typed arg', () => {
    mount();
    selectMode('Local Command');
    openSelect(0);
    fire(optionByText('filesystem'), 'click');

    expect(document.body.textContent).toContain('registered from the CLI, not the browser');
    expect(document.body.textContent).toContain("ethos mcp add 'filesystem' --preset filesystem");

    typeInto(inputByPlaceholder('required'), '/data');

    expect(document.body.textContent).toContain(
      "ethos mcp add 'filesystem' --preset filesystem --arg 'ALLOWED_PATH=/data'",
    );
    // Once filled, nothing is left to warn about.
    expect(document.body.textContent).not.toContain('refuses every call without it');
  });

  it('renders an unfilled required arg as a visible placeholder, never omitted', () => {
    mount();
    selectMode('Local Command');
    openSelect(0);
    fire(optionByText('filesystem'), 'click');

    // Dropping the flag would hand over a command that registers a server
    // which starts and then fails every tool call. The placeholder stays bare
    // — `<` is redirection syntax, so the half-filled line refuses to run.
    expect(document.body.textContent).toContain(
      "ethos mcp add 'filesystem' --preset filesystem --arg ALLOWED_PATH=<ALLOWED_PATH>",
    );
    expect(document.body.textContent).toContain('Replace ALLOWED_PATH');
  });

  it('emits --env for an env var and no --arg for a preset that declares none', () => {
    mount();
    selectMode('Local Command');
    openSelect(0);
    fire(optionByText('memory'), 'click');

    expect(document.body.textContent).toContain("ethos mcp add 'memory' --preset memory");
    expect(document.body.textContent).not.toContain('--arg');
    expect(document.body.textContent).not.toContain('--env');

    typeInto(inputByPlaceholder('optional'), '/data/memory.json');

    expect(document.body.textContent).toContain(
      "ethos mcp add 'memory' --preset memory --env 'MEMORY_FILE_PATH=/data/memory.json'",
    );
    expect(document.body.textContent).not.toContain('--arg');
  });

  it('disables Command and Args while a preset is selected, re-enabling on clear', () => {
    mount();
    selectMode('Local Command');
    openSelect(0);
    fire(optionByText('filesystem'), 'click');

    // The composed CLI line is built from the preset, not from these two
    // fields, so editing them would change nothing. They stay visible — they
    // show what the preset will run — but stop accepting input.
    expect(inputByPlaceholder('Command (e.g. npx, python)').disabled).toBe(true);
    expect(inputByPlaceholder('Args (comma-separated, optional)').disabled).toBe(true);
    // The server name IS used by the composed line, so it stays live.
    expect(inputByPlaceholder('Server name (required)').disabled).toBe(false);

    const clear = document.body.querySelector('.ant-select-clear');
    expect(clear, 'missing allowClear control').not.toBeNull();
    if (clear) fire(clear, 'mousedown');

    // Cleared: editable again, with the preset's values left as a starting
    // point for manual entry.
    expect(inputByPlaceholder('Command (e.g. npx, python)').disabled).toBe(false);
    expect(inputByPlaceholder('Command (e.g. npx, python)').value).toBe('npx');
    expect(inputByPlaceholder('Args (comma-separated, optional)').disabled).toBe(false);
  });

  it('disables Register for a catalog preset — the API refuses stdio adds', () => {
    mount();
    selectMode('Local Command');
    openSelect(0);
    fire(optionByText('memory'), 'click');

    const register = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Register',
    ) as HTMLButtonElement;
    expect(register.disabled).toBe(true);
  });

  it('keeps manual entry submitting — Register stays live with no preset picked', async () => {
    mount();
    selectMode('Local Command');

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    const type = (input: HTMLInputElement, value: string) => {
      act(() => {
        setter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    type(inputByPlaceholder('Command (e.g. npx, python)'), 'python');
    type(inputByPlaceholder('Server name (required)'), 'mine');

    const register = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Register',
    ) as HTMLButtonElement;
    expect(register.disabled).toBe(false);

    await act(async () => {
      register.click();
      await Promise.resolve();
    });
    expect(addServerFn).toHaveBeenCalledWith({
      name: 'mine',
      transport: 'stdio',
      command: 'python',
    });
  });
});

describe('AddMcpModal — pure helpers', () => {
  it('drops blank env values from the CLI command', () => {
    expect(
      composeLocalPresetCommand({
        name: 'fs',
        preset: 'filesystem',
        args: [],
        env: { SOMETHING: '  ', OTHER: ' /tmp ' },
      }),
    ).toBe("ethos mcp add 'fs' --preset filesystem --env 'OTHER=/tmp'");
  });

  it('emits --arg values in declaration order, before the --env flags', () => {
    expect(
      composeLocalPresetCommand({
        name: 'multi',
        preset: 'multi',
        args: [
          { name: 'FIRST', value: ' /a ' },
          { name: 'SECOND', value: '/b' },
        ],
        env: { KEY: 'v' },
      }),
    ).toBe("ethos mcp add 'multi' --preset multi --arg 'FIRST=/a' --arg 'SECOND=/b' --env 'KEY=v'");
  });

  it('keeps an unfilled required arg as a placeholder instead of dropping it', () => {
    expect(
      composeLocalPresetCommand({
        name: 'fs',
        preset: 'filesystem',
        args: [{ name: 'ALLOWED_PATH', value: '   ' }],
        env: {},
      }),
    ).toBe("ethos mcp add 'fs' --preset filesystem --arg ALLOWED_PATH=<ALLOWED_PATH>");
  });

  it('quotes a value containing a space so it stays one shell word', () => {
    // The ordinary case that broke: `/home/me/My Code` split into two words
    // and registered the wrong allowed path.
    expect(
      composeLocalPresetCommand({
        name: 'my fs',
        preset: 'filesystem',
        args: [{ name: 'ALLOWED_PATH', value: '/home/me/My Code' }],
        env: { NOTE: 'two words' },
      }),
    ).toBe(
      "ethos mcp add 'my fs' --preset filesystem --arg 'ALLOWED_PATH=/home/me/My Code' --env 'NOTE=two words'",
    );
  });

  it('ends and re-opens the quote around an embedded single quote', () => {
    expect(
      composeLocalPresetCommand({
        name: "o'brien",
        preset: 'filesystem',
        args: [{ name: 'ALLOWED_PATH', value: "/home/o'brien/code" }],
        env: {},
      }),
    ).toBe(
      "ethos mcp add 'o'\\''brien' --preset filesystem --arg 'ALLOWED_PATH=/home/o'\\''brien/code'",
    );
  });

  it('neutralises shell metacharacters in a value', () => {
    // Unquoted, `;` would end the command and `$(…)` would execute.
    expect(
      composeLocalPresetCommand({
        name: 'fs',
        preset: 'filesystem',
        args: [{ name: 'ALLOWED_PATH', value: '/tmp; rm -rf ~' }],
        env: { EVIL: '$(id) `whoami` > /tmp/out' },
      }),
    ).toBe(
      "ethos mcp add 'fs' --preset filesystem --arg 'ALLOWED_PATH=/tmp; rm -rf ~' --env 'EVIL=$(id) `whoami` > /tmp/out'",
    );
  });

  it('quotes for POSIX sh, ending and re-opening around each single quote', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote('My Code')).toBe("'My Code'");
    expect(shellQuote('')).toBe("''");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
    expect(shellQuote('$(id) `x` ; & | > <')).toBe("'$(id) `x` ; & | > <'");
  });
});
