// @vitest-environment jsdom
//
// The Skills page carries the lock toggle, the Locked chip and the History
// button on both altitudes (plan skill-history-and-lock, D2): the library card
// and the personality workspace card. The controls themselves are pinned by
// `components/skills/__tests__/skill-history.test.ts`; this pins that the page
// renders them from the `locked` / `versionCount` the RPC returns.

import type { PersonalitySkill, Skill } from '@ethosagent/web-contracts';
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

const listFn = vi.fn();
const setLockFn = vi.fn();
const historyFn = vi.fn();
const personalitiesListFn = vi.fn();
const personalitySkillsListFn = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    skills: {
      list: (...args: unknown[]) => listFn(...args),
      setLock: (...args: unknown[]) => setLockFn(...args),
      history: (...args: unknown[]) => historyFn(...args),
      version: () => Promise.resolve({ versionId: 'v', content: '' }),
    },
    personalities: {
      list: (...args: unknown[]) => personalitiesListFn(...args),
      skillsList: (...args: unknown[]) => personalitySkillsListFn(...args),
    },
    evolver: {},
    catalog: {},
  },
}));

const { Skills } = await import('../Skills');

function skill(over: Partial<Skill> = {}): Skill {
  return {
    id: 'tidy',
    name: 'Tidy',
    description: 'Keep it short',
    frontmatter: {},
    body: 'body',
    modifiedAt: new Date().toISOString(),
    source: 'user',
    readonly: false,
    unavailableReason: null,
    locked: false,
    versionCount: 3,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(path: string): Promise<void> {
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
          createElement(
            MemoryRouter,
            { initialEntries: [path] },
            createElement(
              Routes,
              null,
              createElement(Route, { path: '/skills', element: createElement(Skills) }),
              createElement(Route, {
                path: '/p/:personalityId/skills',
                element: createElement(Skills),
              }),
            ),
          ),
        ),
      ),
    );
  });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  listFn.mockResolvedValue({
    skills: [skill(), skill({ id: 'plain', name: 'Plain', locked: true, versionCount: 1 })],
    pendingCount: 0,
  });
  personalitiesListFn.mockResolvedValue({ items: [] });
  personalitySkillsListFn.mockResolvedValue({ skills: [] });
  setLockFn.mockImplementation(async (input: { locked: boolean }) => ({ locked: input.locked }));
  historyFn.mockResolvedValue({ versions: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('Skills page — library', () => {
  it('shows a Locked chip only on a locked skill, and a History button with the version count', async () => {
    await mount('/skills');
    const cards = [...container.querySelectorAll('.skill-card')];
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector('[data-testid="skill-locked-chip"]')).toBeNull();
    expect(cards[1]?.querySelector('[data-testid="skill-locked-chip"]')).not.toBeNull();
    expect(cards[0]?.querySelector('[data-testid="skill-history-open"]')?.textContent).toBe(
      'History (3)',
    );
  });

  it('the lock switch on a card calls skills.setLock', async () => {
    await mount('/skills');
    const sw = container.querySelector('.skill-card button[role="switch"]');
    await act(async () => {
      sw?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(setLockFn).toHaveBeenCalledWith({ id: 'tidy', locked: true });
  });

  it('opening History asks for that skill’s versions', async () => {
    await mount('/skills');
    const btn = container.querySelector('[data-testid="skill-history-open"]');
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(historyFn).toHaveBeenCalledWith({ id: 'tidy' });
  });
});

describe('Skills page — a personality workspace', () => {
  it('lock and history there are scoped to the personality', async () => {
    const own: PersonalitySkill = {
      id: 'tidy',
      name: 'Tidy',
      description: null,
      body: 'b',
      modifiedAt: new Date().toISOString(),
      locked: true,
      versionCount: 2,
    };
    personalitySkillsListFn.mockResolvedValue({ skills: [own] });
    await mount('/p/coach/skills');
    expect(container.querySelector('[data-testid="skill-locked-chip"]')).not.toBeNull();
    const sw = [...container.querySelectorAll('button[role="switch"]')].find(
      (el) => el.getAttribute('aria-label') === 'Unlock skill',
    );
    await act(async () => {
      sw?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(setLockFn).toHaveBeenCalledWith({ id: 'tidy', locked: false, personalityId: 'coach' });
    const btn = container.querySelector('[data-testid="skill-history-open"]');
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(historyFn).toHaveBeenCalledWith({ id: 'tidy', personalityId: 'coach' });
  });
});
