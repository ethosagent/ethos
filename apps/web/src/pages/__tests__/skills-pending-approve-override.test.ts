// @vitest-environment jsdom
//
// Skills › Approval queue. A candidate that has not passed a replay is refused
// `OVERRIDE_REQUIRED` by `LearningInbox.approve` (plan `trust-before-reach.md`
// Design §6). The Approve button used to show a generic "Approve failed"; it
// now prompts for the human's reason, cannot submit a blank one, and sends it
// as `override.reason`. Other refusals read as what they are.

import type { PendingSkill } from '@ethosagent/web-contracts';
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

const pendingList = vi.fn();
const learningApprove = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    evolver: { pendingList: (...args: unknown[]) => pendingList(...args) },
    learning: { approve: (...args: unknown[]) => learningApprove(...args) },
  },
}));

const { PendingQueue } = await import('../Skills');

const PENDING: PendingSkill[] = [
  {
    id: 'cand-1',
    name: 'cite-sources',
    description: 'Always cite',
    body: 'Cite every claim.',
    proposedAt: '2026-09-12T00:00:00.000Z',
  },
];

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button "${label}". Saw: ${document.body.textContent}`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

async function typeReason(value: string): Promise<void> {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    '[data-testid="skills-override-reason"]',
  );
  if (!textarea) throw new Error('no reason textarea');
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  await act(async () => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

async function mount(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AntApp, null, createElement(PendingQueue)),
      ),
    );
  });
  await flush();
}

function refusal(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  vi.clearAllMocks();
  pendingList.mockResolvedValue({ pending: PENDING });
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

describe('Skills approval queue — approving a candidate that has not passed', () => {
  it('prompts for a reason instead of failing, and sends the reason it is given', async () => {
    learningApprove
      .mockRejectedValueOnce(
        refusal('OVERRIDE_REQUIRED', 'Verdict is not run; approving needs an override reason'),
      )
      .mockResolvedValueOnce({ candidate: {} });
    await mount();

    await click(button('Approve'));

    expect(learningApprove).toHaveBeenCalledTimes(1);
    expect(learningApprove.mock.calls[0]?.[0]).toEqual({
      candidateId: 'cand-1',
      clientId: expect.any(String),
    });
    expect(document.body.textContent).toContain('Approve without a passing replay?');
    expect(document.body.textContent).not.toContain('Approve failed');

    // Blank cannot be submitted.
    expect(button('Approve anyway').disabled).toBe(true);
    await typeReason('   ');
    expect(button('Approve anyway').disabled).toBe(true);
    await click(button('Approve anyway'));
    expect(learningApprove).toHaveBeenCalledTimes(1);

    await typeReason('checked it against three sessions by hand');
    expect(button('Approve anyway').disabled).toBe(false);
    await click(button('Approve anyway'));

    expect(learningApprove).toHaveBeenCalledTimes(2);
    expect(learningApprove.mock.calls[1]?.[0]).toEqual({
      candidateId: 'cand-1',
      clientId: expect.any(String),
      override: { reason: 'checked it against three sessions by hand' },
    });
  });

  it('shows a STALE refusal as a readable message and opens no reason prompt', async () => {
    learningApprove.mockRejectedValueOnce(
      refusal('STALE', 'The live file changed since this candidate was submitted'),
    );
    await mount();

    await click(button('Approve'));

    expect(document.body.textContent).toContain(
      'Not applied — the live file changed since this was drafted',
    );
    expect(document.body.textContent).not.toContain('Approve without a passing replay?');
  });
});
