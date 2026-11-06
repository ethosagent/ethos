// @vitest-environment jsdom
//
// Connectors step (plan keyless-first-run §5.3). Four things are pinned:
//   1. `groupByAuth` splits a catalog by authType.
//   2. The real preset slate lands five in "works now" and six in "sign in".
//      apps/web must not import @ethosagent/tools-mcp (Node-only; pinned by
//      extensions/tools-mcp/src/__tests__/browser-boundary.test.ts), so the
//      slate is read from the catalog index (@ethosagent/catalog, pure data,
//      browser-safe), which is what MCP_REMOTE_PRESETS is derived from. A
//      remote entry that changes auth changes the rows and fails this test.
//   3. D20: for OAuth the attach runs only after the sign-in connected.
//   4. The step renders both groups and names the agent on the buttons.

import { CATALOG_ENTRIES } from '@ethosagent/catalog';
import type { McpRemotePresetInfo } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupByAuth } from '../../features/mcp/catalog';
import type { UseMcpOAuthPopupOptions } from '../../features/mcp/useMcpOAuthPopup';
import { attachAfterConnect } from '../connectors';

/** One row per remote catalog entry, in catalog order. */
function presetRowsFromCatalog(): McpRemotePresetInfo[] {
  const rows: McpRemotePresetInfo[] = [];
  for (const e of CATALOG_ENTRIES) {
    const auth = e.capabilities.auth;
    if (e.pin.type !== 'remote' || (auth !== 'none' && auth !== 'oauth' && auth !== 'bearer')) {
      continue;
    }
    rows.push({
      name: e.id,
      label: e.id,
      url: `https://example.com/${e.id}`,
      transport: 'streamable-http',
      authType: auth,
      description: e.id,
      category: 'x',
    });
  }
  return rows;
}

describe('groupByAuth', () => {
  it('groups by authType, preserves order and leaves bearer rows out', () => {
    const rows = [
      { name: 'a', authType: 'oauth' as const },
      { name: 'b', authType: 'none' as const },
      { name: 'c', authType: 'bearer' as const },
      { name: 'd', authType: 'none' as const },
    ];
    const g = groupByAuth(rows);
    expect(g.none.map((r) => r.name)).toEqual(['b', 'd']);
    expect(g.oauth.map((r) => r.name)).toEqual(['a']);
  });

  it('the five none presets land in works-now and the six oauth presets in sign-in', () => {
    const g = groupByAuth(presetRowsFromCatalog());
    expect(g.none.map((r) => r.name)).toEqual([
      'deepwiki',
      'context7',
      'aws-knowledge',
      'microsoft-learn',
      'wolfram',
    ]);
    expect(g.oauth.map((r) => r.name)).toEqual([
      'sentry',
      'vercel',
      'linear',
      'notion',
      'granola',
      'asana',
    ]);
  });
});

describe('attachAfterConnect', () => {
  it('attaches the agent only, and reports ok when the server updated it', async () => {
    const attach = vi.fn().mockResolvedValue({ updated: ['sage'], failed: [] });
    const r = await attachAfterConnect({ serverName: 'linear', personalityId: 'sage', attach });
    expect(attach).toHaveBeenCalledWith({ serverName: 'linear', personalityIds: ['sage'] });
    expect(r).toEqual({ ok: true });
  });

  it('surfaces the server reason when the attach failed', async () => {
    const attach = vi
      .fn()
      .mockResolvedValue({ updated: [], failed: [{ id: 'sage', error: 'PERSONALITY_READ_ONLY' }] });
    const r = await attachAfterConnect({ serverName: 'linear', personalityId: 'sage', attach });
    expect(r).toEqual({ ok: false, detail: 'PERSONALITY_READ_ONLY' });
  });
});

// --- the step -------------------------------------------------------------

const listFn = vi.fn();
const connectPresetFn = vi.fn();
const attachFn = vi.fn();
let oauthOptions: UseMcpOAuthPopupOptions | null = null;
const oauthStart = vi.fn().mockResolvedValue(undefined);

