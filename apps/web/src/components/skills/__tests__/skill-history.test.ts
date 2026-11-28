// @vitest-environment jsdom
//
// The Skills page's history and lock controls (plan skill-history-and-lock, D2),
// driven in jsdom the way `learning-inbox.test.ts` drives the Learning page.
// What is pinned: the lock toggle calls `skills.setLock` (shared and
// personality-scoped); the History drawer lists every version with a source chip;
// picking two versions renders their `unifiedDiff`; Restore asks first, then
// restores and refreshes the list.

import type { SkillVersion } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
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

const historyFn = vi.fn();
const versionFn = vi.fn();
const restoreFn = vi.fn();
const setLockFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    skills: {
      history: (...args: unknown[]) => historyFn(...args),
      version: (...args: unknown[]) => versionFn(...args),
      restore: (...args: unknown[]) => restoreFn(...args),
      setLock: (...args: unknown[]) => setLockFn(...args),
    },
  },
}));

const { SkillHistoryDrawer, SkillLockSwitch, SOURCE_LABELS } = await import('../SkillHistory');

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const VERSIONS: SkillVersion[] = [
  { versionId: 'v1', at: iso(300_000), source: 'external', actor: 'external', hash: 'h1' },
  {
    versionId: 'v2',
    at: iso(200_000),
    source: 'learning',
    actor: 'nightly',
    hash: 'h2',
    candidateId: 'cand-9',
  },
  { versionId: 'v3', at: iso(100_000), source: 'web-edit', actor: 'web', hash: 'h3' },
];
const BYTES: Record<string, string> = {
  v1: 'Quote the source.\n',
  v2: 'Quote the source.\nName the file and line.\n',
  v3: 'Name the file and line.\n',
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(node: ReturnType<typeof createElement>): Promise<void> {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(AntApp, null, node)));
  });
  await flush();
}

/** antd portals the drawer and popconfirm to `document.body`. */
function q<T extends Element>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}
function all(selector: string): Element[] {
  return [...document.body.querySelectorAll(selector)];
}
async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error(`nothing to click. Saw: ${document.body.textContent}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  historyFn.mockResolvedValue({ versions: VERSIONS });
  versionFn.mockImplementation(async (input: { versionId: string }) => ({
    versionId: input.versionId,
    content: BYTES[input.versionId] ?? null,
  }));
  restoreFn.mockResolvedValue({ versionId: 'v4' });
  setLockFn.mockImplementation(async (input: { locked: boolean }) => ({ locked: input.locked }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('SkillLockSwitch', () => {
  it('turning it on calls skills.setLock for the shared skill and refreshes the list', async () => {
    await mount(createElement(SkillLockSwitch, { skillId: 'tidy', locked: false }));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await click(q('button[role="switch"]'));
    expect(setLockFn).toHaveBeenCalledWith({ id: 'tidy', locked: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['skills', 'list'] });
  });

  it('turning it off for a personality skill sends its personalityId', async () => {
    await mount(
      createElement(SkillLockSwitch, { skillId: 'tidy', locked: true, personalityId: 'coach' }),
    );
    expect(q('button[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    await click(q('button[role="switch"]'));
    expect(setLockFn).toHaveBeenCalledWith({ id: 'tidy', locked: false, personalityId: 'coach' });
  });
});

describe('SkillHistoryDrawer', () => {
  const open = () =>
    mount(
      createElement(SkillHistoryDrawer, {
        skillId: 'tidy',
        skillName: 'Tidy',
        open: true,
        onClose: () => {},
      }),
    );

  it('lists every version, newest first, with a source chip and the actor', async () => {
    await open();
    expect(historyFn).toHaveBeenCalledWith({ id: 'tidy' });
    const rows = all('[data-testid="skill-version-row"]');
    expect(rows.map((r) => r.getAttribute('data-version-id'))).toEqual(['v3', 'v2', 'v1']);
    expect(rows[0]?.textContent).toContain(SOURCE_LABELS['web-edit']);
    expect(rows[1]?.textContent).toContain(SOURCE_LABELS.learning);
    expect(rows[1]?.textContent).toContain('nightly');
    expect(rows[2]?.textContent).toContain(SOURCE_LABELS.external);
  });

  it('sends personalityId for a personality skill', async () => {
    await mount(
      createElement(SkillHistoryDrawer, {
        skillId: 'tidy',
        skillName: 'Tidy',
        personalityId: 'coach',
        open: true,
        onClose: () => {},
      }),
    );
    expect(historyFn).toHaveBeenCalledWith({ id: 'tidy', personalityId: 'coach' });
  });

  it('diffs the two newest versions by default and re-diffs when a different base is picked', async () => {
    await open();
    expect(versionFn).toHaveBeenCalledWith({ id: 'tidy', versionId: 'v2' });
    expect(versionFn).toHaveBeenCalledWith({ id: 'tidy', versionId: 'v3' });
    const kinds = () => all('.learning-diff-line').map((l) => l.getAttribute('data-kind'));
    // v2 -> v3 : the first line is removed, the second kept.
    expect(kinds()).toEqual(['del', 'same']);
    expect(all('.learning-diff-line')[0]?.textContent).toBe('- Quote the source.');

    await click(q('[data-testid="skill-diff-base-v1"]'));
    // v1 -> v3 : the whole line is replaced.
    expect(kinds()).toEqual(['del', 'add']);
  });

  it('Restore asks first, then restores that version and refreshes the lists', async () => {
    await open();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await click(q('[data-testid="skill-restore-v1"]'));
    expect(restoreFn).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Restore this version?');

    await click(all('.ant-popover button.ant-btn-primary')[0] ?? null);
    expect(restoreFn).toHaveBeenCalledWith({ id: 'tidy', versionId: 'v1' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['skills', 'list'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['skills', 'history'] });
  });

  it('the newest version has no Restore: it is already live', async () => {
    await open();
    expect(q('[data-testid="skill-restore-v3"]')).toBeNull();
    expect(q('[data-testid="skill-restore-v2"]')).not.toBeNull();
  });

  it('says so when there is no history yet', async () => {
    historyFn.mockResolvedValue({ versions: [] });
    await open();
    expect(document.body.textContent).toContain('No versions yet');
  });
});
