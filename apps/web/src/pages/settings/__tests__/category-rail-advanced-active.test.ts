// @vitest-environment jsdom
//
// B6 follow-up — the rail's own comment promises "the active row must never be
// invisible", but toggling the Advanced disclosure while STANDING IN an
// advanced category used to hide the active row anyway. Now the group stays
// visible while the active category is advanced; a "hide" clicked there takes
// effect once you navigate out. Real DOM because the assertion is the
// `is-collapsed` class (display: none) on the group that holds the active row.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CategoryRail } from '../CategoryRail';
import { visibleCategories } from '../lib/taxonomy';

let container: HTMLDivElement;
let root: Root;

const categories = visibleCategories(false);
const advancedSlug = categories.find((c) => c.advanced)?.slug;
const plainSlug = categories.find((c) => !c.advanced)?.slug;

function mountRail(activeCategory: string): void {
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/settings/${activeCategory}`] },
        createElement(CategoryRail, {
          categories,
          activeCategory,
          dirtyCategories: [],
        }),
      ),
    );
  });
}

function advancedGroup(): HTMLElement {
  const el = container.querySelector<HTMLElement>('#settings-rail-advanced');
  if (!el) throw new Error('no advanced group rendered');
  return el;
}

function toggle(): void {
  const btn = container.querySelector<HTMLButtonElement>('.settings-rail-advanced-toggle');
  if (!btn) throw new Error('no advanced toggle rendered');
  act(() => {
    btn.click();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('CategoryRail — the active advanced row can never be hidden', () => {
  it('has both an advanced and a plain category to test with', () => {
    expect(advancedSlug).toBeDefined();
    expect(plainSlug).toBeDefined();
  });

  it('standing in an advanced category holds the group open through a toggle', () => {
    if (!advancedSlug) throw new Error('fixture: no advanced category');
    mountRail(advancedSlug);
    expect(advancedGroup().className).not.toContain('is-collapsed');

    // The old behaviour: this click collapsed the group and hid the active row.
    toggle();
    expect(advancedGroup().className).not.toContain('is-collapsed');
    expect(
      container.querySelector('.settings-rail-advanced-toggle')?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('still collapses normally when the active category is not advanced', () => {
    if (!plainSlug) throw new Error('fixture: no plain category');
    mountRail(plainSlug);
    expect(advancedGroup().className).toContain('is-collapsed');

    toggle();
    expect(advancedGroup().className).not.toContain('is-collapsed');
    toggle();
    expect(advancedGroup().className).toContain('is-collapsed');
  });
});
