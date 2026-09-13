// @vitest-environment jsdom
//
// Living Soul "Apply update" is a human approval of an Expression draft that no
// replay has measured, so the server requires an override reason
// (`LearningInbox.approve`, plan `trust-before-reach.md` Design §6). The button
// used to send none and fail `INVALID_INPUT`. It now cannot submit without a
// reason the human typed, and sends exactly that reason — never a default.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
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

const livingSoul = vi.fn();
const learningList = vi.fn();
const proposeExpression = vi.fn();
const applyExpression = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    personalities: {
      livingSoul: (...args: unknown[]) => livingSoul(...args),
      proposeExpression: (...args: unknown[]) => proposeExpression(...args),
      applyExpression: (...args: unknown[]) => applyExpression(...args),
    },
    learning: { list: (...args: unknown[]) => learningList(...args) },
  },
}));

const { LivingSoulSection } = await import('../LivingSoulSection');

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Antd renders the modal in a portal, so search the whole document. */
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
    '[data-testid="living-soul-override-reason"]',
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
        createElement(
          MemoryRouter,
          null,
          createElement(AntApp, null, createElement(LivingSoulSection, { personalityId: 'sage' })),
        ),
      ),
    );
  });
  await flush();
}

async function openProposal(): Promise<void> {
  await mount();
  await click(button('Propose voice update'));
}

beforeEach(() => {
  vi.clearAllMocks();
  livingSoul.mockResolvedValue({ expression: 'I speak slowly.', learningLog: [] });
  learningList.mockResolvedValue({ candidates: [] });
  proposeExpression.mockResolvedValue({
    currentExpression: 'I speak slowly.',
    newExpression: 'I speak plainly.',
    rationale: 'brevity lands',
    evidence: 'user: shorter please',
  });
  applyExpression.mockResolvedValue({ revisionId: 'expr-rev-1' });
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

describe('LivingSoulSection — Apply on an unreplayed draft', () => {
  it('cannot submit without a reason: Apply stays disabled while the reason is empty or blank', async () => {
    await openProposal();

    expect(button('Apply update').disabled).toBe(true);
    await click(button('Apply update'));
    expect(applyExpression).not.toHaveBeenCalled();

    await typeReason('   ');
    expect(button('Apply update').disabled).toBe(true);
    await click(button('Apply update'));
    expect(applyExpression).not.toHaveBeenCalled();
  });

  it('sends the reason the human typed as overrideReason', async () => {
    await openProposal();

    await typeReason('  read the diff; plainer is right  ');
    expect(button('Apply update').disabled).toBe(false);
    await click(button('Apply update'));

    expect(applyExpression).toHaveBeenCalledTimes(1);
    expect(applyExpression).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sage',
        newExpression: 'I speak plainly.',
        overrideReason: 'read the diff; plainer is right',
      }),
    );
  });

  it('surfaces a refusal as a readable message, not a generic error', async () => {
    applyExpression.mockRejectedValue(
      Object.assign(new Error('Expression not applied: the live SOUL.md changed since submit'), {
        code: 'STALE',
      }),
    );
    await openProposal();
    await typeReason('reviewed');
    await click(button('Apply update'));

    expect(document.body.textContent).toContain(
      'Not applied — the live file changed since this was drafted',
    );
    expect(document.body.textContent).toContain('the live SOUL.md changed since submit');
  });
});

describe('LivingSoulSection — links to Learning instead of keeping a queue', () => {
  it('shows how many changes wait in Learning, filtered to this personality, and no Approve button', async () => {
    learningList.mockResolvedValue({ candidates: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    await mount();

    expect(learningList).toHaveBeenCalledWith({
      personalityId: 'sage',
      statuses: ['pending_replay', 'pending_review'],
      limit: 500,
    });
    const link = document.querySelector<HTMLAnchorElement>(
      '[data-testid="living-soul-learning-link"]',
    );
    expect(link?.textContent).toBe('3 changes waiting in Learning →');
    expect(link?.getAttribute('href')).toBe('/learning?personality=sage');
    expect(document.body.textContent).not.toContain('Pending skill candidates');
    expect(
      [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()),
    ).not.toContain('Approve');
  });

  it('links a Learning Log entry to the candidate it was promoted from, where there is one', async () => {
    livingSoul.mockResolvedValue({
      expression: 'I speak plainly.',
      learningLog: [
        {
          revisionId: 'expr-rev-2',
          at: '2026-09-12T00:00:00.000Z',
          summary: 'learning candidate cand-7',
          evidenceRef: 'learning:cand-7',
          prevExpressionRef: 'expr-rev-1',
        },
        {
          revisionId: 'expr-rev-1',
          at: '2026-09-11T00:00:00.000Z',
          summary: 'applied from the web',
          evidenceRef: 'web:2026-09-11T00:00:00.000Z',
          prevExpressionRef: '',
        },
      ],
    });
    await mount();

    const links = [
      ...document.querySelectorAll<HTMLAnchorElement>(
        '[data-testid="living-soul-log-candidate-link"]',
      ),
    ];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/learning?candidate=cand-7']);
  });
});
