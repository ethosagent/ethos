// @vitest-environment jsdom

// Settings > Security > Shared links, and the Share… action's visibility
// (plan share-links.md Lane F1; mockup screens 3a-3c).

import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  button,
  click,
  FAKE_TOKEN,
  installShareHarness,
  link,
  listFn,
  mountNode,
  revokeFn,
  SharedLinksSection,
  text,
} from './share.fixtures';

installShareHarness();

// What the off note tells the operator to paste; the test pins it against the config dialect.
const CONFIG_SNIPPET = 'shareLinks.enabled: true\n# shareLinks.excludePersonalities: ops, legal';

const mountSection = () => mountNode(createElement(SharedLinksSection));
const rows = () => [...document.body.querySelectorAll<HTMLElement>('[data-link-id]')];

describe('Shared links list', () => {
  it('renders dense rows with ref, expiry, views and last viewed, and no URL or token', async () => {
    listFn.mockResolvedValue({
      enabled: true,
      links: [
        link('a1', { prefix: 'Qm9yZWRQ', title: 'Fix flaky retry test', viewCount: 3 }),
        link('b2', { prefix: 'zX9yW8vU', viewCount: 0, lastViewedAt: null }),
      ],
    });
    await mountSection();
    expect(rows().length).toBe(2);
    const first = rows()[0]?.textContent ?? '';
    expect(first).toContain('Fix flaky retry test');
    expect(first).toContain('ref Qm9yZWRQ');
    expect(first).toContain('expires 2026-12-03 14:20');
    expect(first).toContain('views 3');
    expect(first).toContain('last viewed 2026-11-27 09:02');
    expect(rows()[1]?.textContent).toContain('last viewed never');
    expect(document.body.querySelector('.share-section')?.textContent).not.toContain('/share/');
    expect(text()).not.toContain(FAKE_TOKEN);
    expect(text()).toContain('Active read-only snapshots. Revoking deletes the copy.');
    expect(text()).toContain('Full URLs are never shown here.');
  });

  it('marks a link expiring within the hour', async () => {
    const soon = new Date(Date.now() + 58 * 60_000).toISOString();
    listFn.mockResolvedValue({ enabled: true, links: [link('a1', { expiresAt: soon })] });
    await mountSection();
    expect(document.body.querySelector('.share-expsoon')?.textContent).toMatch(/\(in 5\d min\)/);
  });

  it('Revoke opens the inline confirm; Keep cancels without calling revoke', async () => {
    listFn.mockResolvedValue({ enabled: true, links: [link('a1', { prefix: 'a1B2c3D4' })] });
    await mountSection();
    await click(button('Revoke'));
    expect(text()).toContain(
      "Revoke a1B2c3D4? The copy is deleted and the URL returns 404 immediately. This can't be undone.",
    );
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await click(button('Keep'));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(button('Revoke')).toBeTruthy();
    expect(revokeFn).not.toHaveBeenCalled();
  });

  it('Revoke link calls shares.revoke with the id and refreshes the list', async () => {
    listFn.mockResolvedValueOnce({ enabled: true, links: [link('a1')] });
    listFn.mockResolvedValue({ enabled: true, links: [] });
    await mountSection();
    await click(button('Revoke'));
    await click(button('Revoke link'));
    expect(revokeFn).toHaveBeenCalledWith({ id: 'a1' });
    expect(listFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(rows().length).toBe(0);
    expect(text()).toContain('No shared links.');
  });

  it('reports a failed revoke and closes the confirm', async () => {
    listFn.mockResolvedValue({ enabled: true, links: [link('a1')] });
    revokeFn.mockResolvedValue({ ok: false, reason: 'not_found' });
    await mountSection();
    await click(button('Revoke'));
    await click(button('Revoke link'));
    expect(text()).toContain('That link is already gone.');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
});

describe('Shared links empty and off states', () => {
  it('shows the empty state with the CLI hint', async () => {
    await mountSection();
    expect(text()).toContain('No shared links. Open a session and choose Share…');
    expect(text()).toContain('ethos sessions share <id>');
  });

  it('shows only the off note and the flat config snippet when off with no links', async () => {
    listFn.mockResolvedValue({ enabled: false, links: [] });
    await mountSection();
    expect(text()).toContain('Share links are off.');
    expect(text()).toContain('Existing links return 404 while this is off.');
    expect(document.querySelector('.share-cfg')?.textContent).toBe(CONFIG_SNIPPET);
    expect(text()).toContain('Set in ~/.ethos/config.yaml.');
    expect(text()).not.toContain('restart');
    expect(rows().length).toBe(0);
  });

  it('keeps existing links listed and revocable below the off note (D14)', async () => {
    listFn.mockResolvedValue({ enabled: false, links: [link('a1', { prefix: 'a1B2c3D4' })] });
    await mountSection();
    expect(text()).toContain('Share links are off.');
    expect(rows().length).toBe(1);
    await click(button('Revoke'));
    expect(text()).toContain('Revoke a1B2c3D4?');
    await click(button('Revoke link'));
    expect(revokeFn).toHaveBeenCalledWith({ id: 'a1' });
  });

  it('shows the config snippet in the flat dialect that parseConfigYaml reads', async () => {
    // apps/web does not depend on @ethosagent/config, so the line grammar is
    // restated from SHARE_LINKS_LINE (packages/config/src/builders/share-links.ts).
    const SHARE_LINKS_LINE = /^shareLinks\.(enabled|excludePersonalities):\s*(.+)$/;
    listFn.mockResolvedValue({ enabled: false, links: [] });
    await mountSection();
    const shown = document.querySelector('.share-cfg')?.textContent ?? '';
    expect(shown).toBe(CONFIG_SNIPPET);
    const live = shown.split('\n').filter((l) => !l.startsWith('#'));
    expect(live).toEqual(['shareLinks.enabled: true']);
    expect(live.every((l) => SHARE_LINKS_LINE.test(l))).toBe(true);
    expect(shown).not.toMatch(/^shareLinks:/m);
  });

  it('labels the section and marks it self-saving', async () => {
    await mountSection();
    expect(document.getElementById('shared-links')?.textContent).toBe('shared links');
    expect(document.querySelector('.settings-self-save-marker')?.textContent).toBe(
      'saves on its own',
    );
  });
});
