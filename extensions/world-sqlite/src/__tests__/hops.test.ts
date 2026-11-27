import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FactInput } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteWorldGraphProvider, worldGraphDbPath } from '../index';

const W = 'world:acme' as const;
const d = (day: number): string => `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z`;

describe('SQLiteWorldGraphProvider — hops and paths', () => {
  let dir: string;
  let now: Date;
  let store: SQLiteWorldGraphProvider;
  const ids = new Map<string, string>();

  async function ent(type: string, name: string): Promise<string> {
    const r = await store.assert(W, [
      { kind: 'entity', type, name, sourceRef: 't', author: 'user' },
    ]);
    if (!r.ok) throw new Error(r.reason);
    const id = r.ids[0] as string;
    ids.set(name, id);
    return id;
  }
  const id = (name: string): string => {
    const v = ids.get(name);
    if (!v) throw new Error(`no entity ${name}`);
    return v;
  };
  async function edge(type: string, from: string, to: string, validFrom?: string): Promise<string> {
    const f: FactInput = {
      kind: 'edge',
      type,
      fromId: id(from),
      toId: id(to),
      ...(validFrom ? { validFrom } : {}),
      sourceRef: 't',
      author: 'user',
      confidence: 1,
    };
    const r = await store.assert(W, [f]);
    if (!r.ok) throw new Error(r.reason);
    return r.ids[0] as string;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'world-hops-'));
    now = new Date(d(1));
    ids.clear();
    store = new SQLiteWorldGraphProvider(worldGraphDbPath(dir), { now: () => now });
  });
  afterEach(() => {
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('2 hops from Payments reaches Ravi and Kafka, not past', async () => {
    for (const [t, n] of [
      ['Service', 'Payments'],
      ['Team', 'Platform'],
      ['Person', 'Ravi'],
      ['Service', 'Queue'],
      ['Service', 'Kafka'],
      ['Vendor', 'AWS'],
      ['Region', 'ap-south-1'],
    ] as const) {
      await ent(t, n);
    }
    await edge('owns', 'Platform', 'Payments');
    await edge('member_of', 'Ravi', 'Platform');
    await edge('uses', 'Payments', 'Queue');
    await edge('runs_on', 'Queue', 'Kafka');
    await edge('hosted_by', 'Kafka', 'AWS');
    await edge('located_in', 'AWS', 'ap-south-1');

    const two = await store.neighbours(W, id('Payments'), 2);
    const names = two.entities.map((e) => e.name);
    expect(names).toContain('Ravi');
    expect(names).toContain('Kafka');
    expect(names).not.toContain('AWS');
    expect(two.centre).toBe(id('Payments'));
    expect(two.hops).toBe(2);

    // The cap is capabilities().maxHops = 3, whatever the caller asks.
    const many = await store.neighbours(W, id('Payments'), 10);
    expect(many.hops).toBe(3);
    const manyNames = many.entities.map((e) => e.name);
    expect(manyNames).toContain('AWS');
    expect(manyNames).not.toContain('ap-south-1');
  });

  it('cycle reports_to A→B→A ends', async () => {
    await ent('Person', 'A');
    await ent('Person', 'B');
    await edge('reports_to', 'A', 'B');
    await edge('reports_to', 'B', 'A');
    const g = await store.neighbours(W, id('A'), 3);
    expect(g.entities.map((e) => e.name).sort()).toEqual(['A', 'B']);
    expect(g.edges).toHaveLength(2);
  });

  it('paths: FABR -supplies-> NVX -supplies-> SKYC, toType Stock, maxHops 3', async () => {
    for (const n of ['FABR', 'NVX', 'SKYC']) await ent('Stock', n);
    await ent('Person', 'Ravi');
    await edge('supplies', 'FABR', 'NVX');
    await edge('supplies', 'NVX', 'SKYC');
    await edge('follows', 'FABR', 'Ravi'); // not a `via` type
    const r = await store.query(W, {
      kind: 'paths',
      fromId: id('FABR'),
      via: ['supplies'],
      toType: 'Stock',
      maxHops: 3,
      limit: 10,
    });
    expect(r.paths).toEqual([
      [id('FABR'), id('NVX')],
      [id('FABR'), id('NVX'), id('SKYC')],
    ]);
    expect(r.entities.map((e) => e.name).sort()).toEqual(['FABR', 'NVX', 'SKYC']);
    expect(r.truncated).toBe(false);
    // maxHops 1 stops at NVX; limit truncates.
    const one = await store.query(W, {
      kind: 'paths',
      fromId: id('FABR'),
      via: ['supplies'],
      maxHops: 1,
      limit: 10,
    });
    expect(one.paths).toEqual([[id('FABR'), id('NVX')]]);
    const cut = await store.query(W, {
      kind: 'paths',
      fromId: id('FABR'),
      via: ['supplies'],
      maxHops: 3,
      limit: 1,
    });
    expect(cut.paths).toHaveLength(1);
    expect(cut.truncated).toBe(true);
  });

  it('closed edges are not walked as of a later date', async () => {
    await ent('Person', 'Priya');
    await ent('Service', 'Billing');
    const e = await edge('owns', 'Priya', 'Billing');
    now = new Date(d(20));
    await store.close(W, e, d(20), 't', 'user');
    now = new Date(d(25));
    const before = await store.neighbours(W, id('Billing'), 1, { asOf: d(19) });
    expect(before.entities.map((x) => x.name).sort()).toEqual(['Billing', 'Priya']);
    const after = await store.neighbours(W, id('Billing'), 1, { asOf: d(21) });
    expect(after.entities.map((x) => x.name)).toEqual(['Billing']);
    const pathAfter = await store.query(
      W,
      { kind: 'paths', fromId: id('Priya'), via: ['owns'], maxHops: 2, limit: 5 },
      { asOf: d(21) },
    );
    expect(pathAfter.paths).toEqual([]);
  });

  // Skipped when CI_SLOW is set (slow shared runners make wall-clock bounds flaky).
  it.skipIf(process.env.CI_SLOW)(
    'hop query on 5k entities / 20k edges returns in < 50 ms',
    async () => {
      const N = 5000;
      const E = 20000;
      const raw = (store as unknown as { db: import('@ethosagent/sqlite').default.Database }).db;
      const T = d(1);
      raw.transaction(() => {
        const ie = raw.prepare(
          `INSERT INTO entities (id, world, type, name, recorded_at, source_ref, author)
         VALUES (?, ?, 'Node', ?, ?, 't', 'user')`,
        );
        for (let i = 0; i < N; i++) ie.run(`e-${i}`, W, `n${i}`, T);
        const ir = raw.prepare(
          `INSERT INTO edges (id, world, type, from_id, to_id, recorded_at, source_ref, author, confidence)
         VALUES (?, ?, 'link', ?, ?, ?, 't', 'user', 1)`,
        );
        // Deterministic pseudo-random wiring (mulberry32); average degree 8.
        let x = 12345;
        const next = (): number => {
          x = (x + 0x6d2b79f5) | 0;
          let t = Math.imul(x ^ (x >>> 15), 1 | x);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return (t ^ (t >>> 14)) >>> 0;
        };
        for (let i = 0; i < E; i++) ir.run(`r-${i}`, W, `e-${next() % N}`, `e-${next() % N}`, T);
      })();
      now = new Date(d(2));
      await store.neighbours(W, 'e-0', 3); // warm the statement cache
      const t0 = performance.now();
      const g = await store.neighbours(W, 'e-0', 3);
      const ms = performance.now() - t0;
      expect(g.entities.length).toBeGreaterThan(1);
      expect(ms).toBeLessThan(50);
    },
  );
});
