// @vitest-environment jsdom
//
// The Outbox pane (plan/phases/trust-before-reach.md Part 2, O-T10), driven in
// jsdom the same way `Mcp.test.ts` and `recipes-gallery.test.ts` drive theirs.
//
// The four promises asserted here are the ones a person's trust rests on: you
// cannot approve text you are midway through changing; a sent item admits Ethos
// cannot take it back; a stale approve reads as "changed since you viewed it"
// and re-reads instead of publishing; and the containers are raw primitives
// with tokenised colour, not the `Card` primitive with a hex.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OutboxItemView } from '@ethosagent/web-contracts';
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
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let routeParams: { personalityId?: string; teamId?: string } = { personalityId: 'cmo' };

vi.mock('react-router-dom', () => ({
  useParams: () => routeParams,
}));

const listFn = vi.fn();
const approveFn = vi.fn();
const editFn = vi.fn();
const rejectFn = vi.fn();
const revokeFn = vi.fn();
const retryFn = vi.fn();
const telegramBotsFn = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    outbox: {
      list: (...args: unknown[]) => listFn(...args),
      approve: (...args: unknown[]) => approveFn(...args),
      edit: (...args: unknown[]) => editFn(...args),
      reject: (...args: unknown[]) => rejectFn(...args),
      revoke: (...args: unknown[]) => revokeFn(...args),
      retry: (...args: unknown[]) => retryFn(...args),
    },
    platforms: {
      botsListTelegram: (...args: unknown[]) => telegramBotsFn(...args),
    },
  },
}));

const { Outbox } = await import('../Outbox');

const NOW = Date.now();

function item(over: Partial<OutboxItemView> = {}): OutboxItemView {
  return {
    id: 'obx_1',
    personalityId: 'cmo',
    botKey: 'bk_abc',
    platform: 'telegram',
    chatId: '-1002145',
    threadId: null,
    revision: 1,
    contentHash: 'sha256:aaa',
    text: 'Ethos 0.9 is out.\n\nChangelog → ethosagent.ai/changelog',
    state: 'awaiting_approval',
    createdAt: NOW - 600_000,
    updatedAt: NOW - 600_000,
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

async function mount(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Outbox, null)));
  });
  await flush();
}

function q<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector);
}

