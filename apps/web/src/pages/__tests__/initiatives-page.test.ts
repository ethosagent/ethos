// @vitest-environment jsdom
//
// The Initiatives page and the "exploring now" strip (plan/phases/initiative-engine.md,
// Task 6.4), driven in jsdom with createElement the way `outbox-pane.test.ts` is.
// The root vitest glob only runs `*.test.ts`, so this is not a .tsx test.

import {
  INITIATIVE_FILE_FIELD_KEYS,
  type InitiativeFileWire,
  type InitiativeGetOutputSchema,
} from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

type InitiativeGet = z.infer<typeof InitiativeGetOutputSchema>;

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
vi.mock('react-router-dom', () => ({
  useParams: () => ({ personalityId: 'cmo' }),
  useNavigate: () => navigateFn,
}));

const listFn = vi.fn();
const getFn = vi.fn();
const activityFn = vi.fn();
const exploringNowFn = vi.fn();
const decideFn = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    initiatives: {
      list: (...args: unknown[]) => listFn(...args),
      get: (...args: unknown[]) => getFn(...args),
      activity: (...args: unknown[]) => activityFn(...args),
      exploringNow: (...args: unknown[]) => exploringNowFn(...args),
      decide: (...args: unknown[]) => decideFn(...args),
    },
  },
}));

const { Initiatives } = await import('../Initiatives');
const { ExploringNowStrip } = await import('../../components/initiatives/ExploringNowStrip');

function summary(id: string, origin: 'human' | 'agent', state: string, title: string) {
  return {
    id,
    personalityId: 'cmo',
    origin,
    state,
    title,
    version: 1,
    spendTodayUsd: 0.25,
    openExplorations: 1,
  };
}

const SUMMARIES = [
  summary('INI-1', 'human', 'active', 'Competitor pricing'),
  summary('INI-2', 'agent', 'self_started', 'Docs gaps'),
  summary('INI-3', 'human', 'paused', 'Launch checklist'),
];

function file(over: Partial<InitiativeFileWire> = {}): InitiativeFileWire {
  return {
    id: 'INI-2',
    version: 3,
    origin: 'agent',
    created_in: 'session-42',
    state: 'self_started',
    title: 'Docs gaps',
    outcome: 'Find what the docs never explain',
    sources: ['sessions', { repo: 'ethos' }],
    exclude: ['~/private'],
    guidance: [{ text: 'Check the calendar' }, { text: 'Read the competitor blog' }],
    autonomy: { mode: 'free_under', ask_above_usd: 1 },
    budget: { usd_per_day: 2, usd_per_exploration: 0.5, max_open_explorations: 2 },
    timeline: {
      explore_windows: ['09:00', '14:00'],
      window_minutes: 20,
      default_days: 14,
      review_on: '2026-12-10',
      ends_on: '2026-12-24',
    },
    delivery: { owner_channel: 'slack:C1', digest_time: '08:00' },
    parent_id: 'INI-1',
    notes: ['Started because three sessions asked about this'],
    ...over,
  };
}

function detail(over: Partial<InitiativeGet> = {}): InitiativeGet {
  return {
    personalityId: 'cmo',
    initiative: file(),
    guidance: [
      { text: 'Check the calendar', status: 'unreachable', mapsTo: [] },
      { text: 'Read the competitor blog', status: 'mapped', mapsTo: ['web_search'] },
    ],
    yaml: 'id: INI-2\nversion: 3\n',
    versions: [
      { version: 3, savedAt: '2026-12-01T10:00:00Z' },
      { version: 2, savedAt: '2026-11-28T10:00:00Z' },
    ],
    explorations: [
      {
        id: 'EXP-1',
        question: 'Which pages are thin?',
        state: 'briefed',
        budgetUsd: 0.5,
        spentUsd: 0.31,
        deadline: '2026-12-05',
        briefMd: 'Found three thin pages.',
        recommendedOption: 'B',
      },
      {
        id: 'EXP-2',
        question: 'Who else covers this?',
        state: 'proposed',
        budgetUsd: 0.5,
        spentUsd: 0,
        deadline: '2026-12-06',
      },
    ],
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(node: ReturnType<typeof createElement>): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, node));
  });
  await flush();
}

