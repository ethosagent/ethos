// @vitest-environment jsdom
//
// The Personalities tab's Prompt size section: the static prompt prefix and
// the project-context term from the `personalities.characterSheet` RPC's
// `promptSize` (the same numbers the Markdown sheet's `## Prompt size`
// prints). No numbers → no section.

import type { Personality } from '@ethosagent/web-contracts';
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

const characterSheetFn = vi.fn();
vi.mock('../../../rpc', () => ({
  rpc: { personalities: { characterSheet: (...args: unknown[]) => characterSheetFn(...args) } },
}));
vi.mock('../../../features/settings/api/queries', () => ({
  useToolCatalog: () => ({ data: { groups: [] } }),
}));

const { CharacterSheetView } = await import('../CharacterSheetView');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  characterSheetFn.mockReset();
});

const personality = { id: 'researcher', name: 'Researcher' } as Personality;

async function render(promptSize: unknown): Promise<string> {
  characterSheetFn.mockResolvedValue({ markdown: '', posture: null, promptSize });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CharacterSheetView, { personality }),
      ),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return container.textContent ?? '';
}

describe('CharacterSheetView — Prompt size', () => {
  it('shows the static prefix and the declared workdir’s project context', async () => {
    const text = await render({
      staticPrefixTokens: 12_345,
      projectContext: { workdir: '/srv/repo', tokens: 3_000 },
    });
    expect(text).toContain('Prompt size');
    expect(text).toContain('~12,345 tokens');
    expect(text).toContain('~3,000 tokens · /srv/repo');
  });

  it('says the project context depends on the working directory when none is declared', async () => {
    const text = await render({
      staticPrefixTokens: 9_000,
      projectContext: { workdir: null, tokens: 0 },
    });
    expect(text).toContain('Depends on the working directory — no workdir declared');
  });

  it('renders no section when the server could not measure', async () => {
    const text = await render(null);
    expect(text).not.toContain('Prompt size');
  });
});
