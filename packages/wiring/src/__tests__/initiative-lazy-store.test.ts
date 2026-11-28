// createLazyInitiativeStore never creates initiatives.db until a store method is called.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createLazyInitiativeStore } from '../initiatives';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true });
});

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'lazy-store-'));
  dirs.push(dataDir);
  const storage = new FsStorage();
  return { dataDir, storage, lazy: createLazyInitiativeStore({ storage, dataDir }) };
}

describe('createLazyInitiativeStore', () => {
  it('creates no db until the first method call; ready() and close() never create it', async () => {
    const { dataDir, storage, lazy } = await setup();
    const db = join(dataDir, 'initiatives.db');
    expect(await lazy.ready()).toBe(false);
    lazy.close();
    expect(await storage.exists(db)).toBe(false);
    expect(lazy.store.list({ personalityId: 'a' })).toEqual([]);
    expect(await storage.exists(db)).toBe(true);
    expect(await lazy.ready()).toBe(true);
    lazy.close();
  });

  it('the narrow ports open the same lazy db', async () => {
    const { storage, dataDir, lazy } = await setup();
    expect(lazy.recall.list({ personalityId: 'a' })).toEqual([]);
    expect(await storage.exists(join(dataDir, 'initiatives.db'))).toBe(true);
    expect(Object.keys(lazy.ledger)).not.toContain('recordDecision');
    lazy.close();
  });
});
