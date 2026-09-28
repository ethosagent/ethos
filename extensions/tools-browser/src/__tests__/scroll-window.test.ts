// UBP-039 (plan upstream-bug-parity): browser_scroll returned the WHOLE body
// aria snapshot, and executeParallel keeps only its head, so on a long page
// every scroll showed the same top-of-page text and the footer never arrived.
// The fix returns the part of the snapshot around the scroll position
// (`windowSnapshotAtScroll` in ../snapshot.ts), inside the tool's budget.

import type { Tool } from '@ethosagent/types';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserTools } from '../index';
import { type BrowserSession, makeMapKey, policyFingerprint, sessions } from '../sessions';
import { SCROLL_WINDOW_CHARS, windowSnapshotAtScroll } from '../snapshot';
import { HAS_CHROMIUM } from './credential-fixture';

vi.mock('../sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sessions')>()),
  isPlaywrightInstalled: () => true,
}));

const ITEMS = 2000;
const snapshotYaml = [
  '- heading "Issues" [level=1]',
  '- list:',
  ...Array.from({ length: ITEMS }, (_, i) => `  - listitem: Item number ${i + 1} of the list`),
  '- link "Next page":',
  '  - /url: /page/2',
].join('\n');

interface Metrics {
  scrollY: number;
  innerHeight: number;
  scrollHeight: number;
}

/** A page whose scroll position is the given metrics after the scroll. */
function fakePage(metrics: Metrics): Page {
  return {
    evaluate: async () => metrics,
    waitForTimeout: async () => {},
    title: async () => 'Issues',
    url: () => 'https://93.184.216.34/issues',
    locator: () => ({ ariaSnapshot: async () => snapshotYaml }),
  } as unknown as Page;
}

function seed(sessionId: string, page: Page, browser = {} as Browser): BrowserSession {
  const policy = {};
  const session: BrowserSession = {
    browser,
    context: { route: async () => {} } as unknown as BrowserContext,
    page,
    refs: new Map(),
    lastUrl: '',
    policyFingerprint: policyFingerprint(policy),
    consoleLogs: [],
    tier: 'stock',
    pendingWarnings: [],
    lastActiveAt: Date.now(),
    close: async () => {},
  };
  sessions.set(makeMapKey(sessionId, policy), session);
  return session;
}

function toolCtx(sessionId: string) {
  return {
    sessionId,
    abortSignal: new AbortController().signal,
    networkPolicy: {},
    // biome-ignore lint/suspicious/noExplicitAny: the tool reads only these fields
  } as any;
}

const scroll = new Map(createBrowserTools().map((t) => [t.name, t])).get('browser_scroll') as Tool;

afterEach(() => {
  sessions.clear();
});

describe('browser_scroll — returns the window at the scroll position (UBP-039)', () => {
  it('at the bottom of a 2000-item page, returns the last item within the budget', async () => {
    seed('s-bottom', fakePage({ scrollY: 79_400, innerHeight: 600, scrollHeight: 80_000 }));
    const result = await scroll.execute(
      { direction: 'down', amount: 100_000 },
      toolCtx('s-bottom'),
    );
    expect(result.ok).toBe(true);
    const value = result.ok ? result.value : '';
    expect(value).toContain('Item number 2000 of the list');
    expect(value).toContain('Next page');
    expect(value).not.toContain('Item number 1 of the list');
    expect(value.length).toBeLessThanOrEqual(scroll.maxResultChars ?? 0);
  });

  it('successive scroll positions show different content', async () => {
    seed('s-mid', fakePage({ scrollY: 40_000, innerHeight: 600, scrollHeight: 80_000 }));
    const mid = await scroll.execute({ direction: 'down' }, toolCtx('s-mid'));
    const value = mid.ok ? mid.value : '';
    expect(value).toContain('Item number 1000 of the list');
    expect(value).not.toContain('Item number 2000 of the list');
    expect(value).not.toContain('Item number 1 of the list');
    expect(value.length).toBeLessThanOrEqual(scroll.maxResultChars ?? 0);
  });

  it('at the top, still starts at the head of the page', async () => {
    seed('s-top', fakePage({ scrollY: 0, innerHeight: 600, scrollHeight: 80_000 }));
    const top = await scroll.execute({ direction: 'up' }, toolCtx('s-top'));
    const value = top.ok ? top.value : '';
    expect(value).toContain('Item number 1 of the list');
    expect(value).toContain('heading "Issues"');
  });

  it('keeps every ref resolvable, not only the ones in the window', async () => {
    const session = seed(
      's-refs',
      fakePage({ scrollY: 79_400, innerHeight: 600, scrollHeight: 80_000 }),
    );
    await scroll.execute({ direction: 'down' }, toolCtx('s-refs'));
    expect([...session.refs.values()].map((r) => r.name)).toContain('Next page');
  });
});

describe('windowSnapshotAtScroll', () => {
  it('returns a short snapshot unchanged', () => {
    const text = '- heading "Hi"\n- button "Go"';
    expect(
      windowSnapshotAtScroll(text, { scrollY: 500, innerHeight: 600, scrollHeight: 2000 }),
    ).toBe(text);
  });

  it('marks what it left out on each side', () => {
    const out = windowSnapshotAtScroll(snapshotYaml, {
      scrollY: 40_000,
      innerHeight: 600,
      scrollHeight: 80_000,
    });
    expect(out).toMatch(/^\[… \d+ lines above …\]/);
    expect(out).toMatch(/\[… \d+ lines below …\]$/);
    expect(out.length).toBeLessThanOrEqual(SCROLL_WINDOW_CHARS);
  });

  it('treats a page with no scroll height as the top', () => {
    const out = windowSnapshotAtScroll(snapshotYaml, {
      scrollY: 0,
      innerHeight: 0,
      scrollHeight: 0,
    });
    expect(out.startsWith('- heading "Issues"')).toBe(true);
  });
});

// The plan's end-to-end fixture: a real page with 2000 numbered items. Skips
// where no Playwright Chromium is installed (see ./credential-fixture.ts).
describe.skipIf(!HAS_CHROMIUM)('browser_scroll — real Chromium, 2000 items', () => {
  it('scrolling to the bottom reveals the last item within the budget', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const items = Array.from({ length: ITEMS }, (_, i) => `<li>Item ${i + 1}</li>`).join('');
      await page.setContent(`<h1>List</h1><ul>${items}</ul><a href="/p2">Next page</a>`);
      seed('s-real', page, browser);
      let value = '';
      for (let i = 0; i < 3; i++) {
        const r = await scroll.execute({ direction: 'down', amount: 1_000_000 }, toolCtx('s-real'));
        value = r.ok ? r.value : '';
      }
      expect(value).toContain('Item 2000');
      expect(value.length).toBeLessThanOrEqual(scroll.maxResultChars ?? 0);
    } finally {
      await browser.close();
    }
  });
});
