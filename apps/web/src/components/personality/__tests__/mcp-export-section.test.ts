// @vitest-environment jsdom
//
// The MCP export section (plan/phases/trust-before-reach.md Part 3, M-T9),
// driven in jsdom the way `outbox-pane.test.ts` drives the Outbox pane.
//
// What an operator's trust rests on here: the pill says whether the personality
// is reachable at all; a tool the declaration named but the personality lacks is
// shown struck through with a reason, never silently dropped; Revoke really
// revokes; and the one-time key is shown once and is gone once dismissed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpExportViewWire } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

const navigateFn = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateFn }));

const mcpExportFn = vi.fn();
const updateFn = vi.fn();
const createFn = vi.fn();
const revokeFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    personalities: {
      mcpExport: (...args: unknown[]) => mcpExportFn(...args),
      update: (...args: unknown[]) => updateFn(...args),
    },
    apiKeys: {
      create: (...args: unknown[]) => createFn(...args),
      revoke: (...args: unknown[]) => revokeFn(...args),
    },
  },
}));

const { McpExportSection, desktopEntryWithSecret } = await import('../McpExportSection');

const PLACEHOLDER = '<client key>';
const SECRET = 'sk-ethos-7f3c9d2ab41e5f8c0d6a3b7e2f14c8d9';

function view(over: Partial<McpExportViewWire> = {}): McpExportViewWire {
  return {
    personalityId: 'specialist',
    exported: true,
    declaration: {
      enabled: true,
      expose_tools: ['read_file', 'web_search', 'terminal'],
      expose_memory: 'none',
      expose_sessions: false,
      auth: 'bearer',
    },
    scope: {
      allowed: ['read_file', 'web_search'],
      dropped: ['terminal'],
      memory: 'none',
      sessions: false,
      auth: 'bearer',
    },
    declarationKeys: ['enabled', 'expose_tools', 'expose_memory', 'expose_sessions', 'auth'],
    configPath: '~/.ethos/personalities/specialist/config.yaml',
    command: 'ethos mcp serve --personality specialist',
    desktopEntry: {
      name: 'ethos-specialist',
      json: JSON.stringify(
        {
          mcpServers: {
            'ethos-specialist': {
              command: '/usr/bin/node',
              args: ['/opt/ethos/index.js', 'mcp', 'serve', '--personality', 'specialist'],
              env: { ETHOS_MCP_KEY: PLACEHOLDER },
            },
          },
        },
        null,
        2,
      ),
      secretPlaceholder: PLACEHOLDER,
    },
    clients: [
      {
        id: 'key_1',
        name: 'Claude Desktop — laptop',
        prefix: 'sk-ethos-7f3c9d2a',
        createdAt: '2026-09-04T10:00:00.000Z',
        lastUsed: null,
      },
    ],
    calls: [],
    denials: [
      {
        ts: '2026-09-12T09:05:00.000Z',
        kind: 'auth',
        event: 'initialize',
        clientId: '-',
        clientName: null,
        reason: 'invalid_key',
      },
    ],
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mcpExportFn.mockReset();
  updateFn.mockReset();
  createFn.mockReset();
  revokeFn.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const TOOLSET = ['read_file', 'web_search', 'write_file', 'memory_read'];

async function mount(
  data: McpExportViewWire,
  toolset: string[] | null = TOOLSET,
): Promise<QueryClient> {
  mcpExportFn.mockResolvedValue(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(McpExportSection, { personalityId: 'specialist', toolset }),
      ),
    );
  });
  await flush();
  return client;
}

function button(label: string, scope: ParentNode = document.body): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