vi.mock('../../rpc', () => ({
  rpc: {
    catalog: { list: (...a: unknown[]) => listFn(...a) },
    mcp: {
      connectPreset: (...a: unknown[]) => connectPresetFn(...a),
      attachPersonalities: (...a: unknown[]) => attachFn(...a),
    },
  },
}));
vi.mock('../../features/mcp/useMcpOAuthPopup', () => ({
  useMcpOAuthPopup: (opts: UseMcpOAuthPopupOptions) => {
    oauthOptions = opts;
    return { start: oauthStart, phase: 'idle', cancel: vi.fn() };
  },
}));

const { ConnectorsStep } = await import('../steps/ConnectorsStep');

// The real index, decorated with the action shapes `actionFor` serves
// (apps/web-api/src/services/catalog.service.ts).
const CATALOG = {
  version: 1 as const,
  entries: CATALOG_ENTRIES.filter((e) => e.kind === 'mcp').map((e) => {
    const url = e.pin.type === 'remote' ? e.pin.url : '';
    const action =
      e.pin.type !== 'remote'
        ? { type: 'cli' as const, command: `ethos catalog install ${e.id}` }
        : e.capabilities.auth === 'oauth'
          ? { type: 'oauth' as const, url, name: e.id }
          : e.capabilities.auth === 'none'
            ? { type: 'add' as const, name: e.id, url }
            : { type: 'cli' as const, command: `ethos mcp add ${e.id} --url ${url}` };
    return { ...e, installed: false, action };
  }),
};

let container: HTMLDivElement;
let root: Root;
const onNext = vi.fn();

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function button(label: string): HTMLButtonElement {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
  if (!el) throw new Error(`no button "${label}"`);
  return el;
}

beforeEach(async () => {
  vi.clearAllMocks();
  oauthOptions = null;
  listFn.mockResolvedValue(CATALOG);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ConnectorsStep, {
          answers: { mode: 'quick', personalityId: 'sage', agentName: 'Sage' },
          onNext,
        }),
      ),
    );
  });
  await flush();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ConnectorsStep', () => {
  it('renders both groups and names the agent on the buttons', () => {
    const text = container.textContent ?? '';
    expect(text).toContain('WORKS NOW, NO SIGN-IN');
    expect(text).toContain('SIGN IN ONCE');
    expect(text.indexOf('WORKS NOW')).toBeLessThan(text.indexOf('SIGN IN ONCE'));
    expect(container.querySelectorAll('button').length).toBeGreaterThan(11);
    button('Add to Sage');
    button('Sign in to Linear');
    expect(button('Skip')).toBeTruthy();
  });

  it('no-auth rows call connectPreset with the agent id', async () => {
    connectPresetFn.mockResolvedValue({ ok: true, serverName: 'aws-knowledge', toolCount: 3 });
    await act(async () => {
      button('Add to Sage').click();
    });
    await flush();
    expect(connectPresetFn).toHaveBeenCalledWith({
      presetName: 'aws-knowledge',
      personalityId: 'sage',
    });
    expect(container.textContent).toContain('✓ Added');
    expect(button('Continue')).toBeTruthy();
    await act(async () => {
      button('Continue').click();
    });
    expect(onNext).toHaveBeenCalledWith({ connectedPresets: ['aws-knowledge'] });
  });

  it('oauth attach is called only after connected', async () => {
    attachFn.mockResolvedValue({ updated: ['sage'], failed: [] });
    await act(async () => {
      button('Sign in to Linear').click();
    });
    await flush();
    // Sign-in started with the agent's id threaded to the hook; nothing attached yet.
    expect(oauthStart).toHaveBeenCalledWith(expect.objectContaining({ name: 'linear' }));
    expect(oauthOptions).not.toBeNull();
    expect(attachFn).not.toHaveBeenCalled();

    // A failed sign-in leaves no grant behind.
    await act(async () => {
      oauthOptions?.onError('denied');
    });
    await flush();
    expect(attachFn).not.toHaveBeenCalled();
    expect(container.textContent).toContain('denied');

    // Retry, then connect: only now is the agent attached.
    await act(async () => {
      button('Sign in to Linear').click();
    });
    await act(async () => {
      oauthOptions?.onSuccess('linear');
    });
    await flush();
    expect(attachFn).toHaveBeenCalledTimes(1);
    expect(attachFn).toHaveBeenCalledWith({ serverName: 'linear', personalityIds: ['sage'] });
    expect(container.textContent).toContain('✓ Added');
  });
});
