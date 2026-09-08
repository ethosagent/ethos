// `browser_computed_style` — the two gates that make it safe to point at an
// arbitrary page, plus the in-page collector's counting rules.
//
// The collector normally runs inside Chromium, so it is exercised here against
// a stub `document` / `window`: that is the same code Playwright stringifies
// into the page, which is why it must stay self-contained.
//
// Drop the `ALLOWED_PROPERTIES` check in `parseComputedStyleArgs` and
// "refuses a property outside the allowlist" fails. Drop the `maxElements`
// guard in `collectComputedStyles` and "stops recording at the element cap"
// fails while `considered` still reports the true total.

import type { Tool } from '@ethosagent/types';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMPUTED_STYLE_PROPERTIES,
  type ComputedStyleElement,
  collectComputedStyles,
  parseComputedStyleArgs,
} from '../browser-computed-style';
import { createBrowserTools } from '../index';
import { type BrowserSession, makeMapKey, policyFingerprint, sessions } from '../sessions';

vi.mock('../sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sessions')>()),
  isPlaywrightInstalled: () => true,
}));

// ---------------------------------------------------------------------------
// Stub page / DOM
// ---------------------------------------------------------------------------

interface StubNode {
  tagName: string;
  styles: Record<string, string>;
}

function node(tagName: string, styles: Record<string, string> = {}): StubNode {
  return { tagName, styles };
}

/** Installs a `document` / `window` pair the collector can query. */
function stubDom(matches: Record<string, StubNode[]>, invalid: string[] = []): void {
  vi.stubGlobal('document', {
    querySelectorAll(selector: string) {
      if (invalid.includes(selector)) throw new Error(`invalid selector: ${selector}`);
      return matches[selector] ?? [];
    },
  });
  vi.stubGlobal('window', {
    getComputedStyle(el: StubNode) {
      return {
        getPropertyValue: (property: string) => el.styles[property] ?? '',
      };
    },
  });
}

const collectInput = {
  properties: ['color', 'font-family'],
  maxElements: 40,
  maxValueChars: 200,
};

// A public IP literal keeps validateUrl / checkSsrf off the network.
const url = 'https://93.184.216.34/';

function fakePage(evaluateResult: unknown) {
  return {
    goto: async () => ({ status: () => 200, headers: () => ({}) }),
    waitForTimeout: async () => {},
    title: async () => 'Example',
    url: () => url,
    locator: () => ({ ariaSnapshot: async () => '- heading "Example" [level=1]' }),
    evaluate: async () => evaluateResult,
  } as unknown as Page;
}

