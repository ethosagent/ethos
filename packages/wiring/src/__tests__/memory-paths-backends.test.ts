// plan personality-memory-boundary-and-self-amendment, G1-5 / D7 — the name
// set of `isPrivateMemoryPath` (@ethosagent/types) pinned against each memory
// backend's OWN file-name constants. A backend that renames its file without
// the predicate following would leave the renamed file readable from every
// group chat; this is the test that fails first.
//
// Lives in wiring, not beside the predicate: `@ethosagent/types` is
// zero-dependency, so its tests cannot resolve the backends. The predicate's
// semantics are pinned in `packages/types/src/__tests__/memory-paths.test.ts`.

import { PENDING_FILE, scopeDir, TOMBSTONE_FILE } from '@ethosagent/memory-approval';
import { BLOB_DIR, HISTORY_FILE, HistoryStore } from '@ethosagent/memory-history';
import { PERSONALITY_PREFETCH_KEYS } from '@ethosagent/memory-markdown';
import { VECTOR_DB_FILE } from '@ethosagent/memory-vector';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import {
  isPrivateMemoryPath,
  PRIVATE_MEMORY_BLOB_DIR,
  PRIVATE_MEMORY_DB_FILE,
  PRIVATE_MEMORY_FILE_NAMES,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';

const HOME = '/home/u/.ethos';
const roots = { stateDirs: [HOME] };

describe('isPrivateMemoryPath — pinned against the memory backends', () => {
  it('memory-markdown: every personality-scope prefetch key', () => {
    expect([...PRIVATE_MEMORY_FILE_NAMES].sort()).toEqual([...PERSONALITY_PREFETCH_KEYS].sort());
    for (const key of PERSONALITY_PREFETCH_KEYS) {
      expect(isPrivateMemoryPath(`${HOME}/personalities/lean/${key}`, roots)).toBe(true);
    }
  });

  it('memory-history: the history file and blob dir, at the path the store itself resolves', () => {
    expect(PRIVATE_MEMORY_BLOB_DIR).toBe(BLOB_DIR);
    const store = new HistoryStore({ dataDir: HOME, storage: new InMemoryStorage() });
    for (const scope of ['personality:lean', 'user:u1', 'global', 'team:core']) {
      expect(isPrivateMemoryPath(store.historyPath(scope), roots), scope).toBe(true);
      expect(isPrivateMemoryPath(`${store.scopeDir(scope)}/${BLOB_DIR}/x.md`, roots)).toBe(true);
    }
    expect(isPrivateMemoryPath(`${HOME}/personalities/lean/${HISTORY_FILE}`, roots)).toBe(true);
  });

  it('memory-approval: the pending queue and tombstones, in every scope dir', () => {
    for (const scope of ['personality:lean', 'user:u1', 'global', 'team:core']) {
      const dir = scopeDir(HOME, scope);
      expect(isPrivateMemoryPath(`${dir}/${PENDING_FILE}`, roots), scope).toBe(true);
      expect(isPrivateMemoryPath(`${dir}/${TOMBSTONE_FILE}`, roots), scope).toBe(true);
    }
  });

  it('memory-vector: the database file and its SQLite siblings under the data dir', () => {
    expect(PRIVATE_MEMORY_DB_FILE).toBe(VECTOR_DB_FILE);
    for (const suffix of ['', '-wal', '-shm']) {
      expect(isPrivateMemoryPath(`${HOME}/${VECTOR_DB_FILE}${suffix}`, roots)).toBe(true);
    }
  });
});
