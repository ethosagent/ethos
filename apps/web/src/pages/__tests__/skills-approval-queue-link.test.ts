// @vitest-environment jsdom
//
// Skills › Evolver › Approval queue. This tab used to be its own queue with an
// Approve button that decided through `learning.approve` (and, before that,
// read only one of the three skill queues). Every learned change now waits in
// the Learning inbox (plan `trust-before-reach.md` Part 4, L-T9: "Existing
// screens link here instead of keeping their own queues"), so the tab is a
// count of waiting skill candidates and a link to Learning filtered to skills.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
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

const learningList = vi.fn();
const learningApprove = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    learning: {
      list: (...args: unknown[]) => learningList(...args),
      approve: (...args: unknown[]) => learningApprove(...args),
    },
  },
}));

const { ApprovalQueueLink } = await import('../Skills');

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
        createElement(MemoryRouter, null, createElement(ApprovalQueueLink)),
      ),
    );
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
});

describe('Skills approval queue — a link to Learning', () => {
  it('counts the waiting skill candidates and links to Learning filtered to skills', async () => {
    learningList.mockResolvedValue({ candidates: [{ id: 'a' }, { id: 'b' }] });
    await mount();

    expect(learningList).toHaveBeenCalledWith({
      kind: 'skill',
      statuses: ['pending_replay', 'pending_review'],
      limit: 500,
    });
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="skills-learning-link"]');
    expect(link?.textContent).toBe('2 skill changes waiting in Learning →');
    expect(link?.getAttribute('href')).toBe('/learning?kind=skill');
    // No decision is made here any more.
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(learningApprove).not.toHaveBeenCalled();
  });

  it('says nothing is waiting rather than showing an empty queue', async () => {
    learningList.mockResolvedValue({ candidates: [] });
    await mount();
    expect(container.textContent).toContain('No skill changes waiting in Learning →');
  });

  it('keeps no queue of its own in the Skills page source', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'Skills.tsx'), 'utf8');
    expect(source).not.toContain('function PendingQueue');
    expect(source).not.toContain('rpc.evolver.pendingList');
    expect(source).not.toContain('rpc.learning.approve');
    expect(source).toContain("label: 'Approval queue', children: <ApprovalQueueLink />");
  });
});
