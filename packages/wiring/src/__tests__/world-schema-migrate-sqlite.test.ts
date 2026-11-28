import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { WorldId } from '@ethosagent/types';
import {
  SQLiteWorldServiceStore,
  serviceDbPath,
  WorldSchemaService,
  worldSchemaPath,
} from '@ethosagent/world-service';
import { SQLiteWorldGraphProvider, worldGraphDbPath } from '@ethosagent/world-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const W: WorldId = 'world:acme';
const ME = { kind: 'user', id: 'me' } as const;
const STARTER = `version: 1
entities:
  Team: { attrs: {} }
  Person: { attrs: { email: { type: string } } }
  Skill: { attrs: {} }
edges:
  expert_in: "Person -> Skill"
`;

// Pins schema-service.ts: rename and merge of an entity type retire the old
// entity rows against the real SQLite provider (the world-service tests use a fake).
describe('WorldSchemaService against the SQLite provider', () => {
  let dir: string;
  let provider: SQLiteWorldGraphProvider;
  let store: SQLiteWorldServiceStore;
  let service: WorldSchemaService;
  let ids: { ravi: string; go: string };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'world-schema-e2e-'));
    const storage = new FsStorage();
    provider = new SQLiteWorldGraphProvider(worldGraphDbPath(dir));
    store = new SQLiteWorldServiceStore(serviceDbPath(dir));
    service = new WorldSchemaService({
      storage,
      dataDir: dir,
      store,
      provider: async () => provider,
    });
    const path = worldSchemaPath(dir, W);
    await storage.mkdir(dirname(path));
    await storage.writeAtomic(path, STARTER);
    await service.load(W);
    const made = await provider.assert(W, [
      { kind: 'entity', type: 'Person', name: 'Ravi', sourceRef: 't', author: 'user' },
      { kind: 'entity', type: 'Skill', name: 'Go', sourceRef: 't', author: 'user' },
    ]);
    if (!made.ok) throw new Error(made.reason);
    const [ravi, go] = made.ids as [string, string];
    ids = { ravi, go };
    const rest = await provider.assert(W, [
      {
        kind: 'attribute',
        entityId: ravi,
        key: 'email',
        value: 'r@acme.test',
        sourceRef: 't',
        author: 'user',
        confidence: 1,
      },
      {
        kind: 'edge',
        type: 'expert_in',
        fromId: ravi,
        toId: go,
        sourceRef: 't',
        author: 'user',
        confidence: 1,
      },
    ]);
    if (!rest.ok) throw new Error(rest.reason);
  });
  afterEach(() => {
    provider.dispose();
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('entity rename retires the old rows: no read returns one under the removed type', async () => {
    const r = await service.apply(
      W,
      { op: 'rename_type', kind: 'entity', from: 'Person', to: 'Human' },
      ME,
      'naming',
    );
    expect(r).toEqual({ ok: true, version: 2 });

    expect(
      (await provider.query(W, { kind: 'entities', types: ['Person'], limit: 50 })).entities,
    ).toEqual([]);
    const byText = await provider.query(W, { kind: 'entities', text: 'Ravi', limit: 50 });
    expect(byText.entities.map((e) => e.type)).toEqual(['Human']);
    const human = byText.entities[0]?.id as string;
    expect(byText.attributes).toMatchObject([
      { entityId: human, key: 'email', value: 'r@acme.test' },
    ]);
    const around = await provider.neighbours(W, human, 1);
    expect(around.entities.map((e) => e.type).sort()).toEqual(['Human', 'Skill']);
    expect(around.edges).toHaveLength(1);
    expect((await provider.neighbours(W, ids.ravi, 1)).entities).toEqual([]);
    const retired = (await provider.changes(W, '2000-01-01T00:00:00.000Z', 100)).find(
      (c) => c.kind === 'retired' && c.factId === ids.ravi,
    );
    expect(retired).toMatchObject({ sourceRef: 'schema:v2', author: 'user' });
  });

  it('entity merge retires the old rows: no read returns one under the merged-away type', async () => {
    const r = await service.apply(
      W,
      { op: 'merge_types', kind: 'entity', from: 'Skill', into: 'Team' },
      ME,
      'fewer',
    );
    expect(r).toEqual({ ok: true, version: 2 });

    expect(
      (await provider.query(W, { kind: 'entities', types: ['Skill'], limit: 50 })).entities,
    ).toEqual([]);
    const byText = await provider.query(W, { kind: 'entities', text: 'Go', limit: 50 });
    expect(byText.entities.map((e) => e.type)).toEqual(['Team']);
    const around = await provider.neighbours(W, ids.ravi, 1);
    expect(around.entities.map((e) => e.type).sort()).toEqual(['Person', 'Team']);
    expect((await provider.neighbours(W, ids.go, 1)).entities).toEqual([]);
  });
});
