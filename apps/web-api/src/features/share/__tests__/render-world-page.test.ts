import type { WorldSnapshotWire } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { renderWorldPage } from '../render-world';

const XSS = '<script>fetch("/rpc/worlds/list")</script>';
const snap: WorldSnapshotWire = {
  v: 1,
  kind: 'world',
  world: 'world:acme',
  title: 'Acme <b>',
  view: 'graph',
  asOf: '2026-11-28T12:00:00.000Z',
  createdAt: '2026-11-28T12:00:00.000Z',
  groups: [
    {
      type: 'Person',
      entities: [
        {
          id: 'p1',
          name: `Ravi ${XSS}`,
          aliases: ['Rav'],
          attrs: [{ key: 'title', value: 'Engineer' }],
          links: [{ type: 'member_of', direction: 'out', otherId: 't1', otherName: 'Platform' }],
        },
      ],
    },
    {
      type: 'Team',
      entities: [{ id: 't1', name: 'Platform', aliases: [], attrs: [], links: [] }],
    },
  ],
  edges: [
    {
      type: 'member_of',
      fromId: 'p1',
      fromName: 'Ravi',
      toId: 't1',
      toName: 'Platform',
      attrs: [],
    },
  ],
  redacted: ['sensitive attributes', 'email', 'location'],
};

describe('renderWorldPage', () => {
  it('page renders the tree without scripts that call the API', () => {
    const html = renderWorldPage(snap, { nonce: 'N0nce', expiresAt: '2026-12-05T00:00:00.000Z' });
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;fetch(');
    // The markup itself (hostile text removed) carries no API call.
    const clean = renderWorldPage(
      { ...snap, groups: [{ type: 'Team', entities: [] }], edges: [] },
      { nonce: 'N0nce', expiresAt: '2026-12-05T00:00:00.000Z' },
    );
    expect(clean).not.toContain('fetch(');
    expect(clean).not.toContain('/rpc/');
    expect(html).not.toMatch(/<form|<input|<button|contenteditable/i);
    expect(html).toContain('Engineer');
    expect(html).toContain('Platform');
    expect(html).toContain('Acme &lt;b&gt;');
    // In-page anchors both ways: a table row target and a link to it.
    expect(html).toContain('id="e-p1"');
    expect(html).toContain('href="#e-t1"');
    expect(html).toContain('as of <span class="mono">2026-11-28</span>');
    expect(html).toContain('Removed: sensitive attributes, email, location');
    // Only the one nonce'd <style> is inline code.
    expect(html.match(/<style/g)).toHaveLength(1);
    expect(html).toContain('<style nonce="N0nce">');
  });
});
