import { describe, expect, it } from 'vitest';
import {
  addEntityType,
  removeEntityType,
  schemaToYaml,
  setEdgeType,
  setEntityAttr,
} from '../schema-form';
import { parseSlugList } from '../settings-form';
import type { GraphEdge, GraphNode, WorldSchemaParsed } from '../types';
import {
  buildElements,
  chooseDefaultView,
  dateBounds,
  opensOnSearch,
  searchNodes,
  typeColorToken,
  visibleEdges,
} from '../world-logic';

const schema = (edgeTypes: string[]): WorldSchemaParsed => ({
  version: 1,
  entities: { Person: { attrs: {} }, Team: { attrs: {} } },
  edges: Object.fromEntries(
    edgeTypes.map((t) => [t, { from: ['Person'], to: ['Team'], attrs: {} }]),
  ),
});

const edge = (id: string, validFrom: string | null, validTo: string | null): GraphEdge => ({
  id,
  type: 'works_with',
  from: 'a',
  to: 'b',
  validFrom,
  validTo,
  author: 'user',
});

describe('world view rules', () => {
  it('tree is chosen when the schema has member_of', () => {
    expect(chooseDefaultView(schema(['member_of']))).toBe('tree');
    expect(chooseDefaultView(schema(['part_of']))).toBe('tree');
    expect(chooseDefaultView(schema(['works_with']))).toBe('graph');
    expect(chooseDefaultView(null)).toBe('graph');
  });

  it('date slider hides links closed before it', () => {
    const edges = [
      edge('open', '2026-01-01', null),
      edge('closed', '2026-01-01', '2026-03-01'),
      edge('future', '2026-09-01', null),
    ];
    const at = (asOf: string, showEnded: boolean) =>
      visibleEdges(edges, asOf, showEnded, '2026-11-28').map(
        (v) => `${v.edge.id}${v.ended ? '*' : ''}`,
      );
    expect(at('2026-06-01', false)).toEqual(['open']);
    expect(at('2026-06-01', true)).toEqual(['open', 'closed*']);
    expect(at('2026-02-01', false)).toEqual(['open', 'closed']);
    expect(at('2026-10-01', false)).toEqual(['open', 'future']);
  });

  it('large world opens on search', () => {
    expect(opensOnSearch(500)).toBe(false);
    expect(opensOnSearch(501)).toBe(true);
  });
});

describe('graph elements', () => {
  const node = (id: string, type: string, name = id): GraphNode => ({
    id,
    type,
    name,
    isNew: false,
  });

  it('drops edges whose endpoint is filtered out and marks ended ones', () => {
    const nodes = [node('a', 'Person'), node('b', 'Team')];
    const edges = visibleEdges([edge('e1', null, '2026-01-01')], null, true, '2026-11-28');
    const all = buildElements(nodes, edges);
    expect(all.edges).toEqual([
      { data: { id: 'e1', source: 'a', target: 'b', label: 'works_with' }, classes: 'ended' },
    ]);
    expect(buildElements(nodes, edges, new Set(['Team'])).edges).toEqual([]);
  });

  it('maps types onto DESIGN.md tokens only', () => {
    expect(typeColorToken('Team', ['Person', 'Team'])).toBe('--success');
    expect(typeColorToken('Person', ['Person', 'Team'])).toBe('--info');
  });

  it('builds 2000 nodes quickly', () => {
    const nodes = Array.from({ length: 2000 }, (_, i) => node(`n${i}`, i % 2 ? 'Person' : 'Team'));
    const raw: GraphEdge[] = Array.from({ length: 4000 }, (_, i) => ({
      ...edge(`e${i}`, '2026-01-01', null),
      from: `n${i % 2000}`,
      to: `n${(i * 7) % 2000}`,
    }));
    const t0 = performance.now();
    const out = buildElements(nodes, visibleEdges(raw, null, false, '2026-11-28'));
    expect(out.nodes).toHaveLength(2000);
    expect(out.edges).toHaveLength(4000);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('bounds the slider by the earliest dated edge', () => {
    expect(
      dateBounds([edge('a', '2026-03-05T10:00:00Z', null), edge('b', null, null)], '2026-11-28'),
    ).toEqual({
      min: '2026-03-05',
      max: '2026-11-28',
    });
    expect(dateBounds([edge('b', null, null)], '2026-11-28')).toBeNull();
  });

  it('searches names case-insensitively', () => {
    const hits = searchNodes(
      [node('1', 'Person', 'Ada Lovelace'), node('2', 'Person', 'Bob')],
      'ada',
    );
    expect(hits.map((h) => h.id)).toEqual(['1']);
    expect(searchNodes([node('1', 'Person', 'Ada')], '  ')).toEqual([]);
  });
});

describe('schema form', () => {
  it('only links existing types and drops links to removed ones', () => {
    const s = schema([]);
    expect(setEdgeType(s, 'member_of', ['Person'], ['Ghost'])).toBe(s);
    const linked = setEdgeType(s, 'member_of', ['Person'], ['Team']);
    expect(Object.keys(linked.edges)).toEqual(['member_of']);
    expect(removeEntityType(linked, 'Team').edges).toEqual({});
    expect(addEntityType(s, '1bad')).toBe(s);
  });

  it('serialises to text the server parser reads back, bumping version and changelog', () => {
    const draft = setEntityAttr(schema(['member_of']), 'Person', 'email', 'string');
    const yaml = schemaToYaml({
      draft,
      sensitive: ['entity:Person.email'],
      changelog: [{ v: 1, by: 'user', at: '2026-01-01T00:00:00Z', change: 'created' }],
      currentVersion: 1,
      by: 'owner',
      at: '2026-11-28T00:00:00Z',
      change: 'added email',
    });
    const doc = JSON.parse(yaml);
    expect(doc.version).toBe(2);
    expect(doc.entities.Person.attrs.email).toEqual({ type: 'string', sensitive: true });
    expect(doc.changelog.map((c: { v: number }) => c.v)).toEqual([1, 2]);
  });

  it('parses slug lists and reports what is not a slug', () => {
    expect(parseSlugList('ops, legal  ops')).toEqual({ slugs: ['ops', 'legal'], invalid: [] });
    expect(parseSlugList('ops, Bad Name').invalid).toEqual(['Bad', 'Name']);
  });
});
