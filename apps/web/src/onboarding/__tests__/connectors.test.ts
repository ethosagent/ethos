// @vitest-environment jsdom
//
// Connectors step (plan keyless-first-run §5.3). Four things are pinned:
//   1. `groupByAuth` splits a catalog by authType.
//   2. The real preset slate lands five in "works now" and six in "sign in".
//      apps/web must not import @ethosagent/tools-mcp (Node-only; pinned by
//      extensions/tools-mcp/src/__tests__/browser-boundary.test.ts), so the
//      slate is parsed out of remote-presets.ts as text. A preset that changes
//      authType changes the parsed rows and fails this test.
//   3. D20: for OAuth the attach runs only after the sign-in connected.
//   4. The step renders both groups and names the agent on the buttons.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpCatalogOutput, McpRemotePresetInfo } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupByAuth } from '../../features/mcp/catalog';
import type { UseMcpOAuthPopupOptions } from '../../features/mcp/useMcpOAuthPopup';
import { attachAfterConnect } from '../connectors';

const PRESETS_SOURCE = readFileSync(
  join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'extensions/tools-mcp/src/remote-presets.ts',
  ),
  'utf8',
);

/** One row per `name: '…'` … `authType: '…'` pair in the preset table. */
function presetRowsFromSource(): McpRemotePresetInfo[] {
  const rows: McpRemotePresetInfo[] = [];
  const re = /^ {4}name: '([a-z0-9-]+)',[\s\S]*?^ {4}authType: '(none|oauth|bearer)',/gm;
  for (const m of PRESETS_SOURCE.matchAll(re)) {
    const name = m[1];
    const authType = m[2];
    if (!name || (authType !== 'none' && authType !== 'oauth' && authType !== 'bearer')) continue;
    rows.push({
      name,
      label: name,
      url: `https://example.com/${name}`,
      transport: 'streamable-http',
      authType,
      description: name,
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
    const g = groupByAuth(presetRowsFromSource());
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

const catalogFn = vi.fn();
const connectPresetFn = vi.fn();
const attachFn = vi.fn();
let oauthOptions: UseMcpOAuthPopupOptions | null = null;
const oauthStart = vi.fn().mockResolvedValue(undefined);

vi.mock('../../rpc', () => ({
  rpc: {
    mcp: {
      catalog: (...a: unknown[]) => catalogFn(...a),
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

const CATALOG: McpCatalogOutput = { remote: presetRowsFromSource(), local: [] };

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
  catalogFn.mockResolvedValue(CATALOG);
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
    button('Sign in to linear');
    expect(button('Skip')).toBeTruthy();
  });

  it('no-auth rows call connectPreset with the agent id', async () => {
    connectPresetFn.mockResolvedValue({ ok: true, serverName: 'deepwiki', toolCount: 3 });
    await act(async () => {
      button('Add to Sage').click();
    });
    await flush();
    expect(connectPresetFn).toHaveBeenCalledWith({ presetName: 'deepwiki', personalityId: 'sage' });
    expect(container.textContent).toContain('✓ Added');
    expect(button('Continue')).toBeTruthy();
    await act(async () => {
      button('Continue').click();
    });
    expect(onNext).toHaveBeenCalledWith({ connectedPresets: ['deepwiki'] });
  });

  it('oauth attach is called only after connected', async () => {
    attachFn.mockResolvedValue({ updated: ['sage'], failed: [] });
    await act(async () => {
      button('Sign in to linear').click();
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
      button('Sign in to linear').click();
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