describe('McpExportSection', () => {
  it('shows the "Exported over MCP" pill with an icon and a word', async () => {
    await mount(view());
    const pill = container.querySelector('[data-pill="on"]');
    expect(pill?.textContent).toBe('✓Exported over MCP');
    expect(container.textContent).toContain('ethos mcp serve --personality specialist');
    expect(container.textContent).toContain('~/.ethos/personalities/specialist/config.yaml');
  });

  it('shows the "Not exported" pill, what exporting does, and Set up export — no client controls', async () => {
    await mount(view({ exported: false, declaration: null, scope: null, desktopEntry: null }));
    expect(container.querySelector('[data-pill="off"]')?.textContent).toBe('✗Not exported');
    expect(container.textContent).toContain(
      'No external app can consult specialist. Exporting lets an MCP client — Claude Desktop, Cursor — ask it a question and get a full, safeguarded turn back.',
    );
    expect(button('Set up export', container)).toBeTruthy();
    expect(container.textContent).not.toContain('Add client');
  });

  it('strikes a dropped tool through and says why, never omitting it', async () => {
    await mount(view());
    const chip = container.querySelector<HTMLElement>('[data-dropped="true"]');
    expect(chip?.textContent).toBe('terminal');
    expect(chip?.style.textDecoration).toBe('line-through');
    const line = container.querySelector('[data-testid="mcp-export-dropped"]');
    expect(line?.textContent).toContain('terminal');
    expect(line?.textContent).toContain(
      "not in this personality's toolset, so it is dropped rather than granted.",
    );
  });

  it('Revoke calls apiKeys.revoke with the key id after confirmation', async () => {
    revokeFn.mockResolvedValue({ ok: true });
    await mount(view());
    await click(button('Revoke', container));
    const popover = document.body.querySelector('.ant-popconfirm') ?? document.body;
    await click(button('Revoke', popover.querySelector('.ant-popconfirm-buttons') ?? popover));
    expect(revokeFn).toHaveBeenCalledTimes(1);
    expect(revokeFn.mock.calls[0]?.[0]).toEqual({ id: 'key_1' });
  });

  it('Add client mints an mcp:<id> key, shows the secret once beside the Desktop entry, and forgets it on dismiss', async () => {
    createFn.mockResolvedValue({
      secret: SECRET,
      key: {
        id: 'key_2',
        prefix: 'sk-ethos-7f3c9d2a',
        name: 'Claude Desktop — specialist',
        scopes: ['mcp:specialist'],
        allowedOrigins: ['http://localhost:3000'],
        createdAt: '2026-09-13T09:00:00.000Z',
        lastUsed: null,
        revokedAt: null,
      },
    });
    await mount(view());
    expect(document.body.textContent).not.toContain(SECRET);

    await click(button('Add client', container));
    await click(button('Create key', container));

    expect(createFn).toHaveBeenCalledTimes(1);
    expect(createFn.mock.calls[0]?.[0]).toMatchObject({
      name: 'Claude Desktop — specialist',
      scopes: ['mcp:specialist'],
    });

    const reveal = container.querySelector('[data-testid="mcp-export-reveal"]');
    expect(reveal?.textContent).toContain(
      'Copy this now. Ethos stores only its hash and cannot show it again.',
    );
    expect(reveal?.textContent).toContain(SECRET);
    const snippet = reveal?.querySelector('pre')?.textContent ?? '';
    expect(JSON.parse(snippet).mcpServers['ethos-specialist'].env.ETHOS_MCP_KEY).toBe(SECRET);
    expect(snippet).not.toContain(PLACEHOLDER);

    await click(button('Done', container));
    expect(container.querySelector('[data-testid="mcp-export-reveal"]')).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('with a Desktop entry, shows the JSON and no CLI notice', async () => {
    const localhost = view().scope;
    if (!localhost) throw new Error('fixture has a scope');
    await mount(view({ scope: { ...localhost, auth: 'localhost' } }));
    expect(container.querySelector('pre')?.textContent).toContain('ethos-specialist');
    expect(container.querySelector('[data-testid="mcp-export-desktop-cli"]')).toBeNull();
  });

  it('with no Desktop entry (the desktop app), says the CLI generates it and names the command', async () => {
    const localhost = view().scope;
    if (!localhost) throw new Error('fixture has a scope');
    await mount(view({ scope: { ...localhost, auth: 'localhost' }, desktopEntry: null }));
    const notice = container.querySelector('[data-testid="mcp-export-desktop-cli"]');
    expect(notice?.textContent).toContain(
      'The Claude Desktop entry is generated by the Ethos CLI. Create it with ethos mcp install claude-desktop --personality specialist.',
    );
    expect(notice?.textContent).not.toContain('client key');
    expect(container.querySelector('pre')).toBeNull();
  });

  it('with no Desktop entry under bearer auth, the key reveal carries the CLI notice instead of JSON', async () => {
    createFn.mockResolvedValue({ secret: SECRET, key: { id: 'key_2' } });
    await mount(view({ desktopEntry: null }));
    expect(container.querySelector('[data-testid="mcp-export-desktop-cli"]')).toBeNull();

    await click(button('Add client', container));
    await click(button('Create key', container));

    const reveal = container.querySelector('[data-testid="mcp-export-reveal"]');
    expect(reveal?.querySelector('pre')).toBeNull();
    expect(reveal?.querySelector('[data-testid="mcp-export-desktop-cli"]')?.textContent).toContain(
      'ethos mcp install claude-desktop --personality specialist. The CLI mints its own client key and writes it into the entry.',
    );
  });

  it('renders a denial as a pill carrying the reason code', async () => {
    await mount(view());
    const deny = container.querySelector('[data-pill="deny"]');
    expect(deny?.textContent).toBe('✗invalid_key');
    expect(container.textContent).toContain('unknown');
  });

  it('desktopEntryWithSecret substitutes the placeholder as a JSON string, and leaves a keyless entry alone', () => {
    const entry = view().desktopEntry;
    if (!entry) throw new Error('fixture has an entry');
    const withKey = JSON.parse(desktopEntryWithSecret(entry, 'sk-ethos-"quoted"'));
    expect(withKey.mcpServers['ethos-specialist'].env.ETHOS_MCP_KEY).toBe('sk-ethos-"quoted"');
    const keyless = {
      name: 'ethos-specialist',
      json: '{"mcpServers":{}}',
      secretPlaceholder: null,
    };
    expect(desktopEntryWithSecret(keyless, SECRET)).toBe('{"mcpServers":{}}');
  });
});

/** The `<label>` wrapping a radio/checkbox/segment whose text is `text`. */
function labelled(text: string, scope: ParentNode = container): HTMLInputElement {
  const label = [...scope.querySelectorAll('label')].find((l) =>
    l.textContent?.trim().startsWith(text),
  );
  const input = label?.querySelector('input');
  if (!input) throw new Error(`no input labelled "${text}"`);
  return input;
}

const OFF = (): McpExportViewWire =>
  view({ exported: false, declaration: null, scope: null, desktopEntry: null });

describe('McpExportSection — setting up and editing the export', () => {
  it('Set up export opens the form on the fail-closed defaults', async () => {
    await mount(OFF());
    await click(button('Set up export', container));

    expect(container.textContent).toContain('Export specialist over MCP');
    expect(labelled('None — conversation only').checked).toBe(true);
    expect(
      labelled('None', container.querySelector('[data-field="memory"]') ?? container).checked,
    ).toBe(true);
    expect(labelled('Let each app list and reopen its own conversations').checked).toBe(false);
    expect(labelled('Apps started on this machine, no key').checked).toBe(true);
    expect(button('Turn on export', container).disabled).toBe(false);
    expect(container.textContent).toContain(
      "Saves mcp_export.* in ~/.ethos/personalities/specialist/config.yaml. Takes effect on the app's next call — no restart.",
    );
  });

  it('with export off but a declaration kept, the form starts from that declaration', async () => {
    await mount(
      view({
        exported: false,
        scope: null,
        desktopEntry: null,
        declaration: {
          enabled: false,
          expose_tools: 'all',
          expose_memory: 'scoped',
          auth: 'bearer',
        },
      }),
    );
    await click(button('Set up export', container));
    expect(labelled("All of specialist's tools").checked).toBe(true);
    expect(
      labelled('Read', container.querySelector('[data-field="memory"]') ?? container).checked,
    ).toBe(true);
    expect(labelled('Apps holding a client key').checked).toBe(true);
  });

  it('Selected with no tool ticked disables the submit and says why', async () => {
    await mount(OFF());
    await click(button('Set up export', container));
    await click(labelled('Selected'));

    expect(container.textContent).toContain('0 of 4 selected');
    expect(button('Turn on export', container).disabled).toBe(true);
    expect(container.textContent).toContain(
      'Tick at least one tool, or choose None — conversation only.',
    );

    await click(labelled('read_file'));
    expect(container.textContent).toContain('1 of 4 selected');
    expect(button('Turn on export', container).disabled).toBe(false);
    expect(container.textContent).not.toContain('Tick at least one tool');
  });

  it('the tool grid filters by name', async () => {
    await mount(OFF());
    await click(button('Set up export', container));
    await click(labelled('Selected'));
    const filter = container.querySelector<HTMLInputElement>('input[aria-label="Filter tools"]');
    if (!filter) throw new Error('no filter');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(filter, 'web');
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    const grid = container.querySelector('[data-testid="mcp-export-tool-grid"]');
    expect(grid?.textContent).toContain('web_search');
    expect(grid?.textContent).not.toContain('read_file');
  });

  it('Turn on export sends the whole declaration with enabled: true', async () => {
    updateFn.mockResolvedValue({ personality: {} });
    await mount(OFF());
    await click(button('Set up export', container));
    await click(labelled('Selected'));
    await click(labelled('read_file'));
    await click(labelled('web_search'));
    await click(labelled('Read', container.querySelector('[data-field="memory"]') ?? container));
    await click(labelled('Let each app list and reopen its own conversations'));
    await click(labelled('Apps holding a client key'));

    expect(container.textContent).toContain(
      "An app with a key will see one tool, ask. Its turn can use 2 of specialist's tools, read its memory and list and reopen its own past conversations, and cannot write memory.",
    );

    await click(button('Turn on export', container));

    expect(updateFn).toHaveBeenCalledTimes(1);
    expect(updateFn.mock.calls[0]?.[0]).toEqual({
      id: 'specialist',
      mcp_export: {
        enabled: true,
        expose_tools: ['read_file', 'web_search'],
        expose_memory: 'scoped',
        expose_sessions: true,
        auth: 'bearer',
      },
    });
  });

  it('Edit settings on an exported personality pre-fills from the declaration, including a dropped tool', async () => {
    await mount(view());
    await click(button('Edit settings', container));

    expect(labelled('Selected').checked).toBe(true);
    expect(labelled('read_file').checked).toBe(true);
    expect(labelled('web_search').checked).toBe(true);
    expect(labelled('write_file').checked).toBe(false);
    // Named by the declaration but outside the toolset: still listed, so a save
    // never silently changes what the file says.
    expect(labelled('terminal').checked).toBe(true);
    expect(container.textContent).toContain('3 of 5 selected');
    expect(labelled('Apps holding a client key').checked).toBe(true);
    expect(button('Save changes', container)).toBeTruthy();
    expect(container.querySelector('[data-pill="on"]')).toBeNull();

    await click(button('Cancel', container));
    expect(container.querySelector('[data-pill="on"]')).not.toBeNull();
    expect(updateFn).not.toHaveBeenCalled();
  });

  it('Read and write memory shows the warning', async () => {
    await mount(OFF());
    await click(button('Set up export', container));
    expect(container.textContent).not.toContain('Any app with access can change');
    await click(labelled('Read and write'));
    expect(container.textContent).toContain(
      'Any app with access can change what specialist remembers, and those changes carry into your own chats with it.',
    );
  });

  it('Turn off export asks first, then sends only enabled: false', async () => {
    updateFn.mockResolvedValue({ personality: {} });
    await mount(view());

    await click(button('Turn off export', container));
    expect(updateFn).not.toHaveBeenCalled();
    const popover = document.body.querySelector('.ant-popconfirm');
    expect(popover?.textContent).toContain(
      'Every connected app is refused on its next call. Its client keys are kept, so turning export back on lets them in again. To lock one app out for good, revoke its key instead.',
    );
    await click(button('Keep it on', popover ?? document.body));
    expect(updateFn).not.toHaveBeenCalled();

    await click(button('Turn off export', container));
    const again =
      document.body.querySelector('.ant-popconfirm:not(.ant-popover-hidden)') ?? document.body;
    await click(button('Turn off', again));
    expect(updateFn).toHaveBeenCalledTimes(1);
    expect(updateFn.mock.calls[0]?.[0]).toEqual({
      id: 'specialist',
      mcp_export: { enabled: false },
    });
  });

  it('a failed save keeps the form and the choices, and shows the row with Retry', async () => {
    updateFn.mockRejectedValueOnce(new Error('Could not write config.yaml: permission denied'));
    await mount(OFF());
    await click(button('Set up export', container));
    await click(labelled('Apps holding a client key'));
    await click(button('Turn on export', container));

    const row = container.querySelector('[data-testid="mcp-export-save-row"]');
    expect(row?.textContent).toContain('✗ not saved');
    expect(row?.textContent).toContain('Could not write config.yaml: permission denied');
    expect(container.textContent).toContain('Export specialist over MCP');
    expect(labelled('Apps holding a client key').checked).toBe(true);

    updateFn.mockResolvedValueOnce({ personality: {} });
    await click(button('Retry', container));
    expect(updateFn).toHaveBeenCalledTimes(2);
    expect(updateFn.mock.calls[1]?.[0]).toEqual(updateFn.mock.calls[0]?.[0]);
  });

  it('a successful save invalidates the export, personality and character-sheet queries and shows the saved row', async () => {
    updateFn.mockResolvedValue({ personality: {} });
    const client = await mount(OFF());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await click(button('Set up export', container));
    mcpExportFn.mockResolvedValue(view());
    await click(button('Turn on export', container));

    const keys = invalidate.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(['personalities', 'mcpExport', 'specialist']);
    expect(keys).toContainEqual(['personalities', 'get', 'specialist']);
    expect(keys).toContainEqual(['personalities', 'characterSheet', 'specialist']);

    const row = container.querySelector('[data-testid="mcp-export-save-row"]');
    expect(row?.textContent).toContain('✓ saved');
    expect(row?.textContent).toContain('mcp_export.enabled: true');
    expect(row?.textContent).toContain("applies on each app's next call");
    expect(row?.textContent).toMatch(/\d{2}:\d{2}/);
    expect(container.textContent).not.toContain('Export specialist over MCP');
  });
});

describe('McpExportSection — DESIGN.md conformance', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'McpExportSection.tsx'), 'utf8');

  it('never imports the Card primitive — cards earn existence', () => {
    const antdImport = source.match(/import \{([^}]*)\} from 'antd';/)?.[1] ?? '';
    expect(antdImport.length).toBeGreaterThan(0);
    expect(antdImport).not.toContain('Card');
    expect(source).not.toMatch(/<Card[\s/>]/);
  });

  it('hardcodes no colour: every hue is a token', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/rgba?\(/);
  });

  it('draws no coloured left border', () => {
    expect(source).not.toMatch(/borderLeft|border-left/);
  });
});
