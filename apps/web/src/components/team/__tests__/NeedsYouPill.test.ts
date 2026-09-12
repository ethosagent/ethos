// @vitest-environment jsdom
//
// teams-as-a-scope T4 — the breadcrumb's Needs-you pill (D11): hidden at
// zero, counts `needs_revision` + `blocked`, and deep-links the Board on the
// first of them.
//
// trust-before-reach O-T10 adds the outbox half: an `awaiting_approval`
// publication is also work owed to a person, so it is in the count, and with
// no ticket waiting the pill opens the Outbox instead of the Board.

import type { OutboxItemView } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardSnapshot, flush, installDomStubs, task } from '../../../pages/team/__tests__/harness';

installDomStubs();

const getBoard = vi.fn();
const outboxList = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    kanban: { getBoard: (...args: unknown[]) => getBoard(...args) },
    outbox: { list: (...args: unknown[]) => outboxList(...args) },
  },
}));

/** A real `OutboxItemView` — the pill reads only `state`, but the wire shape is
 *  what the pane is handed, so the fixture is the wire shape. */
function outboxItem(id: string, state: OutboxItemView['state']): OutboxItemView {
  return {
    id,
    personalityId: 'cmo',
    botKey: 'bk_abc',
    platform: 'telegram',
    chatId: '-100',
    threadId: null,
    revision: 1,
    contentHash: 'sha256:aaa',
    text: 'Draft',
    state,
    createdAt: 0,
    updatedAt: 0,
    approverPersonality: null,
    review: null,
    approvedBy: null,
    approvedAt: null,
    approvedRevision: null,
    claimedAt: null,
    sentAt: null,
    obligationId: null,
    failureReason: null,
    rejectionReason: null,
    originSessionKey: null,
  };
}

const { NeedsYouPill } = await import('../NeedsYouPill');

let container: HTMLDivElement;
let root: Root;

async function mount(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Number.POSITIVE_INFINITY } },
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MemoryRouter, null, createElement(NeedsYouPill, { teamId: 'marketing' })),
      ),
    );
  });
  await flush();
}

beforeEach(() => {
  outboxList.mockResolvedValue({ items: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('NeedsYouPill', () => {
  it('renders nothing when no ticket needs the operator', async () => {
    getBoard.mockResolvedValue({
      board: boardSnapshot({ tasks: [task('t-run-001', 'Sweep', 'running', 'reddit-scout')] }),
    });
    await mount();
    expect(getBoard).toHaveBeenCalledWith({ team: 'marketing' });
    expect(container.querySelector('.team-needs-pill')).toBeNull();
  });

  it('counts needs_revision + blocked and links the board to the first', async () => {
    getBoard.mockResolvedValue({ board: boardSnapshot() });
    await mount();
    const pill = container.querySelector('a.team-needs-pill');
    expect(pill?.textContent).toBe('2 need you');
    expect(pill?.getAttribute('href')).toBe('/t/marketing/board?task=t-rev-001');
  });

  it('counts an outbox item awaiting approval, and opens the Outbox when no ticket waits', async () => {
    getBoard.mockResolvedValue({
      board: boardSnapshot({ tasks: [task('t-run-001', 'Sweep', 'running', 'reddit-scout')] }),
    });
    outboxList.mockResolvedValue({
      items: [outboxItem('obx_1', 'awaiting_approval'), outboxItem('obx_2', 'sent')],
    });
    await mount();
    expect(outboxList).toHaveBeenCalledWith({ teamId: 'marketing' });
    const pill = container.querySelector('a.team-needs-pill');
    expect(pill?.textContent).toBe('1 needs you');
    expect(pill?.getAttribute('href')).toBe('/t/marketing/outbox');
  });

  it('adds publications to the ticket count, and a ticket still wins the link', async () => {
    getBoard.mockResolvedValue({ board: boardSnapshot() });
    outboxList.mockResolvedValue({ items: [outboxItem('obx_1', 'awaiting_approval')] });
    await mount();
    const pill = container.querySelector('a.team-needs-pill');
    expect(pill?.textContent).toBe('3 need you');
    expect(pill?.getAttribute('href')).toBe('/t/marketing/board?task=t-rev-001');
  });

  it('reads singular at one', async () => {
    getBoard.mockResolvedValue({
      board: boardSnapshot({ tasks: [task('t-blk-009', 'Draft', 'blocked', 'cmo')] }),
    });
    await mount();
    const pill = container.querySelector('a.team-needs-pill');
    expect(pill?.textContent).toBe('1 needs you');
    expect(pill?.getAttribute('href')).toBe('/t/marketing/board?task=t-blk-009');
  });
});
