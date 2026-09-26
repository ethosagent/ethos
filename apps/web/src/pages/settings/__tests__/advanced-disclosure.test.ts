// B6 (plan ux-feedback-and-config-clarity §6.4) — the rail's Advanced
// disclosure COLLAPSES with a CSS class and never unmounts. History: an
// earlier toggle unmounted advanced controls and rendered two whole
// categories empty (components/advanced.tsx tells it) — so the pinned facts
// here are (1) the advanced rows are IN THE MARKUP whatever the disclosure
// says, (2) the dirty machinery still counts a change in a hidden category:
// the save bar reports it and the collapsed toggle carries the unsaved dot.
//
// `renderToStaticMarkup`, same precedent as `settings-advanced-dims.test.ts`
// — `apps/web` has no jsdom and this file must not add one.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CategoryRail } from '../CategoryRail';
import type { DirtyState } from '../lib/settings-dirty';
import { SETTINGS_CATEGORIES, visibleCategories } from '../lib/taxonomy';
import { SaveBar } from '../SaveBar';

const WEB_CATEGORIES = visibleCategories(false);
const ADVANCED = WEB_CATEGORIES.filter((c) => c.advanced);
const BASIC = WEB_CATEGORIES.filter((c) => !c.advanced);

function rail(props: { activeCategory: string; dirtyCategories?: string[] }): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(CategoryRail, {
        categories: WEB_CATEGORIES,
        activeCategory: props.activeCategory,
        dirtyCategories: props.dirtyCategories ?? [],
      }),
    ),
  );
}

describe('taxonomy advanced flags', () => {
  it('marks the operator categories and only them', () => {
    const flagged = SETTINGS_CATEGORIES.filter((c) => c.advanced).map((c) => c.slug);
    // The plan names nine including `plugins`, but the taxonomy has no
    // plugins category — the eight that exist are pinned here.
    expect(flagged.sort()).toEqual(
      ['automation', 'backup', 'data', 'desktop', 'developer', 'execution', 'jobs', 'voice'].sort(),
    );
    for (const slug of ['general', 'models', 'memory', 'chat', 'security', 'keys']) {
      expect(flagged).not.toContain(slug);
    }
  });
});

describe('CategoryRail advanced disclosure', () => {
  it('collapsed: every advanced row is still MOUNTED (in the markup), only hidden by class', () => {
    const html = rail({ activeCategory: 'general' });
    expect(html).toContain('is-collapsed');
    for (const category of ADVANCED) {
      expect(html).toContain(`/settings/${category.slug}/`);
    }
    // The toggle names the count of visible advanced categories.
    expect(html).toContain(`Advanced (${ADVANCED.length})`);
    expect(html).toContain('show operator settings');
  });

  it('keeps the basic categories out of the disclosure', () => {
    const html = rail({ activeCategory: 'general' });
    const advancedBlock = html.slice(html.indexOf('settings-rail-advanced'));
    for (const category of BASIC) {
      expect(advancedBlock).not.toContain(`>${category.label}<`);
    }
  });

  it('standing in an advanced category holds the disclosure open', () => {
    const html = rail({ activeCategory: 'jobs' });
    expect(html).not.toContain('is-collapsed');
    expect(html).toContain('hide operator settings');
  });

  it('a dirty field in a hidden advanced category still shows: dot on the toggle', () => {
    const html = rail({ activeCategory: 'general', dirtyCategories: ['jobs'] });
    expect(html).toContain('unsaved changes in a hidden category');
  });

  it('no dot on the toggle when the dirty category is a visible basic one', () => {
    const html = rail({ activeCategory: 'general', dirtyCategories: ['memory'] });
    expect(html).not.toContain('unsaved changes in a hidden category');
  });
});

describe('SaveBar counts hidden dirty fields', () => {
  it('reports a change held by a collapsed advanced category', () => {
    const dirty: DirtyState = { count: 1, categories: ['jobs'] };
    const html = renderToStaticMarkup(
      createElement(SaveBar, {
        loading: false,
        onSave: () => {},
        dirty,
        categories: WEB_CATEGORIES,
      }),
    );
    expect(html).toContain('1');
    expect(html).toContain(' change');
    expect(html).toContain('Background jobs');
  });
});

describe('SaveBar parse warnings (B2)', () => {
  it('renders `N unknown keys kept · view` for unknown-key lines', () => {
    const html = renderToStaticMarkup(
      createElement(SaveBar, {
        loading: false,
        onSave: () => {},
        dirty: { count: 0, categories: [] },
        categories: WEB_CATEGORIES,
        warnings: ["config.yaml:5 unknown key 'personalty' — did you mean 'personality'?"],
      }),
    );
    expect(html).toContain('1 unknown key kept');
    expect(html).toContain('view');
  });

  it('renders nothing when the parse raised no warnings', () => {
    const html = renderToStaticMarkup(
      createElement(SaveBar, {
        loading: false,
        onSave: () => {},
        dirty: { count: 0, categories: [] },
        categories: WEB_CATEGORIES,
        warnings: [],
      }),
    );
    expect(html).not.toContain('unknown key');
  });
});
