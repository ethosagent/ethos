import type { AttributeFact, Edge, Entity, GraphBundle } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildWorldSnapshot, type WorldSnapshotOptions } from '../share-snapshot';

const W = 'world:acme' as const;
const T0 = '2026-11-01T00:00:00.000Z';
const NOW = '2026-11-28T12:00:00.000Z';

function ent(id: string, name: string, type = 'Person', over: Partial<Entity> = {}): Entity {
  return {
    id,
    world: W,
    type,
    name,
    aliases: [],
    recordedAt: T0,
    retiredAt: null,
    sourceRef: 't',
    author: 'user',
    mergedInto: null,
    ...over,
  };
}
function attr(
  id: string,
  entityId: string,
  key: string,
  value: unknown,
  over: Partial<AttributeFact> = {},
): AttributeFact {
  return {
    id,
    world: W,
    entityId,
    key,
    value,
    validFrom: null,
    validTo: null,
    recordedAt: T0,
    retiredAt: null,
    sourceRef: 't',
    author: 'user',
    confidence: 1,
    ...over,
  };
}
function edge(id: string, fromId: string, toId: string, over: Partial<Edge> = {}): Edge {
  return {
    id,
    world: W,
    type: 'member_of',
    fromId,
    toId,
    attrs: {},
    validFrom: null,
    validTo: null,
    recordedAt: T0,
    retiredAt: null,
    sourceRef: 't',
    author: 'user',
    confidence: 1,
    ...over,
  };
}

const opts = (over: Partial<WorldSnapshotOptions> = {}): WorldSnapshotOptions => ({
  world: W,
  title: 'Acme',
  view: 'tree',
  asOf: NOW,
  createdAt: NOW,
  sensitive: ['entity:Person.salary', 'edge:member_of.salary'],
  maxBytes: 1_000_000,
  ...over,
});

function bundle(): GraphBundle {
  return {
    schema: null,
    entities: [ent('p1', 'Ravi'), ent('t1', 'Platform', 'Team')],
    attributes: [
      attr('a1', 'p1', 'title', 'Engineer'),
      attr('a2', 'p1', 'salary', 190000),
      attr('a3', 'p1', 'email', 'ravi@example.com'),
      attr('a4', 'p1', 'work_location', 'Pune'),
      attr('a5', 'p1', 'note', 'call me on ravi@example.com or sk-ant-' + 'a'.repeat(95)),
    ],
    edges: [edge('e1', 'p1', 't1', { attrs: { salary: 1, role: 'lead' } })],
  };
}

const text = (s: unknown): string => JSON.stringify(s);

describe('buildWorldSnapshot', () => {
  it('snapshot strips sensitive and email fields', () => {
    const r = buildWorldSnapshot(bundle(), opts());
    if (!r.ok) throw new Error('too large');
    const json = text(r.snapshot);
    expect(json).toContain('Engineer');
    expect(json).not.toContain('190000');
    expect(json).not.toContain('Pune');
    expect(json).not.toContain('ravi@example.com');
    expect(json).not.toContain('sk-ant-aaaa');
    expect(json).not.toContain('"salary"');
    expect(r.snapshot.redacted).toEqual(['sensitive attributes', 'email', 'location']);
  });

  it('keeps email and location when the owner unticks them (secrets and PII still scrubbed)', () => {
    const r = buildWorldSnapshot(bundle(), opts({ keepEmail: true, keepLocation: true }));
    if (!r.ok) throw new Error('too large');
    const json = text(r.snapshot);
    expect(json).toContain('Pune');
    expect(json).not.toContain('190000');
    expect(json).not.toContain('ravi@example.com');
    expect(r.snapshot.redacted).toEqual(['sensitive attributes']);
  });

  it('snapshot is frozen: a later fact does not appear', () => {
    const b = bundle();
    const first = buildWorldSnapshot(b, opts());
    if (!first.ok) throw new Error('too large');
    const before = text(first.snapshot);
    b.attributes.push(
      attr('a9', 'p1', 'hobby', 'chess', { recordedAt: '2026-11-29T00:00:00.000Z' }),
    );
    b.entities.push(ent('p2', 'Later', 'Person', { recordedAt: '2026-11-29T00:00:00.000Z' }));
    expect(before).not.toContain('chess');
    const second = buildWorldSnapshot(b, opts());
    if (!second.ok) throw new Error('too large');
    expect(text(second.snapshot)).toBe(before);
    expect(text(second.snapshot)).not.toContain('Later');
  });

  it('respects asOf: a closed fact is absent', () => {
    const b = bundle();
    b.attributes.push(
      attr('a8', 'p1', 'team_lead', 'old', { validTo: '2026-06-01T00:00:00.000Z' }),
    );
    const r = buildWorldSnapshot(b, opts());
    if (!r.ok) throw new Error('too large');
    expect(text(r.snapshot)).not.toContain('team_lead');
  });

  it('graph view carries a relationships table, tree view does not', () => {
    const t = buildWorldSnapshot(bundle(), opts());
    const g = buildWorldSnapshot(bundle(), opts({ view: 'graph' }));
    if (!t.ok || !g.ok) throw new Error('too large');
    expect(t.snapshot.edges).toBeUndefined();
    expect(g.snapshot.edges?.[0]).toMatchObject({
      type: 'member_of',
      fromName: 'Ravi',
      toName: 'Platform',
    });
    expect(text(g.snapshot.edges)).not.toContain('"salary"');
    expect(text(g.snapshot.edges)).toContain('lead');
  });

  it('refuses above the byte cap', () => {
    const r = buildWorldSnapshot(bundle(), opts({ maxBytes: 100 }));
    expect(r).toEqual({ ok: false, reason: 'too_large', limitBytes: 100 });
  });
});
