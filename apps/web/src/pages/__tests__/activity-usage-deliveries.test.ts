// @vitest-environment jsdom
//
// Plan openclaw-2026.9.6-gaps U3 + U5 — the Activity page's Usage and
// Deliveries tabs, and the chat header's session cost. Driven in jsdom against
// a mocked RPC client, the same seam `activity-page.test.ts` uses.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deliveriesSummary = vi.fn();
const listDeadInbound = vi.fn();
const usageSummary = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    deliveries: {
      summary: (...args: unknown[]) => deliveriesSummary(...args),
      listDeadInbound: (...args: unknown[]) => listDeadInbound(...args),
      requeueInbound: vi.fn(),
      discardInbound: vi.fn(),
    },
    usage: { summary: (...args: unknown[]) => usageSummary(...args) },
  },
}));

const { DeliveriesPanel } = await import('../../features/deliveries/DeliveriesPanel');
const { UsagePanel } = await import('../../features/usage/UsagePanel');
const { PersonalityBar } = await import('../../components/chat/PersonalityBar');

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(element: ReactElement): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Number.POSITIVE_INFINITY } },
  });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  await flush();
}

const zeroStats = { pending: 0, redelivering: 0, delivered: 0, abandoned: 0 };

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  deliveriesSummary.mockReset();
  listDeadInbound.mockReset().mockResolvedValue({ rows: [] });
  usageSummary.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Activity → Deliveries (U5)', () => {
  it('renders the ledger summary and its rows', async () => {
    deliveriesSummary.mockResolvedValue({
      stats: { ...zeroStats, pending: 2, delivered: 7, voice: { ...zeroStats, pending: 1 } },
      recent: [
        {
          id: 'o1',
          platform: 'telegram',
          chatId: 'c1',
          threadId: null,
          status: 'pending',
          kind: 'text',
          content: 'the reply still owed',
          mediaFormat: null,
          createdAt: Date.now() - 5_000,
        },
      ],
    });
    await mount(createElement(DeliveriesPanel));
    const text = container.textContent ?? '';
    expect(text).toContain('outbound');
    expect(text).toContain('the reply still owed');
    expect(text).toContain('voice 1');
    expect(text).toContain('inbound — dead');
    expect(text).toContain('No dead inbound messages');
  });

  it('the voice pane no longer carries the ledger or the dead-inbound table', async () => {
    const src = await readFile(
      join(import.meta.dirname, '..', 'settings', 'panes', 'voice.tsx'),
      'utf8',
    );
    expect(src).not.toContain('rpc.deliveries');
    expect(src).not.toContain('InboundDeadLetters');
  });
});

describe('Activity → Usage (U3)', () => {
  it('renders the totals the RPC returns', async () => {
    const row = {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 4,
      messages: 3,
    };
    usageSummary.mockResolvedValue({
      since: 0,
      until: 1,
      totals: { ...row, cacheHitRate: 0.25 },
      daily: [{ key: '2026-09-25', ...row }],
      by: { dimension: 'model', rows: [{ key: 'claude-sonnet-5', ...row }] },
    });
    await mount(createElement(UsagePanel));
    const text = container.textContent ?? '';
    expect(text).toContain('$4.00');
    expect(text).toContain('1.2k');
    expect(text).toContain('25.0%');
    expect(text).toContain('2026-09-25');
    expect(text).toContain('claude-sonnet-5');
    expect(usageSummary).toHaveBeenCalledWith({ windowMs: 7 * 24 * 60 * 60 * 1000, by: 'model' });
  });
});

describe('Chat header session cost (U3)', () => {
  it('draws the session spend beside the title, and nothing without a session', async () => {
    const base = { personalityId: 'researcher', model: 'm', onNewSession: () => undefined };
    await mount(
      createElement(PersonalityBar, { ...base, sessionTitle: 'Plan', sessionCostUsd: 0.1234 }),
    );
    expect(container.querySelector('.personality-bar-session-cost')?.textContent).toBe('$0.12');

    await mount(createElement(PersonalityBar, base));
    expect(container.querySelector('.personality-bar-session-cost')).toBeNull();
  });
});
