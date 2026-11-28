import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EntityPage } from '../EntityPage';
import type { EntityDetail } from '../types';

const entity: EntityDetail = {
  id: 'e1',
  world: 'world:acme',
  type: 'Person',
  name: 'Ada',
  aliases: ['Countess'],
  retiredAt: null,
  facts: [
    {
      id: 'f1',
      key: 'role',
      value: 'engineer',
      validFrom: '2026-01-01',
      validTo: null,
      recordedAt: '2026-01-02T00:00:00Z',
      author: 'agent',
      sourceRef: 'chat:42',
      confidence: 0.7,
      promotable: true,
    },
    {
      id: 'f2',
      key: 'email',
      value: 'ada@example.com',
      validFrom: null,
      validTo: null,
      recordedAt: '2026-01-03T00:00:00Z',
      author: 'user',
      sourceRef: 'cli',
      confidence: 1,
      promotable: false,
    },
  ],
  edges: [
    {
      id: 'x1',
      type: 'member_of',
      direction: 'out',
      otherId: 't1',
      otherName: 'Platform',
      validFrom: '2026-02-01',
      validTo: null,
      author: 'import',
    },
  ],
  memoryMentions: [{ scope: 'personality:researcher', excerpt: 'Ada owns the retry work' }],
  mountedBy: [
    { personalityId: 'researcher', mode: 'propose', effective: 'read', note: 'private world' },
  ],
};

describe('entity page', () => {
  const html = renderToStaticMarkup(
    createElement(EntityPage, { entity, promoting: false, onOpen: () => {}, onPromote: () => {} }),
  );

  it('entity page shows author and source per fact', () => {
    expect(html).toContain('source chat:42');
    expect(html).toContain('by agent');
    expect(html).toContain('source cli');
    expect(html).toContain('by user');
    expect(html).toContain('2026-01-01 to now');
  });

  it('offers Make it yours only on promotable facts', () => {
    expect(html.match(/Make it yours/g)).toHaveLength(1);
  });

  it('lists memory notes, links and mounting personalities', () => {
    expect(html).toContain('Ada owns the retry work');
    expect(html).toContain('Platform');
    expect(html).toContain('inert: private world');
  });
});
