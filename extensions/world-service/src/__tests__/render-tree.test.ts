import type { Edge, Entity, GraphBundle, WorldId } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { renderTree } from '../render-tree';

const world: WorldId = 'world:acme';
const base = { world, recordedAt: '2026-11-01T00:00:00Z', retiredAt: null, sourceRef: 't' };

const ent = (id: string, type: string, name: string, extra: Partial<Entity> = {}): Entity => ({
  ...base,
  id,
  type,
  name,
  aliases: [],
  author: 'user',
  mergedInto: null,
  ...extra,
});
const edge = (id: string, type: string, fromId: string, toId: string, extra: Partial<Edge> = {}) =>
  ({
    ...base,
    id,
    type,
    fromId,
    toId,
    attrs: {},
    validFrom: null,
    validTo: null,
    author: 'user',
    confidence: 1,
    ...extra,
  }) satisfies Edge;

const bundle = (entities: Entity[], edges: Edge[]): GraphBundle => ({
  schema: null,
  entities,
  attributes: [],
  edges,
});

const ORG = bundle(
  [
    ent('c', 'Company', 'Acme'),
    ent('t2', 'Team', 'Platform'),
    ent('t1', 'Team', 'Growth'),
    ent('p1', 'Person', 'Mei'),
    ent('p2', 'Person', 'Tom'),
    ent('s', 'Skill', 'Go'),
  ],
  [
    edge('e1', 'part_of', 't2', 'c'),
    edge('e2', 'part_of', 't1', 'c'),
    edge('e3', 'member_of', 'p1', 't2', { attrs: { role: 'lead' } }),
    edge('e4', 'member_of', 'p2', 't1'),
  ],
);

describe('renderTree', () => {
  it('draws company, teams, people sorted by name, with the role and the leftovers', () => {
    expect(renderTree(ORG)).toBe(
      [
        'Acme (Company)',
        '|- Growth (Team)',
        '|  `- Tom (Person)',
        '`- Platform (Team)',
        '   `- Mei (Person) - lead',
        '',
        'Not in the tree:',
        '  Skill: Go',
      ].join('\n'),
    );
  });

  it('renderTree is deterministic: input order does not change the text', () => {
    const shuffled = bundle([...ORG.entities].reverse(), [...ORG.edges].reverse());
    expect(renderTree(shuffled)).toBe(renderTree(ORG));
  });

  it('draws the subtree of one entity, by name ignoring case', () => {
    expect(renderTree(ORG, { entity: 'platform' })).toBe(
      ['Platform (Team)', '`- Mei (Person) - lead'].join('\n'),
    );
    expect(renderTree(ORG, { entity: 'ghost' })).toBe('(no entity ghost)');
  });

  it('ignores closed, retired and merged rows', () => {
    const b = bundle(
      [...ORG.entities, ent('old', 'Person', 'Gone', { retiredAt: '2026-11-02T00:00:00Z' })],
      [
        ...ORG.edges,
        edge('e5', 'member_of', 'old', 't1'),
        edge('e6', 'member_of', 'p2', 't2', { validTo: '2026-01-01' }),
      ],
    );
    expect(renderTree(b)).toBe(renderTree(ORG));
  });

  it('survives a cycle and an empty world', () => {
    const cyc = bundle(
      [ent('a', 'Team', 'A'), ent('b', 'Team', 'B')],
      [edge('e1', 'part_of', 'a', 'b'), edge('e2', 'part_of', 'b', 'a')],
    );
    expect(renderTree(cyc)).toContain('A (Team)');
    expect(renderTree(bundle([], []))).toBe('(empty)');
  });

  it('cuts at maxLines with a count', () => {
    expect(renderTree(ORG, { maxLines: 2 }).split('\n')).toEqual([
      'Acme (Company)',
      '|- Growth (Team)',
      expect.stringMatching(/^\.\.\. \d+ more lines$/),
    ]);
  });
});
