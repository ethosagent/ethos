import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteSessionById,
  listSessions,
  renameSession,
  type SessionListItem,
  searchSessions,
} from '../commands/sessions';

// ---------------------------------------------------------------------------
// FW-3 — sessions command helpers
// ---------------------------------------------------------------------------

const baseSession = {
  key: 'cli:default',
  platform: 'cli',
  model: 'claude-opus-4-7',
  provider: 'anthropic',
  workingDir: '/tmp',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  },
};

describe('sessions command helpers', () => {
  let store: SQLiteSessionStore;

  beforeEach(() => {
    const dbPath = join(tmpdir(), `sessions-cmd-test-${Date.now()}.db`);
    store = new SQLiteSessionStore(dbPath);
  });

  afterEach(() => {
    store.close();
  });

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  it('listSessions returns sessions sorted by updated_at desc', async () => {
    const s1 = await store.createSession({ ...baseSession, key: 'cli:a' });
    const s2 = await store.createSession({ ...baseSession, key: 'cli:b' });
    await store.updateSession(s2.id, { title: 'most recent' });

    const items = await listSessions(store, { limit: 20 });
    expect(items[0]?.id).toBe(s2.id);
    expect(items[1]?.id).toBe(s1.id);
  });

  it('listSessions respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.createSession({ ...baseSession, key: `cli:${i}` });
    }
    const items = await listSessions(store, { limit: 3 });
    expect(items).toHaveLength(3);
  });

  it('listSessions filters by key prefix', async () => {
    await store.createSession({ ...baseSession, key: 'cli:project' });
    await store.createSession({ ...baseSession, key: 'telegram:bot' });

    const items = await listSessions(store, { limit: 20, keyPrefix: 'cli:' });
    expect(items.every((i: SessionListItem) => i.key.startsWith('cli:'))).toBe(true);
    expect(items).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // rename
  // -------------------------------------------------------------------------

  it('renameSession updates the session title', async () => {
    const s = await store.createSession({ ...baseSession, key: 'cli:r' });
    await renameSession(store, s.id, 'new title');

    const found = await store.getSession(s.id);
    expect(found?.title).toBe('new title');
  });

  it('renameSession throws for unknown session id', async () => {
    await expect(renameSession(store, 'nonexistent', 'title')).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  it('deleteSessionById removes the session', async () => {
    const s = await store.createSession({ ...baseSession, key: 'cli:d' });
    await deleteSessionById(store, s.id);

    expect(await store.getSession(s.id)).toBeNull();
  });

  it('deleteSessionById throws for unknown session id', async () => {
    await expect(deleteSessionById(store, 'nonexistent')).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  it('searchSessions returns sessions with matching message content', async () => {
    const s1 = await store.createSession({ ...baseSession, key: 'cli:s1' });
    const s2 = await store.createSession({ ...baseSession, key: 'cli:s2' });

    await store.appendMessage({ sessionId: s1.id, role: 'user', content: 'quantum computing' });
    await store.appendMessage({ sessionId: s2.id, role: 'user', content: 'classical physics' });

    const hits = await searchSessions(store, 'quantum', { limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.sessionId === s1.id)).toBe(true);
  });
});