function q<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector);
}

function ids(): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-initiative-id]')].map(
    (el) => el.dataset.initiativeId ?? '',
  );
}

async function click(selector: string): Promise<void> {
  const el = q<HTMLElement>(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

async function openAgentInitiative(): Promise<void> {
  await mount(createElement(Initiatives, null));
  await click('[data-initiative-id="INI-2"]');
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  listFn.mockResolvedValue({ items: SUMMARIES });
  getFn.mockResolvedValue(detail());
  activityFn.mockResolvedValue({ windows: [] });
  exploringNowFn.mockResolvedValue({ current: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('Initiatives page', () => {
  it('origin filter', async () => {
    await mount(createElement(Initiatives, null));
    expect(listFn).toHaveBeenCalledWith({ personalityId: 'cmo' });
    expect(ids()).toEqual(['INI-1', 'INI-2', 'INI-3']);

    await click('[data-filter="human"]');
    expect(ids()).toEqual(['INI-1', 'INI-3']);

    await click('[data-filter="agent"]');
    expect(ids()).toEqual(['INI-2']);
    // The agent-started badge is its own token, not the human one.
    expect(q('[data-initiative-id="INI-2"] [data-origin-badge="agent"]')).not.toBeNull();

    await click('[data-filter="paused"]');
    expect(ids()).toEqual(['INI-3']);

    await click('[data-filter="all"]');
    expect(ids()).toEqual(['INI-1', 'INI-2', 'INI-3']);
  });

  it('every initiative file key is a labeled row', async () => {
    await openAgentInitiative();
    expect(getFn).toHaveBeenCalledWith({ id: 'INI-2' });
    expect(INITIATIVE_FILE_FIELD_KEYS).toHaveLength(24);
    for (const key of INITIATIVE_FILE_FIELD_KEYS) {
      const row = q(`[data-initiative-key="${key}"]`);
      expect(row, `row for ${key}`).not.toBeNull();
      const label = row?.querySelector('[data-row-label]')?.textContent ?? '';
      expect(label.length, `label for ${key}`).toBeGreaterThan(0);
      expect(label).not.toBe(key);
    }
  });

  it('parent_id and notes appear only for agent origin', async () => {
    getFn.mockResolvedValue(
      detail({
        initiative: file({
          origin: 'human',
          parent_id: undefined,
          notes: undefined,
          state: 'active',
        }),
      }),
    );
    await openAgentInitiative();
    expect(q('[data-initiative-key="origin"]')).not.toBeNull();
    expect(q('[data-initiative-key="parent_id"]')).toBeNull();
    expect(q('[data-initiative-key="notes"]')).toBeNull();
  });

  it('unreachable guidance is labelled', async () => {
    await openAgentInitiative();
    const unreachable = q('[data-guidance-status="unreachable"]');
    expect(unreachable?.textContent).toContain('Check the calendar');
    expect(unreachable?.textContent?.toLowerCase()).toContain('unreachable');
    const mapped = q('[data-guidance-status="mapped"]');
    expect(mapped?.textContent).toContain('web_search');
  });

  it('Show file is read-only', async () => {
    await openAgentInitiative();
    await click('[data-testid="initiative-show-file"]');
    const panel = q('[data-testid="initiative-file"]');
    expect(panel).not.toBeNull();
    expect(q('[data-testid="initiative-yaml"]')?.textContent).toBe('id: INI-2\nversion: 3\n');
    expect(panel?.querySelectorAll('[data-version]')).toHaveLength(2);
    // No edit surface anywhere on the page: edits happen by telling the agent.
    expect(container.querySelectorAll('textarea, input, [contenteditable="true"]')).toHaveLength(0);
    expect(container.textContent).toContain('tell the agent');
  });

  it('lists every window with when, tools, reads, findings and cost', async () => {
    activityFn.mockResolvedValue({
      windows: [
        {
          id: 'W-1',
          explorationId: 'EXP-1',
          kind: 'window',
          started: '2026-12-01T09:00:00Z',
          ended: '2026-12-01T09:20:00Z',
          tools: ['web_search', 'read_file'],
          reads: ['https://example.com/docs'],
          findings: 3,
          costUsd: 0.12,
          endReason: 'done',
        },
      ],
    });
    await openAgentInitiative();
    expect(activityFn).toHaveBeenCalledWith({ initiativeId: 'INI-2' });
    const row = q('[data-window-id="W-1"]');
    expect(row?.textContent).toContain('web_search');
    expect(row?.textContent).toContain('https://example.com/docs');
    expect(row?.textContent).toContain('3 findings');
    expect(row?.textContent).toContain('$0.12');
  });

  it('sends the brief, proposal and self-start decisions to initiatives.decide', async () => {
    decideFn.mockResolvedValue({ ok: true, chatLink: '/p/cmo/chat?setup=INI-2' });
    await openAgentInitiative();

    await click('[data-testid="decide-adopt"]');
    expect(decideFn).toHaveBeenLastCalledWith({
      gate: 'gate2_adopt',
      verdict: 'adopt',
      target: 'EXP-1',
      option: 'B',
    });
    await click('[data-testid="decide-dig_deeper"]');
    expect(decideFn).toHaveBeenLastCalledWith({
      gate: 'gate2_adopt',
      verdict: 'dig_deeper',
      target: 'EXP-1',
    });
    await click('[data-testid="decide-park"]');
    expect(decideFn).toHaveBeenLastCalledWith({
      gate: 'gate2_adopt',
      verdict: 'park',
      target: 'EXP-1',
    });
    await click('[data-testid="decide-approve"]');
    expect(decideFn).toHaveBeenLastCalledWith({
      gate: 'gate1_explore',
      verdict: 'approve',
      target: 'EXP-2',
    });
    await click('[data-testid="decide-reject"]');
    expect(decideFn).toHaveBeenLastCalledWith({
      gate: 'gate1_explore',
      verdict: 'reject',
      target: 'EXP-2',
    });
    await click('[data-testid="decide-keep"]');
    expect(decideFn).toHaveBeenLastCalledWith({
      gate: 'self_start',
      verdict: 'keep',
      target: 'INI-2',
    });
    await click('[data-testid="decide-stop"]');
    expect(decideFn).toHaveBeenLastCalledWith({
      gate: 'self_start',
      verdict: 'stop',
      target: 'INI-2',
    });
    await click('[data-testid="decide-make_mine"]');
    expect(decideFn).toHaveBeenLastCalledWith({
      gate: 'self_start',
      verdict: 'make_mine',
      target: 'INI-2',
    });
    expect(navigateFn).toHaveBeenCalledWith('/p/cmo/chat?setup=INI-2');
  });
});

describe('exploring-now strip', () => {
  it('strip shows the current window, cost so far and read-only', async () => {
    exploringNowFn.mockResolvedValue({
      current: {
        windowId: 'W-7',
        initiativeId: 'INI-2',
        initiativeTitle: 'Docs gaps',
        explorationId: 'EXP-1',
        question: 'Which pages are thin?',
        started: '2026-12-01T09:00:00Z',
        costSoFarUsd: 0.12,
        readOnly: true,
      },
    });
    await mount(createElement(ExploringNowStrip, { personalityId: 'cmo' }));
    expect(exploringNowFn).toHaveBeenCalledWith({ personalityId: 'cmo' });
    const strip = q('[data-testid="exploring-now"]');
    expect(strip?.textContent).toContain('Docs gaps');
    expect(strip?.textContent).toContain('W-7');
    expect(strip?.textContent).toContain('$0.12 so far');
    expect(strip?.textContent?.toLowerCase()).toContain('read-only');
  });

  it('renders nothing when no window is running', async () => {
    await mount(createElement(ExploringNowStrip, { personalityId: 'cmo' }));
    expect(q('[data-testid="exploring-now"]')).toBeNull();
  });
});
