import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from '@ethosagent/sqlite';
import type { FactInput, WorldSchema } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteWorldGraphProvider, worldGraphDbPath } from '../index';

const W = 'world:acme' as const;
const d = (day: number): string => `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z`;

const SCHEMA: WorldSchema = {
  version: 1,
  entities: {
    Person: { attrs: { location: { type: 'string' }, age: { type: 'int', min: 0, max: 150 } } },
    Service: { attrs: {} },
    Tool: { attrs: {} },
  },
  edges: {
    owns: { from: ['Person'], to: ['Service'], attrs: {} },
  },
};

describe('SQLiteWorldGraphProvider — facts', () => {
  let dir: string;
  let now: Date;
  let store: SQLiteWorldGraphProvider;

  const entity = (type: string, name: string): FactInput => ({
    kind: 'entity',
    type,
    name,
    sourceRef: 'test',
    author: 'user',
  });

  const rawDb = (): Database.Database => (store as unknown as { db: Database.Database }).db;

  async function addEntity(type: string, name: string): Promise<string> {
    const r = await store.assert(W, [entity(type, name)]);
    if (!r.ok) throw new Error(r.reason);
    return r.ids[0] as string;
  }

  async function addEdge(type: string, fromId: string, toId: string, validFrom?: string) {
    return store.assert(W, [
      {
        kind: 'edge',
        type,
        fromId,
        toId,
        ...(validFrom ? { validFrom } : {}),
        sourceRef: 'test',
        author: 'user',
        confidence: 1,
      },
    ]);
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'world-facts-'));
    now = new Date(d(1));
    store = new SQLiteWorldGraphProvider(worldGraphDbPath(dir), { now: () => now });
    await store.applySchema(W, SCHEMA);
  });
  afterEach(() => {
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('handover: close Priya owns billing on 20 Nov, open Ravi', async () => {
    const priya = await addEntity('Person', 'Priya');
    const ravi = await addEntity('Person', 'Ravi');
    const billing = await addEntity('Service', 'Billing');
    const first = await addEdge('owns', priya, billing);
    if (!first.ok) throw new Error(first.reason);
    now = new Date(d(20));
    const closed = await store.close(W, first.ids[0] as string, d(20), 'handover', 'user');
    expect(closed).toEqual({ ok: true, ids: [first.ids[0]] });
    const second = await addEdge('owns', ravi, billing, d(20));
    expect(second.ok).toBe(true);
    now = new Date(d(25));

    const owners = async (asOf: string): Promise<string[]> => {
      const facts = await store.query(
        W,
        { kind: 'edges', toId: billing, types: ['owns'], limit: 10 },
        { asOf },
      );
      return facts.edges.map((e) => e.fromId);
    };
    expect(await owners(d(19))).toEqual([priya]);
    expect(await owners(d(21))).toEqual([ravi]);

    const history = await store.history(W, billing);
    expect(history.edges.map((e) => e.fromId)).toEqual([priya, ravi]);
    // A second close of the same fact is refused.
    const again = await store.close(W, first.ids[0] as string, d(22), 'x', 'user');
    expect(again).toMatchObject({ ok: false, code: 'closed' });
  });

  it('knownAt: a fact recorded on 22 Nov is invisible with knownAt 21 Nov', async () => {
    const a = await addEntity('Person', 'Priya');
    const s = await addEntity('Service', 'Billing');
    now = new Date(d(22));
    const edge = await addEdge('owns', a, s);
    expect(edge.ok).toBe(true);
    now = new Date(d(23));
    const at = async (knownAt: string) =>
      (await store.query(W, { kind: 'edges', limit: 10 }, { asOf: d(23), knownAt })).edges.length;
    expect(await at(d(21))).toBe(0);
    expect(await at(d(22))).toBe(1);
  });

  it('retire of an entity id hides the entity from query, search, neighbours and edge endpoints, and names the retirer', async () => {
    const priya = await addEntity('Person', 'Priya');
    const billing = await addEntity('Service', 'Billing');
    const owns = await addEdge('owns', priya, billing);
    if (!owns.ok) throw new Error(owns.reason);
    now = new Date(d(10));
    expect(await store.retire(W, priya, 'schema:v2', 'agent')).toEqual({ ok: true, ids: [priya] });

    const row = rawDb().prepare('SELECT * FROM entities WHERE id = ?').get(priya) as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      retired_at: d(10),
      retired_by: 'agent',
      retired_source_ref: 'schema:v2',
    });

    const people = await store.query(W, { kind: 'entities', types: ['Person'], limit: 10 });
    expect(people.entities).toEqual([]);
    const byText = await store.query(W, { kind: 'entities', text: 'Priya', limit: 10 });
    expect(byText.entities).toEqual([]);
    const edges = await store.query(W, {
      kind: 'edges',
      toId: billing,
      includeClosed: true,
      limit: 10,
    });
    expect(edges.entities.map((e) => e.id)).toEqual([billing]);
    const around = await store.neighbours(W, priya, 2);
    expect(around).toMatchObject({ entities: [], edges: [], attributes: [] });
    // Before it was retired the entity was visible.
    const earlier = await store.query(
      W,
      { kind: 'entities', types: ['Person'], limit: 10 },
      { knownAt: d(9) },
    );
    expect(earlier.entities.map((e) => e.id)).toEqual([priya]);

    expect(await store.retire(W, priya, 'again', 'user')).toMatchObject({
      ok: false,
      code: 'closed',
    });
    expect(await store.retire(W, 'no-such-id', 'x', 'user')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    // getFact stays attributes and edges only.
    expect(await store.getFact(W, priya)).toBeNull();

    const changes = await store.changes(W, d(1), 50);
    expect(changes.find((c) => c.kind === 'retired' && c.factId === priya)).toMatchObject({
      sourceRef: 'schema:v2',
      author: 'agent',
      at: d(10),
    });
  });

  it('close of an entity id is refused with a typed result, not a throw', async () => {
    const priya = await addEntity('Person', 'Priya');
    const r = await store.close(W, priya, d(5), 'x', 'user');
    expect(r).toMatchObject({ ok: false, code: 'not_found' });
    expect(rawDb().prepare('SELECT retired_at FROM entities WHERE id = ?').get(priya)).toEqual({
      retired_at: null,
    });
  });

  it('retire of an entity in another world is not_found', async () => {
    const priya = await addEntity('Person', 'Priya');
    expect(await store.retire('world:other', priya, 'x', 'user')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('retire hides a fact from every slice after retired_at, history keeps it', async () => {
    const a = await addEntity('Person', 'Priya');
    const s = await addEntity('Service', 'Billing');
    const edge = await addEdge('owns', a, s);
    if (!edge.ok) throw new Error(edge.reason);
    now = new Date(d(10));
    expect(await store.retire(W, edge.ids[0] as string, 'oops', 'user')).toEqual({
      ok: true,
      ids: [edge.ids[0]],
    });
    const count = async (knownAt: string) =>
      (await store.query(W, { kind: 'edges', limit: 10 }, { asOf: d(12), knownAt })).edges.length;
    expect(await count(d(9))).toBe(1);
    expect(await count(d(11))).toBe(0);
    expect((await store.history(W, a)).edges).toHaveLength(1);
    // Retiring twice is refused.
    expect(await store.retire(W, edge.ids[0] as string, 'again', 'user')).toMatchObject({
      ok: false,
      code: 'closed',
    });
    // The change feed carries opened and retired.
    const kinds = (await store.changes(W, d(1), 50)).map((c) => c.kind);
    expect(kinds).toContain('retired');
    expect(kinds).toContain('opened');
  });

  it('close stores the closer, and changes names it for closed while opened keeps the original author', async () => {
    const priya = await addEntity('Person', 'Priya');
    const billing = await addEntity('Service', 'Billing');
    const edge = await addEdge('owns', priya, billing);
    if (!edge.ok) throw new Error(edge.reason);
    const id = edge.ids[0] as string;
    now = new Date(d(20));
    expect(await store.close(W, id, d(20), 'web:priya', 'agent')).toMatchObject({ ok: true });

    const row = (store as unknown as { db: import('@ethosagent/sqlite').default.Database }).db
      .prepare('SELECT closed_by, closed_source_ref, retired_by FROM edges WHERE id = ?')
      .get(id);
    expect(row).toMatchObject({
      closed_by: 'agent',
      closed_source_ref: 'web:priya',
      retired_by: null,
    });

    const changes = (await store.changes(W, d(1), 50)).filter((c) => c.factId === id);
    expect(changes.find((c) => c.kind === 'opened')).toMatchObject({
      author: 'user',
      sourceRef: 'test',
    });
    expect(changes.find((c) => c.kind === 'closed')).toMatchObject({
      author: 'agent',
      sourceRef: 'web:priya',
    });
  });

  it('retire stores the retirer, and changes names it for retired', async () => {
    const priya = await addEntity('Person', 'Priya');
    const billing = await addEntity('Service', 'Billing');
    const edge = await addEdge('owns', priya, billing);
    if (!edge.ok) throw new Error(edge.reason);
    const id = edge.ids[0] as string;
    now = new Date(d(10));
    expect(await store.retire(W, id, 'schema:v2', 'connector')).toMatchObject({ ok: true });

    const changes = (await store.changes(W, d(1), 50)).filter((c) => c.factId === id);
    expect(changes.find((c) => c.kind === 'opened')).toMatchObject({ author: 'user' });
    expect(changes.find((c) => c.kind === 'retired')).toMatchObject({
      author: 'connector',
      sourceRef: 'schema:v2',
    });
  });

  it('an attribute closed by another author is reported the same way', async () => {
    const priya = await addEntity('Person', 'Priya');
    const a = await store.assert(W, [
      {
        kind: 'attribute',
        entityId: priya,
        key: 'location',
        value: 'Pune',
        sourceRef: 'test',
        author: 'user',
        confidence: 1,
      },
    ]);
    if (!a.ok) throw new Error(a.reason);
    await store.close(W, a.ids[0] as string, d(5), 'feed:hr', 'connector');
    const closed = (await store.changes(W, d(1), 50)).find(
      (c) => c.factId === a.ids[0] && c.kind === 'closed',
    );
    expect(closed).toMatchObject({ author: 'connector', sourceRef: 'feed:hr' });
  });

  it('a fact imported already closed has no closer, so changes falls back to its own provenance', async () => {
    const priya = await addEntity('Person', 'Priya');
    const billing = await addEntity('Service', 'Billing');
    const bundle = await store.export(W);
    const target = new SQLiteWorldGraphProvider(worldGraphDbPath(join(dir, 'imp')), {
      now: () => now,
    });
    try {
      await target.import(W, {
        ...bundle,
        edges: [
          {
            id: 'r-0000000000000001',
            world: W,
            type: 'owns',
            fromId: priya,
            toId: billing,
            attrs: {},
            validFrom: null,
            validTo: d(9),
            recordedAt: d(2),
            retiredAt: null,
            sourceRef: 'csv:old',
            author: 'import',
            confidence: 1,
          },
        ],
      });
      const closed = (await target.changes(W, d(1), 50)).find(
        (c) => c.factId === 'r-0000000000000001' && c.kind === 'closed',
      );
      expect(closed).toMatchObject({ author: 'import', sourceRef: 'csv:old' });
    } finally {
      target.dispose();
    }
  });

  it('assert refuses an edge between types the schema does not allow', async () => {
    const tool = await addEntity('Tool', 'Wrench');
    const priya = await addEntity('Person', 'Priya');
    const bad = await addEdge('owns', tool, priya);
    expect(bad).toMatchObject({ ok: false, code: 'schema' });
    const unknownType = await store.assert(W, [entity('Ghost', 'Boo')]);
    expect(unknownType).toMatchObject({ ok: false, code: 'schema' });
    const missing = await addEdge('owns', priya, 'e-0000000000000000');
    expect(missing).toMatchObject({ ok: false, code: 'not_found' });
    const badAttr = await store.assert(W, [
      {
        kind: 'attribute',
        entityId: priya,
        key: 'age',
        value: 'old',
        sourceRef: 't',
        author: 'user',
        confidence: 1,
      },
    ]);
    expect(badAttr).toMatchObject({ ok: false, code: 'schema' });
    // A misfit in a batch writes nothing from that batch.
    const batch = await store.assert(W, [entity('Person', 'Zed'), entity('Ghost', 'Boo')]);
    expect(batch.ok).toBe(false);
    const people = await store.query(W, { kind: 'entities', types: ['Person'], limit: 10 });
    expect(people.entities.map((e) => e.name)).toEqual(['Priya']);
  });

  it('attribute change closes nothing by itself', async () => {
    const priya = await addEntity('Person', 'Priya');
    for (const [value, day] of [
      ['Pune', 5],
      ['Delhi', 6],
    ] as const) {
      now = new Date(d(day));
      const r = await store.assert(W, [
        {
          kind: 'attribute',
          entityId: priya,
          key: 'location',
          value,
          sourceRef: 't',
          author: 'user',
          confidence: 0.9,
        },
      ]);
      expect(r.ok).toBe(true);
    }
    now = new Date(d(7));
    const facts = await store.query(W, { kind: 'entities', types: ['Person'], limit: 10 });
    expect(facts.attributes.filter((a) => a.key === 'location').map((a) => a.value)).toEqual([
      'Pune',
      'Delhi',
    ]);
    expect(facts.attributes.every((a) => a.validTo === null)).toBe(true);
  });

  it('getFact returns a live attribute, a live edge, a closed edge and a retired attribute', async () => {
    const priya = await addEntity('Person', 'Priya');
    const billing = await addEntity('Service', 'Billing');
    const attr = await store.assert(W, [
      {
        kind: 'attribute',
        entityId: priya,
        key: 'location',
        value: 'Pune',
        sourceRef: 'test',
        author: 'user',
        confidence: 1,
      },
      {
        kind: 'attribute',
        entityId: priya,
        key: 'age',
        value: 30,
        sourceRef: 'test',
        author: 'user',
        confidence: 1,
      },
    ]);
    if (!attr.ok) throw new Error(attr.reason);
    const [locId, ageId] = attr.ids as [string, string];
    const live = await addEdge('owns', priya, billing);
    const closing = await addEdge('owns', priya, billing);
    if (!live.ok || !closing.ok) throw new Error('edge');
    await store.close(W, closing.ids[0] as string, d(5), 'handover', 'user');
    await store.retire(W, ageId, 'oops', 'user');

    expect(await store.getFact(W, locId)).toMatchObject({
      id: locId,
      key: 'location',
      value: 'Pune',
      validTo: null,
      retiredAt: null,
    });
    expect(await store.getFact(W, live.ids[0] as string)).toMatchObject({
      id: live.ids[0],
      type: 'owns',
      fromId: priya,
      toId: billing,
      validTo: null,
    });
    expect(await store.getFact(W, closing.ids[0] as string)).toMatchObject({
      id: closing.ids[0],
      validTo: d(5),
    });
    const retired = await store.getFact(W, ageId);
    expect(retired).toMatchObject({ id: ageId, key: 'age' });
    expect(retired?.retiredAt).not.toBeNull();
  });

  it('getFact is null for an unknown id and for an id from another world', async () => {
    const priya = await addEntity('Person', 'Priya');
    const billing = await addEntity('Service', 'Billing');
    const edge = await addEdge('owns', priya, billing);
    if (!edge.ok) throw new Error(edge.reason);
    expect(await store.getFact(W, 'r-missing')).toBeNull();
    expect(await store.getFact('world:other', edge.ids[0] as string)).toBeNull();
  });

  it('import then export round-trips and skips misfits', async () => {
    const priya = await addEntity('Person', 'Priya');
    const billing = await addEntity('Service', 'Billing');
    await addEdge('owns', priya, billing);
    const bundle = await store.export(W);
    const dir2 = mkdtempSync(join(tmpdir(), 'world-facts-copy-'));
    const target = new SQLiteWorldGraphProvider(worldGraphDbPath(dir2), { now: () => now });
    try {
      await target.applySchema(W, SCHEMA);
      const edge = bundle.edges[0];
      if (!edge) throw new Error('no edge exported');
      const report = await target.import(W, {
        ...bundle,
        edges: [...bundle.edges, { ...edge, id: 'r-bad', toId: 'e-missing' }],
      });
      expect(report.entities).toBe(2);
      expect(report.edges).toBe(1);
      expect(report.skipped).toHaveLength(1);
      // Importing the same bundle again changes nothing: ids are unique.
      const twice = await target.import(W, bundle);
      expect(twice.entities + twice.attributes + twice.edges).toBe(0);
      expect(twice.skipped).toHaveLength(3);
      const copy = await target.export(W);
      expect(copy.entities.map((e) => e.name)).toEqual(['Priya', 'Billing']);
    } finally {
      target.dispose();
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
