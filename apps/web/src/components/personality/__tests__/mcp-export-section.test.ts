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
const createFn = vi.fn();
const revokeFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    personalities: { mcpExport: (...args: unknown[]) => mcpExportFn(...args) },
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

async function mount(data: McpExportViewWire): Promise<void> {
  mcpExportFn.mockResolvedValue(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(McpExportSection, { personalityId: 'specialist' }),
      ),
    );
  });
  await flush();
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

  it('shows the "Not exported" pill and how to export, with no client controls', async () => {
    await mount(view({ exported: false, scope: null, desktopEntry: null }));
    expect(container.querySelector('[data-pill="off"]')?.textContent).toBe('✗Not exported');
    expect(container.textContent).toContain('mcp_export.enabled: true');
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
