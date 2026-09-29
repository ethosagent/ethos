// @vitest-environment jsdom
//
// plan personality-memory-boundary-and-self-amendment G2, D30 — the Learning
// page's READ-ONLY "Definition changes" section. What is pinned: a pending
// amendment is listed; opening it shows the permission diff with the widening
// row and its high-risk flag, the toolset.yaml diff, the local-terminal
// banner, and the CLI command to apply — and there is no apply button.

import type { AmendmentRecordView, AmendmentReviewView } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listFn = vi.fn();
const getFn = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    amendments: {
      list: (...args: unknown[]) => listFn(...args),
      get: (...args: unknown[]) => getFn(...args),
    },
  },
}));

const { DefinitionChanges } = await import('../DefinitionChanges');

const RECORD: AmendmentRecordView = {
  schemaVersion: 1,
  id: 'a-abc-1',
  personalityId: 'researcher',
  target: 'toolset',
  ops: [{ op: 'add_tool', tool: 'terminal' }],
  opsHash: 'o'.repeat(64),
  baseHash: 'b'.repeat(64),
  rationale: '<img src=x onerror=alert(1)> I need a shell',
  evidence: [],
  provenance: {
    sessionId: 's-1',
    sessionKey: 'cli:amend',
    platform: 'cli',
    initiator: 'user',
    roomAudience: 'private',
    executionPosture: 'local',
    holdsShellTool: true,
  },
  preCheck: 'ok',
  status: 'pending',
  history: [{ action: 'filed', actor: 'intake', at: new Date().toISOString() }],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const REVIEW: AmendmentReviewView = {
  record: RECORD,
  file: 'toolset.yaml',
  personality: 'ok',
  liveHash: 'b'.repeat(64),
  stale: false,
  interruptedApply: false,
  expectedAfterHash: 'e'.repeat(64),
  textDiff: [' - read_file', '+- terminal'],
  permissionDiff: {
    changes: [
      {
        section: 'Toolset',
        field: 'toolset',
        direction: 'widens',
        detail: '+ terminal',
        flag: 'high-risk',
      },
    ],
    widens: true,
  },
  notCompared: 'Not compared: SOUL.md',
  flags: ['no-recorded-refusal', 'local-terminal', 'high-risk'],
};

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MemoryRouter, null, createElement(DefinitionChanges, null)),
      ),
    );
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  listFn.mockReset();
  getFn.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Definition changes (read-only)', () => {
  it('is absent when nothing is waiting', async () => {
    listFn.mockResolvedValue({ amendments: [] });
    await mount();
    expect(container.querySelector('[data-testid="definition-changes"]')).toBeNull();
    expect(listFn).toHaveBeenCalledWith({ statuses: ['pending', 'stale'] });
  });

  it('lists a pending amendment and opens its review', async () => {
    listFn.mockResolvedValue({ amendments: [RECORD] });
    getFn.mockResolvedValue({ review: REVIEW });
    await mount();
    const row = container.querySelector<HTMLElement>('[data-testid="amendment-row"]');
    expect(row?.textContent).toContain('+ terminal');
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(getFn).toHaveBeenCalledWith({ amendmentId: 'a-abc-1' });

    const diff = container.querySelector('[data-testid="amendment-permission-diff"]');
    const widening = diff?.querySelector('[data-direction="widens"]');
    expect(widening?.textContent).toContain('widens');
    expect(widening?.querySelector('[data-flag="high-risk"]')).not.toBeNull();
    expect(container.textContent).toContain('Not compared: SOUL.md');
    expect(
      container.querySelector('[data-testid="amendment-diff"] [data-kind="add"]')?.textContent,
    ).toContain('terminal');
    expect(
      container.querySelector('[data-testid="amendment-local-terminal"]')?.textContent,
    ).toContain('this review is not a boundary for it');
    expect(container.querySelector('[data-testid="amendment-cli"]')?.textContent).toContain(
      'ethos personality amendments apply a-abc-1',
    );
  });

  it('renders the rationale as text and offers no apply button', async () => {
    listFn.mockResolvedValue({ amendments: [RECORD] });
    getFn.mockResolvedValue({ review: REVIEW });
    await mount();
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="amendment-row"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    // The only buttons are the row toggles — nothing here applies, declines or rolls back.
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.every((b) => b.getAttribute('data-testid') === 'amendment-row')).toBe(true);
  });

  // plan personality-presence-and-initiative §1 — the birth ritual's request.
  it('renders an identity request readably, with config.yaml, no permission rows and the avatar step', async () => {
    const identity: AmendmentRecordView = {
      ...RECORD,
      id: 'a-id-1',
      target: 'identity',
      ops: [
        { op: 'set_name', value: 'Ledger' },
        { op: 'set_display_emoji', value: '🧾' },
        { op: 'set_display_avatar', value: 'upload' },
      ],
    };
    listFn.mockResolvedValue({ amendments: [identity] });
    getFn.mockResolvedValue({
      review: {
        ...REVIEW,
        record: identity,
        file: 'config.yaml',
        textDiff: ['-name: researcher', '+name: Ledger', '+display.emoji: 🧾'],
        permissionDiff: null,
        flags: [],
      },
    });
    await mount();
    const row = container.querySelector<HTMLElement>('[data-testid="amendment-row"]');
    expect(row?.textContent).toContain(
      'name → "Ledger", emoji → 🧾, avatar → upload after applying',
    );
    expect(row?.textContent).toContain('config.yaml');
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-testid="amendment-permission-diff"]')).toBeNull();
    expect(container.textContent).toContain('an identity change');
    expect(
      container.querySelector('[data-testid="amendment-diff"] [data-kind="add"]')?.textContent,
    ).toContain('name: Ledger');
    expect(
      container.querySelector('[data-testid="amendment-avatar-upload"]')?.textContent,
    ).toContain('upload it from');
  });
});
