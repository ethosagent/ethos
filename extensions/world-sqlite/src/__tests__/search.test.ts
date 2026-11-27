import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteWorldGraphProvider, worldGraphDbPath } from '../index';

const W = 'world:acme' as const;

describe('SQLiteWorldGraphProvider — name search', () => {
  let dir: string;
  let store: SQLiteWorldGraphProvider;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'world-search-'));
    store = new SQLiteWorldGraphProvider(worldGraphDbPath(dir));
    await store.assert(W, [
      {
        kind: 'entity',
        type: 'Person',
        name: 'Priya Nair',
        aliases: ['priya@acme.example', 'PN'],
        sourceRef: 't',
        author: 'user',
      },
      { kind: 'entity', type: 'Service', name: 'Billing', sourceRef: 't', author: 'user' },
    ]);
  });
  afterEach(() => {
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  const find = async (text: string, types?: string[]) =>
    (
      await store.query(W, { kind: 'entities', text, ...(types ? { types } : {}), limit: 10 })
    ).entities.map((e) => e.name);

  it('search finds an alias ("priya@acme.example" → Priya)', async () => {
    expect(await find('priya@acme.example')).toEqual(['Priya Nair']);
    expect(await find('nair')).toEqual(['Priya Nair']);
    expect(await find('bill')).toEqual(['Billing']); // prefix
    expect(await find('priya', ['Service'])).toEqual([]);
  });

  it('FTS operators in text are inert', async () => {
    await expect(find('"NEAR(" OR *')).resolves.toEqual([]);
    await expect(find('name:billing AND NOT x')).resolves.toEqual([]);
    await expect(find('   ')).resolves.toEqual(['Priya Nair', 'Billing']); // blank text = no filter
    await expect(find('"')).resolves.toEqual([]);
  });

  it('the index follows alias appends and purges', async () => {
    const found = await store.query(W, { kind: 'entities', text: 'Priya', limit: 5 });
    const id = found.entities[0]?.id as string;
    (store as unknown as { db: import('@ethosagent/sqlite').default.Database }).db
      .prepare(`UPDATE entities SET aliases = '["priya@acme.example","PN","P. Nair"]' WHERE id = ?`)
      .run(id);
    expect(await find('nair')).toEqual(['Priya Nair']);
    await store.purge(W, { entityId: id }, 'test');
    expect(await find('priya')).toEqual([]);
  });
});
