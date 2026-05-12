import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteSessionStore } from '../index';

// Uses an in-memory SQLite database — no disk I/O, no cleanup needed.
function makeStore() {
  return new SQLiteSessionStore(':memory:');
}

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

describe('SQLiteSessionStore', () => {
  let store: SQLiteSessionStore;

  beforeEach(() => {
    store = makeStore();
  });

  afterEach(() => {
    store.close();
  });

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  it('creates and retrieves a session by id', async () => {
    const session = await store.createSession(baseSession);

    expect(session.id).toBeTruthy();
    expect(session.key).toBe('cli:default');
    expect(session.createdAt).toBeInstanceOf(Date);

    const found = await store.getSession(session.id);
    expect(found?.id).toBe(session.id);
    expect(found?.platform).toBe('cli');
  });

  it('retrieves a session by key', async () => {
    const session = await store.createSession(baseSession);
    const found = await store.getSessionByKey('cli:default');
    expect(found?.id).toBe(session.id);
  });

  it('returns null for unknown session', async () => {
    expect(await store.getSession('nonexistent')).toBeNull();
    expect(await store.getSessionByKey('nonexistent')).toBeNull();
  });

  it('deletes a session and cascades to messages', async () => {
    const session = await store.createSession(baseSession);
    await store.appendMessage({ sessionId: session.id, role: 'user', content: 'hello' });

    await store.deleteSession(session.id);

    expect(await store.getSession(session.id)).toBeNull();
    const msgs = await store.getMessages(session.id);
    expect(msgs).toHaveLength(0);
  });

  it('lists sessions with filters', async () => {
    await store.createSession({ ...baseSession, key: 'cli:1', platform: 'cli' });
    await store.createSession({ ...baseSession, key: 'tg:1', platform: 'telegram' });

    const cliSessions = await store.listSessions({ platform: 'cli' });
    expect(cliSessions).toHaveLength(1);
    expect(cliSessions[0]?.platform).toBe('cli');
  });

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  it('appends and retrieves messages in chronological order', async () => {
    const session = await store.createSession(baseSession);

    await store.appendMessage({ sessionId: session.id, role: 'user', content: 'hello' });
    await store.appendMessage({ sessionId: session.id, role: 'assistant', content: 'hi there' });
    await store.appendMessage({ sessionId: session.id, role: 'user', content: 'how are you' });

    const msgs = await store.getMessages(session.id);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]?.role).toBe('user');
    expect(msgs[0]?.content).toBe('hello');
    expect(msgs[2]?.content).toBe('how are you');
  });

  it('getMessages with limit returns most recent N messages', async () => {
    const session = await store.createSession(baseSession);

    for (let i = 1; i <= 5; i++) {
      await store.appendMessage({ sessionId: session.id, role: 'user', content: `msg ${i}` });
    }

    const recent = await store.getMessages(session.id, { limit: 3 });
    expect(recent).toHaveLength(3);
    // Should be the last 3 in chronological order
    expect(recent[0]?.content).toBe('msg 3');
    expect(recent[2]?.content).toBe('msg 5');
  });

  it('persists toolCalls on assistant messages', async () => {
    const session = await store.createSession(baseSession);

    await store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'searching...',
      toolCalls: [{ id: 'call_1', name: 'web_search', input: { query: 'test' } }],
    });

    const msgs = await store.getMessages(session.id);
    expect(msgs[0]?.toolCalls).toEqual([
      { id: 'call_1', name: 'web_search', input: { query: 'test' } },
    ]);
  });

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  it('increments usage deltas correctly', async () => {
    const session = await store.createSession(baseSession);

    await store.updateUsage(session.id, { inputTokens: 100, outputTokens: 50, apiCallCount: 1 });
    await store.updateUsage(session.id, { inputTokens: 200, outputTokens: 80, apiCallCount: 1 });

    const updated = await store.getSession(session.id);
    expect(updated?.usage.inputTokens).toBe(300);
    expect(updated?.usage.outputTokens).toBe(130);
    expect(updated?.usage.apiCallCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Full-text search
  // -------------------------------------------------------------------------

  it('finds messages via FTS search', async () => {
    const session = await store.createSession(baseSession);

    await store.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'What is quantum computing?',
    });
    await store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'Quantum computing uses qubits.',
    });
    await store.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'Tell me about classical computers.',
    });

    const results = await store.search('quantum');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.snippet.toLowerCase().includes('quantum'))).toBe(true);
  });

  it('search scoped to sessionId excludes other sessions', async () => {
    const s1 = await store.createSession({ ...baseSession, key: 's1' });
    const s2 = await store.createSession({ ...baseSession, key: 's2' });

    await store.appendMessage({ sessionId: s1.id, role: 'user', content: 'quantum physics' });
    await store.appendMessage({ sessionId: s2.id, role: 'user', content: 'quantum chemistry' });

    const results = await store.search('quantum', { sessionId: s1.id });
    expect(results.every((r) => r.sessionId === s1.id)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Pruning
  // -------------------------------------------------------------------------

  it('prunes sessions older than a given date', async () => {
    const old = await store.createSession({ ...baseSession, key: 'old' });
    const fresh = await store.createSession({ ...baseSession, key: 'fresh' });

    // Manually backdate the old session
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    // biome-ignore lint/suspicious/noExplicitAny: direct DB access for test setup
    (store as any).db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(yesterday, old.id);

    const cutoff = new Date(Date.now() - 3_600_000); // 1 hour ago
    const pruned = await store.pruneOldSessions(cutoff);

    expect(pruned).toBe(1);
    expect(await store.getSession(old.id)).toBeNull();
    expect(await store.getSession(fresh.id)).not.toBeNull();
  });
});

// -------------------------------------------------------------------------
// FW-4 — title management
// -------------------------------------------------------------------------

describe('SQLiteSessionStore — title management', () => {
  let store: SQLiteSessionStore;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('setTitle persists a title on the session', async () => {
    const session = await store.createSession(baseSession);
    await store.setTitle(session.id, 'auth refactor');

    const found = await store.getSession(session.id);
    expect(found?.title).toBe('auth refactor');
  });

  it('setTitle with null clears the title', async () => {
    const session = await store.createSession({ ...baseSession, title: 'old title' });
    await store.setTitle(session.id, null);

    const found = await store.getSession(session.id);
    expect(found?.title).toBeUndefined();
  });
});

// -------------------------------------------------------------------------
// FW-2 — session resume lookup
// -------------------------------------------------------------------------

describe('SQLiteSessionStore — resume lookup', () => {
  let store: SQLiteSessionStore;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('findMostRecent returns the session with the latest updated_at', async () => {
    await store.createSession({ ...baseSession, key: 'cli:a' });
    const s2 = await store.createSession({ ...baseSession, key: 'cli:b' });
    // Advance s2's updated_at by touching it
    await store.updateSession(s2.id, { title: 'newer' });

    const found = await store.findMostRecent();
    expect(found?.id).toBe(s2.id);
  });

  it('findMostRecent returns null when no sessions exist', async () => {
    const found = await store.findMostRecent();
    expect(found).toBeNull();
  });

  it('findByTitle returns exact match on title (case-insensitive)', async () => {
    const s = await store.createSession({ ...baseSession, key: 'cli:x', title: 'Auth Refactor' });
    const results = await store.findByTitle('auth refactor');
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(s.id);
  });

  it('findByTitle returns fragment match when no exact match', async () => {
    const s = await store.createSession({
      ...baseSession,
      key: 'cli:y',
      title: 'auth refactoring pass',
    });
    const results = await store.findByTitle('refactor');
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(s.id);
  });

  it('findByTitle returns empty array when nothing matches', async () => {
    await store.createSession({ ...baseSession, key: 'cli:z', title: 'something else' });
    const results = await store.findByTitle('quantum');
    expect(results).toHaveLength(0);
  });

  it('findByTitle returns multiple sessions for fragment with multiple matches', async () => {
    await store.createSession({ ...baseSession, key: 'cli:1', title: 'auth feature' });
    await store.createSession({ ...baseSession, key: 'cli:2', title: 'auth bug fix' });
    const results = await store.findByTitle('auth');
    expect(results.length).toBeGreaterThanOrEqual(2);
  });
});

describe('SQLiteSessionStore migration idempotency', () => {
  it('opening the same db twice does not throw and trace_id column exists exactly once', () => {
    const { join } = require('node:path');
    const { tmpdir } = require('node:os');
    const dbPath = join(tmpdir(), `session-migration-test-${Date.now()}.db`);

    // First open — creates schema + runs migration
    const s1 = new SQLiteSessionStore(dbPath);
    s1.close();

    // Second open — migration guard (col exists check) must prevent duplicate ALTER TABLE
    expect(() => {
      const s2 = new SQLiteSessionStore(dbPath);
      s2.close();
    }).not.toThrow();

    // Confirm the column exists exactly once in the schema
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    const cols = db.pragma('table_info(messages)') as Array<{ name: string }>;
    db.close();
    const traceIdCols = cols.filter((c) => c.name === 'trace_id');
    expect(traceIdCols).toHaveLength(1);
  });
});
