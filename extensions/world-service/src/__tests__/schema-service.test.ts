import type Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSchemaYaml } from '../schema-model';
import { type Harness, harness } from './schema-harness';

const W = 'world:acme' as const;
const ME = { kind: 'user', id: 'me' } as const;

describe('WorldSchemaService', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
    await h.seed(W);
  });
  afterEach(() => h.dispose());

  it('the schema path is worlds/<slug>/schema.yaml, private worlds under worlds/.private/<pid>', async () => {
    const { worldSchemaPath } = await import('../schema-service');
    expect(worldSchemaPath('/d', 'world:acme')).toBe('/d/worlds/acme/schema.yaml');
    expect(worldSchemaPath('/d', 'personality:eng')).toBe('/d/worlds/.private/eng/schema.yaml');
  });

  it('apply writes schema.yaml only through the injected Storage.writeAtomic and tells the provider', async () => {
    const r = await h.service.apply(
      W,
      { op: 'add_entity_type', type: 'Vendor' },
      ME,
      'new supplier map',
    );
    expect(r).toEqual({ ok: true, version: 2 });
    expect(h.storage.atomicWrites).toEqual([h.path(W)]);
    const parsed = parseSchemaYaml(h.storage.files.get(h.path(W)) ?? '');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.schema.version).toBe(2);
    expect(parsed.schema.entities.Vendor).toBeDefined();
    expect(parsed.changelog[0]).toMatchObject({ v: 2, by: 'you', reason: 'new supplier map' });
    expect((await h.provider.getSchema(W))?.version).toBe(2);
  });

  it('rename retires and re-asserts with the same valid_from', async () => {
    const ravi = h.provider.seedEntity(W, 'Person', 'Ravi');
    const pay = h.provider.seedEntity(W, 'Team', 'Payments');
    const edge = h.provider.seedEdge(W, 'member_of', ravi.id, pay.id, {
      validFrom: '2025-03-01',
      attrs: { role: 'lead' },
      author: 'user',
    });

    const r = await h.service.apply(
      W,
      { op: 'rename_type', kind: 'edge', from: 'member_of', to: 'belongs_to' },
      ME,
      'clearer',
    );
    expect(r).toEqual({ ok: true, version: 2 });

    const held = h.provider.all(W);
    const old = held.edges.find((e) => e.id === edge.id);
    expect(old?.retiredAt).not.toBeNull(); // history keeps the old row
    const reopened = held.edges.find((e) => e.type === 'belongs_to');
    expect(reopened).toMatchObject({
      fromId: ravi.id,
      toId: pay.id,
      validFrom: '2025-03-01',
      attrs: { role: 'lead' },
      author: 'user',
      sourceRef: 'schema:v2',
      retiredAt: null,
    });
    const schema = await h.provider.getSchema(W);
    expect(schema?.edges.belongs_to).toBeDefined();
    expect(schema?.edges.member_of).toBeUndefined();
  });

  it('rename of an entity type moves its attributes and edges to the new entity, same valid_from', async () => {
    const ravi = h.provider.seedEntity(W, 'Person', 'Ravi');
    const go = h.provider.seedEntity(W, 'Skill', 'Go');
    h.provider.seedAttribute(W, ravi.id, 'email', 'r@acme.test', { validFrom: '2024-01-01' });
    h.provider.seedEdge(W, 'expert_in', ravi.id, go.id, { validFrom: '2025-06-01' });

    const r = await h.service.apply(
      W,
      { op: 'rename_type', kind: 'entity', from: 'Person', to: 'Human' },
      ME,
      'naming',
    );
    expect(r).toEqual({ ok: true, version: 2 });

    const held = h.provider.all(W);
    const human = held.entities.find((e) => e.type === 'Human' && e.name === 'Ravi');
    expect(human).toBeDefined();
    const liveAttrs = held.attributes.filter((a) => a.retiredAt === null);
    expect(liveAttrs).toHaveLength(1);
    expect(liveAttrs[0]).toMatchObject({
      entityId: human?.id,
      key: 'email',
      validFrom: '2024-01-01',
    });
    const liveEdges = held.edges.filter((e) => e.retiredAt === null);
    expect(liveEdges).toHaveLength(1);
    expect(liveEdges[0]).toMatchObject({ fromId: human?.id, validFrom: '2025-06-01' });
    const schema = await h.provider.getSchema(W);
    expect(schema?.entities.Human).toBeDefined();
    expect(schema?.entities.Person).toBeUndefined();
    expect(schema?.edges.expert_in?.from).toEqual(['Human']);
  });

  it('entity rename leaves no entity under the removed type in query, text search or neighbours', async () => {
    const ravi = h.provider.seedEntity(W, 'Person', 'Ravi');
    const go = h.provider.seedEntity(W, 'Skill', 'Go');
    h.provider.seedAttribute(W, ravi.id, 'email', 'r@acme.test', { validFrom: '2024-01-01' });
    h.provider.seedEdge(W, 'expert_in', ravi.id, go.id, { validFrom: '2025-06-01' });
    const r = await h.service.apply(
      W,
      { op: 'rename_type', kind: 'entity', from: 'Person', to: 'Human' },
      ME,
      'naming',
    );
    expect(r).toEqual({ ok: true, version: 2 });

    const byType = await h.provider.query(W, { kind: 'entities', types: ['Person'], limit: 50 });
    expect(byType.entities).toEqual([]);
    const byText = await h.provider.query(W, { kind: 'entities', text: 'Ravi', limit: 50 });
    expect(byText.entities.map((e) => e.type)).toEqual(['Human']);
    const human = byText.entities[0];
    expect(byText.attributes).toMatchObject([{ entityId: human?.id, key: 'email' }]);
    const around = await h.provider.neighbours(W, human?.id as string, 1);
    expect(around.entities.map((e) => e.type).sort()).toEqual(['Human', 'Skill']);
    expect(around.edges).toHaveLength(1);
    const oldAround = await h.provider.neighbours(W, ravi.id, 1);
    expect(oldAround.entities).toEqual([]);
    // The old row is retired by the schema change, with the entity's own author.
    expect(h.provider.all(W).entities.find((e) => e.id === ravi.id)?.retiredAt).not.toBeNull();
    expect(h.provider.closures).toContainEqual(
      expect.objectContaining({
        kind: 'retired',
        factId: ravi.id,
        sourceRef: 'schema:v2',
        author: 'user',
      }),
    );
  });

  it('entity merge leaves no entity under the merged-away type in query, text search or neighbours', async () => {
    const go = h.provider.seedEntity(W, 'Skill', 'Go');
    const ravi = h.provider.seedEntity(W, 'Person', 'Ravi');
    h.provider.seedEdge(W, 'expert_in', ravi.id, go.id, { validFrom: '2025-06-01' });
    const r = await h.service.apply(
      W,
      { op: 'merge_types', kind: 'entity', from: 'Skill', into: 'Team' },
      ME,
      'fewer types',
    );
    expect(r).toEqual({ ok: true, version: 2 });

    const byType = await h.provider.query(W, { kind: 'entities', types: ['Skill'], limit: 50 });
    expect(byType.entities).toEqual([]);
    const byText = await h.provider.query(W, { kind: 'entities', text: 'Go', limit: 50 });
    expect(byText.entities.map((e) => e.type)).toEqual(['Team']);
    const around = await h.provider.neighbours(W, ravi.id, 1);
    expect(around.entities.map((e) => e.type).sort()).toEqual(['Person', 'Team']);
    expect((await h.provider.neighbours(W, go.id, 1)).entities).toEqual([]);
    expect(h.provider.all(W).entities.find((e) => e.id === go.id)?.retiredAt).not.toBeNull();
  });

  it('rename of an attribute keeps its valid_from', async () => {
    const t = h.provider.seedEntity(W, 'Team', 'Payments');
    h.provider.seedAttribute(W, t.id, 'mission', 'move money', { validFrom: '2025-01-01' });
    const r = await h.service.apply(
      W,
      { op: 'rename_attribute', on: { entity: 'Team' }, from: 'mission', to: 'purpose' },
      ME,
      'wording',
    );
    expect(r).toEqual({ ok: true, version: 2 });
    const live = h.provider.all(W).attributes.filter((a) => a.retiredAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ key: 'purpose', value: 'move money', validFrom: '2025-01-01' });
  });

  it('R14 invalid hand edit keeps the last good version', async () => {
    await h.service.apply(W, { op: 'add_entity_type', type: 'Vendor' }, ME, 'v2');
    const bad = `version: 9\nentities:\n  Team: { attrs: { x: { type: number5 } } }\n`;
    h.storage.files.set(h.path(W), bad);

    const loaded = await h.service.load(W);
    expect(loaded.version).toBe(2);
    expect(loaded.schema.entities.Vendor).toBeDefined();
    expect(loaded.errors.length).toBeGreaterThan(0);
    expect(loaded.errors[0]?.line).toBe(3);
    // the bad file is not overwritten, and the error is recorded for the World page
    expect(h.storage.files.get(h.path(W))).toBe(bad);
    expect(h.store.latestLoadErrors(W)?.errors[0]?.line).toBe(3);
    expect((await h.provider.getSchema(W))?.version).toBe(2);
    // and apply refuses to stack a change on a broken file
    const r = await h.service.apply(W, { op: 'add_entity_type', type: 'X' }, ME, 'x');
    expect(r).toEqual({ ok: false, error: expect.stringContaining('schema.yaml') });
    // the same errors are not recorded twice
    await h.service.load(W);
    expect(h.store.countLoadErrors(W)).toBe(1);
  });

  it('valid hand edit is recorded as a version', async () => {
    const edited = STARTER_PLUS_VENDOR;
    h.storage.files.set(h.path(W), edited);
    const loaded = await h.service.load(W);
    expect(loaded.errors).toEqual([]);
    expect(loaded.version).toBe(2);
    expect(loaded.schema.entities.Vendor).toBeDefined();
    const rows = h.store.listSchemaVersions(W);
    expect(rows[0]).toMatchObject({ version: 2, by: 'you (hand edit)' });
    expect((await h.provider.getSchema(W))?.version).toBe(2);
    // loading again is a no-op
    await h.service.load(W);
    expect(h.store.listSchemaVersions(W)).toHaveLength(2);
  });

  it('saveYaml: stale version is a conflict, bad text keeps the file, good text is a hand-edit version', async () => {
    const before = h.storage.files.get(h.path(W)) ?? '';
    const stale = await h.service.saveYaml(W, before, 0);
    expect(stale).toMatchObject({
      ok: false,
      kind: 'conflict',
      error: expect.stringContaining('expected 0'),
    });

    const bad = await h.service.saveYaml(W, 'version: 2\nentities: [oops\n', 1);
    expect(bad).toMatchObject({
      ok: false,
      kind: 'invalid',
      error: expect.stringContaining('line'),
    });
    expect(h.storage.files.get(h.path(W))).toBe(before);

    const edited = before.replace(
      'Skill: { attrs: {} }',
      'Skill: { attrs: {} }\n  Vendor: { attrs: {} }',
    );
    const ok = await h.service.saveYaml(W, edited, 1);
    expect(ok).toEqual({ ok: true, version: 2 });
    expect(h.storage.atomicWrites).toEqual([h.path(W)]);
    expect((await h.service.load(W)).schema.entities.Vendor).toBeDefined();
    expect(await h.service.readYaml(W)).toBe(edited);
    expect(h.service.versions(W).map((v) => v.version)).toEqual([2, 1]);
  });

  it('undoLast restores the previous version and logs it', async () => {
    await h.service.apply(W, { op: 'add_entity_type', type: 'Vendor' }, ME, 'oops');
    const r = await h.service.undoLast(W, 'me');
    expect(r).toEqual({ ok: true, version: 3 });
    const loaded = await h.service.load(W);
    expect(loaded.schema.entities.Vendor).toBeUndefined();
    expect(loaded.version).toBe(3);
    expect(loaded.changelog[0]).toMatchObject({ v: 3, by: 'you' });
    expect(loaded.changelog[0]?.change).toMatch(/undo v2/);
    const rows = h.store.listSchemaVersions(W);
    expect(rows.map((x) => x.version)).toEqual([3, 2, 1]);
  });

  it('undoLast refuses when only one version exists, and after a rewrite', async () => {
    expect(await h.service.undoLast(W, 'me')).toEqual({
      ok: false,
      error: expect.stringContaining('nothing to undo'),
    });
    await h.service.apply(
      W,
      { op: 'rename_type', kind: 'entity', from: 'Skill', to: 'Capability' },
      ME,
      'r',
    );
    expect(await h.service.undoLast(W, 'me')).toEqual({
      ok: false,
      error: expect.stringContaining('rewrote facts'),
    });
  });

  it('schema_versions is STRICT; durability posture is FULL', () => {
    const db = (h.store as unknown as { db: Database.Database }).db;
    const tables = db
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as Array<{ name: string; sql: string }>;
    expect(tables.map((t) => t.name)).toContain('schema_versions');
    for (const t of tables) {
      expect(t.sql.trimEnd().endsWith('STRICT'), `${t.name} is not STRICT`).toBe(true);
    }
    // service.db holds decisions owed to the user: never sweep to NORMAL
    // (.claude/rules/sqlite-durability.md).
    const sync = db.pragma('synchronous') as Array<{ synchronous: number }>;
    expect(sync[0]?.synchronous).toBe(2);
    const mode = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(mode[0]?.journal_mode).toBe('wal');
  });
});

const STARTER_PLUS_VENDOR = `version: 1
entities:
  Team: { attrs: { mission: { type: string } } }
  Person: { attrs: { email: { type: string } } }
  Skill: { attrs: {} }
  Vendor: { attrs: {} }
edges:
  member_of: { from: [Person], to: [Team], attrs: { role: { type: string } } }
  expert_in: "Person -> Skill"
  depends_on: "Team -> Team"
`;