function seed(sessionId: string, page: Page, warnings: string[] = []): BrowserSession {
  const policy = {};
  const session: BrowserSession = {
    browser: {} as Browser,
    context: { route: async () => {} } as unknown as BrowserContext,
    page,
    refs: new Map(),
    lastUrl: '',
    policyFingerprint: policyFingerprint(policy),
    consoleLogs: [],
    tier: 'stock',
    pendingWarnings: [...warnings],
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

function computedStyleTool(): Tool {
  const tool = createBrowserTools().find((t) => t.name === 'browser_computed_style');
  if (!tool) throw new Error('browser_computed_style is not registered');
  return tool;
}

afterEach(() => {
  sessions.clear();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Property allowlist
// ---------------------------------------------------------------------------

describe('browser_computed_style — property allowlist', () => {
  it('refuses a property outside the allowlist, naming it and the allowed set', async () => {
    seed('s-prop', fakePage({ elements: [], considered: 0, invalidSelectors: [] }));

    const result = await computedStyleTool().execute(
      { url, properties: ['color', 'content'] },
      toolCtx('s-prop'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('input_invalid');
    expect(result.error).toContain('content');
    expect(result.error).toContain('font-family');
  });

  it('accepts every property it advertises', () => {
    const parsed = parseComputedStyleArgs({ properties: [...COMPUTED_STYLE_PROPERTIES] });
    expect(parsed.ok).toBe(true);
  });

  it('defaults to the full allowlist and the built-in selector sweep', () => {
    const parsed = parseComputedStyleArgs({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.properties).toEqual([...COMPUTED_STYLE_PROPERTIES]);
    expect(parsed.value.selectors).toContain('body');
    expect(parsed.value.selectors).toContain('h1');
  });
});

// ---------------------------------------------------------------------------
// Selector validation — a selector is data, but a bounded amount of it
// ---------------------------------------------------------------------------

describe('browser_computed_style — selector bounds', () => {
  it('refuses more selectors than the cap', () => {
    const parsed = parseComputedStyleArgs({ selectors: Array.from({ length: 26 }, () => 'div') });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('Too many selectors');
  });

  it('refuses an over-long selector', () => {
    const parsed = parseComputedStyleArgs({ selectors: [`div${':has(a)'.repeat(40)}`] });
    expect(parsed.ok).toBe(false);
  });

  it('refuses a non-string selector', () => {
    const parsed = parseComputedStyleArgs({ selectors: ['body', 7] });
    expect(parsed.ok).toBe(false);
  });

  // PRESERVED-BEHAVIOUR GUARD, with the ceiling's new value. `max_elements`
  // is still clamped rather than trusted; only the number moved.
  it('clamps max_elements to the ceiling', () => {
    const parsed = parseComputedStyleArgs({ max_elements: 5000 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.maxElements).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// The in-page collector
// ---------------------------------------------------------------------------

describe('collectComputedStyles', () => {
  it('stops recording at the element cap but still counts what it saw', () => {
    const nodes = Array.from({ length: 12 }, () => node('p', { color: 'rgb(0, 0, 0)' }));
    stubDom({ p: nodes });

    const out = collectComputedStyles({ ...collectInput, selectors: ['p'], maxElements: 5 });

    expect(out.elements).toHaveLength(5);
    expect(out.considered).toBe(12);
  });

  it('counts an element once even when two selectors match it', () => {
    const heading = node('h1', { color: 'rgb(1, 2, 3)' });
    stubDom({ h1: [heading], '.hero-title': [heading] });

    const out = collectComputedStyles({ ...collectInput, selectors: ['h1', '.hero-title'] });

    expect(out.considered).toBe(1);
    expect(out.elements).toEqual<ComputedStyleElement[]>([
      { selector: 'h1', tagName: 'h1', styles: { color: 'rgb(1, 2, 3)' } },
    ]);
  });

  it('skips elements the layout does not draw', () => {
    stubDom({
      p: [
        node('p', { color: 'rgb(0, 0, 0)', display: 'none' }),
        node('p', { color: 'rgb(0, 0, 0)', visibility: 'hidden' }),
        node('p', { color: 'rgb(9, 9, 9)' }),
      ],
    });

    const out = collectComputedStyles({ ...collectInput, selectors: ['p'] });

    expect(out.considered).toBe(1);
    expect(out.elements[0]?.styles.color).toBe('rgb(9, 9, 9)');
  });

  it('reports a selector the page rejects without discarding the rest', () => {
    stubDom({ body: [node('body', { color: 'rgb(0, 0, 0)' })] }, ['a:::bad']);

    const out = collectComputedStyles({ ...collectInput, selectors: ['a:::bad', 'body'] });

    expect(out.invalidSelectors).toEqual(['a:::bad']);
    expect(out.elements).toHaveLength(1);
  });

  it('truncates a single monstrous value rather than shipping it whole', () => {
    stubDom({ body: [node('body', { 'background-image': `url(data:${'A'.repeat(5000)})` })] });

    const out = collectComputedStyles({
      selectors: ['body'],
      properties: ['background-image'],
      maxElements: 40,
      maxValueChars: 50,
    });

    expect(out.elements[0]?.styles['background-image']).toHaveLength(51);
  });
});

// ---------------------------------------------------------------------------
// Result shape and budget
// ---------------------------------------------------------------------------

describe('browser_computed_style — result', () => {
  it('returns per-element records with the totals a count can be checked against', async () => {
    seed(
      's-ok',
      fakePage({
        elements: [
          { selector: 'h1', tagName: 'h1', styles: { color: 'rgb(1, 2, 3)' } },
          { selector: 'p', tagName: 'p', styles: { color: 'rgb(1, 2, 3)' } },
        ],
        considered: 2,
        invalidSelectors: [],
      }),
    );

    const result = await computedStyleTool().execute({ url }, toolCtx('s-ok'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = JSON.parse(result.value);
    expect(payload.considered).toBe(2);
    expect(payload.returned).toBe(2);
    expect(payload.truncated).toBe(false);
    expect(payload.elements[1]).toEqual({
      selector: 'p',
      tagName: 'p',
      styles: { color: 'rgb(1, 2, 3)' },
    });
  });

  it('carries a launch notice inside the JSON, so the result stays parseable', async () => {
    seed('s-warn', fakePage({ elements: [], considered: 0, invalidSelectors: [] }), [
      'no display; fell back to headless',
    ]);

    const result = await computedStyleTool().execute({ url }, toolCtx('s-warn'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = JSON.parse(result.value);
    expect(payload.notices).toEqual(['\u26a0 no display; fell back to headless']);
  });

  // PRESERVED-BEHAVIOUR GUARD. The budget is still the backstop for a page
  // whose values are fatter than the per-element allowance the ceiling was
  // sized against: whole records are dropped, never a truncated tail, and
  // `truncated` says so. Only the numbers moved.
  it('drops whole records to stay inside the result budget, and says so', async () => {
    const fat = Array.from({ length: 300 }, (_, i) => ({
      selector: '.card',
      tagName: 'div',
      styles: {
        color: 'rgb(0, 0, 0)',
        'font-family': `"Family ${i}", ${'Fallback, '.repeat(20)}sans-serif`,
        'box-shadow': `rgba(0, 0, 0, 0.2) 0px ${i}px 24px 0px`,
      },
    }));
    seed('s-fat', fakePage({ elements: fat, considered: 300, invalidSelectors: [] }));

    const result = await computedStyleTool().execute({ url }, toolCtx('s-fat'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeLessThanOrEqual(64_000);
    const payload = JSON.parse(result.value);
    expect(payload.truncated).toBe(true);
    expect(payload.returned).toBe(payload.elements.length);
    expect(payload.returned).toBeLessThan(300);
  });

  // The whole point of raising the ceiling: a caller that asks for the ceiling
  // gets the ceiling. A page's default sweep is filled in SELECTOR order, and
  // the six selectors that carry buttons and cards are the last six of the
  // fifteen — so a cap that stops before them returns a page with no card and
  // no button on it, whatever the page actually draws. The result budget is
  // sized so it does not take the elements back: the ELEMENT CAP is what binds
  // on a page of ordinary elements.
  it('returns a whole ceiling-sized sweep of ordinary elements', async () => {
    // Real `getComputedStyle` output shapes, not placeholder strings: the
    // claim under test is about the size of an ORDINARY element record.
    const ordinary = Array.from({ length: 120 }, (_, i) => ({
      selector: i % 4 === 0 ? '.card' : 'p',
      tagName: i % 4 === 0 ? 'div' : 'p',
      styles: {
        color: 'rgb(17, 22, 33)',
        'background-color': 'rgba(0, 0, 0, 0)',
        'background-image': 'none',
        'border-color': 'rgb(17, 22, 33)',
        'border-radius': '8px',
        'border-width': '0px',
        'box-shadow': `rgba(16, 24, 40, 0.06) 0px ${i % 4}px 2px 0px`,
        'font-family': 'Inter, -apple-system, "Segoe UI", Roboto, sans-serif',
        'font-size': '16px',
        'font-weight': '400',
        'letter-spacing': 'normal',
        'line-height': '24px',
        padding: '0px 0px 16px',
        'text-transform': 'none',
      },
    }));
    seed('s-sweep', fakePage({ elements: ordinary, considered: 120, invalidSelectors: [] }));

    const result = await computedStyleTool().execute(
      { url, max_elements: 120 },
      toolCtx('s-sweep'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = JSON.parse(result.value);
    expect(payload.returned).toBe(120);
    expect(payload.truncated).toBe(false);
    // The tail selectors survived, which is the thing a 40-element cap ate.
    expect(payload.elements.at(-1).selector).toBe('p');
    expect(
      payload.elements.filter((e: ComputedStyleElement) => e.selector === '.card'),
    ).toHaveLength(30);
  });
});
