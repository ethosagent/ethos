import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConflictsInbox, conflictsFirst } from '../ConflictsInbox';
import type { Proposal } from '../types';

const proposal = (id: string, conflictWith: string | null): Proposal => ({
  id,
  world: 'world:acme',
  kind: 'assert',
  status: 'pending',
  summary: `summary ${id}`,
  conflictWith,
  sourceRef: 'chat:1',
  proposedBy: 'researcher',
  confidence: 0.8,
  createdAt: '2026-11-01T00:00:00Z',
  decidedAt: null,
  decidedBy: null,
  reason: null,
});

describe('conflicts inbox', () => {
  it('conflict proposals list first', () => {
    const input = [
      proposal('p1', null),
      proposal('p2', 'fact-9'),
      proposal('p3', null),
      proposal('p4', 'p1'),
    ];
    expect(conflictsFirst(input).map((p) => p.id)).toEqual(['p2', 'p4', 'p1', 'p3']);

    const html = renderToStaticMarkup(
      createElement(ConflictsInbox, { proposals: input, busy: false, onDecide: () => {} }),
    );
    expect(html.indexOf('summary p2')).toBeLessThan(html.indexOf('summary p1'));
    expect(html.indexOf('summary p4')).toBeLessThan(html.indexOf('summary p3'));
    expect(html).toContain('contradicts fact-9');
  });

  it('offers accept and reject per row and for a selection', () => {
    const html = renderToStaticMarkup(
      createElement(ConflictsInbox, {
        proposals: [proposal('p1', null)],
        busy: false,
        onDecide: () => {},
      }),
    );
    expect(html).toContain('Accept selected');
    expect(html).toContain('Reject selected');
    expect(html.match(/>Accept</g)).toHaveLength(1);
  });
});