async function click(selector: string): Promise<void> {
  const el = q<HTMLElement>(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

/** React tracks the DOM value itself, so a controlled field only sees a change
 *  written through the native setter. */
async function type(selector: string, value: string): Promise<void> {
  const el = q<HTMLTextAreaElement>(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(el, value);
  await act(async () => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  routeParams = { personalityId: 'cmo' };
  telegramBotsFn.mockResolvedValue({ bots: [{ botKey: 'bk_abc', username: 'EthosMarketingBot' }] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('Outbox pane', () => {
  it('scopes the list to the route personality and shows the exact bytes', async () => {
    listFn.mockResolvedValue({ items: [item()] });
    await mount();
    expect(listFn).toHaveBeenCalledWith({ personalityId: 'cmo' });
    // Byte-for-byte, line breaks intact, nothing truncated.
    expect(q('[data-testid="outbox-preview"]')?.textContent).toBe(
      'Ethos 0.9 is out.\n\nChangelog → ethosagent.ai/changelog',
    );
    expect(container.textContent).toContain('@EthosMarketingBot');
    expect(container.textContent).toContain('Telegram · -1002145');
  });

  it('gathers the whole team when the route carries only a team', async () => {
    routeParams = { teamId: 'marketing' };
    listFn.mockResolvedValue({ items: [] });
    await mount();
    expect(listFn).toHaveBeenCalledWith({ teamId: 'marketing' });
  });

  it('disables Approve while an edit is dirty, and restores it when the text matches again', async () => {
    listFn.mockResolvedValue({ items: [item()] });
    await mount();
    const approve = () => q<HTMLButtonElement>('[data-testid="outbox-approve"]');
    expect(approve()?.disabled).toBe(false);

    await click('[data-testid="outbox-edit"]');
    // Opened but untouched: the bytes on screen are still the bound ones.
    expect(approve()?.disabled).toBe(false);

    await type('[data-testid="outbox-edit-text"]', 'Ethos 0.9 is out. Now with SOC2.');
    expect(approve()?.disabled).toBe(true);
    expect(approveFn).not.toHaveBeenCalled();

    await type('[data-testid="outbox-edit-text"]', item().text);
    expect(approve()?.disabled).toBe(false);
  });

  it('approves with the revision and hash that were on screen', async () => {
    listFn.mockResolvedValue({ items: [item({ revision: 2, contentHash: 'sha256:bbb' })] });
    approveFn.mockResolvedValue({ item: item({ state: 'approved' }) });
    await mount();
    await click('[data-testid="outbox-approve"]');
    expect(approveFn).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'obx_1', revision: 2, contentHash: 'sha256:bbb' }),
    );
  });

  it('surfaces a stale approve as "changed since you viewed it" and re-reads', async () => {
    listFn.mockResolvedValue({ items: [item()] });
    approveFn.mockRejectedValue(Object.assign(new Error('stale'), { code: 'CONFLICT' }));
    await mount();
    const readsBefore = listFn.mock.calls.length;

    await click('[data-testid="outbox-approve"]');

    expect(q('[data-testid="outbox-conflict"]')?.textContent).toContain(
      'Changed since you viewed it',
    );
    // Never a generic failure banner, and never the text nobody approved.
    expect(container.querySelector('.outbox-notice-bad')).toBeNull();
    expect(listFn.mock.calls.length).toBeGreaterThan(readsBefore);
  });

  it('says Ethos cannot unsend a sent item', async () => {
    listFn.mockResolvedValue({ items: [item({ state: 'sent', sentAt: NOW - 60_000 })] });
    await mount();
    expect(q('[data-testid="outbox-cannot-unsend"]')?.textContent).toContain(
      'Ethos cannot unsend this — delete it on Telegram.',
    );
    // Nothing to decide on a sent item.
    expect(q('[data-testid="outbox-approve"]')).toBeNull();
  });

  it('hands an unconfirmed item to the ledger and says the outbox will not resend', async () => {
    listFn.mockResolvedValue({
      items: [item({ state: 'unconfirmed', obligationId: 'obl_7f3c' })],
    });
    await mount();
    const notice = q('[data-testid="outbox-unconfirmed"]')?.textContent ?? '';
    expect(notice).toContain('The ledger owns the retry');
    expect(notice).toContain('obl_7f3c');
  });

  it('banners an approved item that nothing has claimed', async () => {
    listFn.mockResolvedValue({
      items: [item({ state: 'approved', approvedAt: NOW - 3_600_000 })],
    });
    await mount();
    const banner = q('[data-testid="outbox-waiting-banner"]')?.textContent ?? '';
    expect(banner).toContain('1 approved post is waiting');
    expect(banner).toContain('Nothing is lost');
    // Revocable until the dispatcher claims it.
    expect(q('[data-testid="outbox-revoke"]')).not.toBeNull();
  });

  it('renders terminal items as dense rows, with Retry only on a failure', async () => {
    listFn.mockResolvedValue({
      items: [
        item({ id: 'a', state: 'rejected', rejectionReason: 'superlative, unverifiable' }),
        item({ id: 'b', state: 'expired' }),
        item({ id: 'c', state: 'failed', failureReason: 'interrupted before the platform call' }),
      ],
    });
    await mount();
    expect(container.querySelectorAll('[data-testid="outbox-terminal-row"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-testid="outbox-item"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="outbox-retry"]')).toHaveLength(1);
  });

  it('rejects with a reason, and refuses to send an empty one', async () => {
    listFn.mockResolvedValue({ items: [item()] });
    rejectFn.mockResolvedValue({ item: item({ state: 'rejected' }) });
    await mount();
    const rejectButton = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Reject…'),
    );
    await act(async () => {
      rejectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(q<HTMLButtonElement>('[data-testid="outbox-confirm-reject"]')?.disabled).toBe(true);
    await type('[data-testid="outbox-reject-reason"]', 'superlative, unverifiable');
    await click('[data-testid="outbox-confirm-reject"]');
    expect(rejectFn).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'obx_1', reason: 'superlative, unverifiable' }),
    );
  });

  it('says nothing is queued rather than drawing empty sections', async () => {
    listFn.mockResolvedValue({ items: [] });
    await mount();
    expect(container.querySelector('.outbox-empty')?.textContent).toContain('Nothing queued');
    expect(container.querySelectorAll('[data-testid^="outbox-section-"]')).toHaveLength(0);
  });
});

describe('Outbox pane — DESIGN.md conformance', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'Outbox.tsx'), 'utf8');
  const css = readFileSync(join(import.meta.dirname, '..', '..', 'styles.css'), 'utf8');

  function block(selector: string): string {
    const start = css.indexOf(`${selector} {`);
    expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf('}', start));
  }

  it('never imports the Card primitive — cards earn existence', () => {
    const antdImport = source.match(/import \{([^}]*)\} from 'antd';/)?.[1] ?? '';
    expect(antdImport.length).toBeGreaterThan(0);
    expect(antdImport).not.toContain('Card');
    expect(source).not.toMatch(/<Card[\s/>]/);
  });

  it('hardcodes no colour: every hue is a token', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const outboxCss = css.slice(css.indexOf('.outbox-pane {'));
    expect(outboxCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('draws no coloured left border on an item — the anti-slop rule', () => {
    const attn = block('.outbox-item-attn');
    expect(attn).not.toContain('border-left');
    expect(attn).toContain('border-color: var(--ethos-border-strong)');
  });

  it('keeps the published bytes verbatim: mono, pre-wrap, no ellipsis', () => {
    const preview = block('.outbox-preview');
    expect(preview).toContain('white-space: pre-wrap');
    expect(preview).toContain('font-mono');
    expect(preview).not.toContain('text-overflow');
  });

  it('carries state with an icon and a word, not colour alone', () => {
    // Every pill tone is a token pair, and the markup always renders a word
    // beside the glyph — `statePill` is pinned for that in `outbox.test.ts`.
    expect(block('.outbox-pill-wait')).toContain('var(--ethos-warning)');
    expect(block('.outbox-pill-ok')).toContain('var(--ethos-success)');
    expect(block('.outbox-pill-bad')).toContain('var(--ethos-error)');
  });
});
