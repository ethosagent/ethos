// Plan session-db-repair Part C: one bad column degrades field by field; real
// SQLite errors still throw.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { type RowIssue, SQLiteSessionStore } from '../index';

const baseSession = {
  key: 'cli:tolerance',
  platform: 'cli',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
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

describe('row tolerance', () => {
  const dirs: string[] = [];
  const stores: SQLiteSessionStore[] = [];

  afterEach(() => {
    for (const s of stores.splice(0)) s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(onRowIssue?: (i: RowIssue) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'session-sqlite-tolerance-'));
    dirs.push(dir);
    const dbPath = join(dir, 'sessions.db');
    const store = new SQLiteSessionStore(dbPath, { onRowIssue });
    stores.push(store);
    const raw = <T>(fn: (db: Database.Database) => T): T => {
      const db = new Database(dbPath);
      try {
        return fn(db);
      } finally {
        db.close();
      }
    };
    return { dbPath, store, raw };
  }

  it('listSessions returns every row when one has bad metadata JSON', async () => {
    const { store, raw } = setup();
    const good = await store.createSession({ ...baseSession, key: 'a', metadata: { k: 1 } });
    const bad = await store.createSession({ ...baseSession, key: 'b' });
    raw((db) => db.prepare('UPDATE sessions SET metadata = ? WHERE id = ?').run('{bad', bad.id));
    const list = await store.listSessions();
    expect(list.map((s) => s.id).sort()).toEqual([good.id, bad.id].sort());
    expect(list.find((s) => s.id === bad.id)?.metadata).toBeUndefined();
    expect(list.find((s) => s.id === good.id)?.metadata).toEqual({ k: 1 });
  });

  it('getSessionByKey survives bad metadata', async () => {
    const { store, raw } = setup();
    const s = await store.createSession(baseSession);
    raw((db) => db.prepare('UPDATE sessions SET metadata = ? WHERE id = ?').run('nope', s.id));
    const got = await store.getSessionByKey(baseSession.key);
    expect(got?.id).toBe(s.id);
    expect(got?.metadata).toBeUndefined();
  });

  it('getMessages returns the row with toolCalls undefined when tool_calls is bad JSON', async () => {
    const { store, raw } = setup();
    const s = await store.createSession(baseSession);
    const m = await store.appendMessage({
      sessionId: s.id,
      role: 'assistant',
      content: 'text survives',
      toolCalls: [{ id: 'tc1', name: 'read_file', input: {} }],
    });
    raw((db) => db.prepare('UPDATE messages SET tool_calls = ? WHERE id = ?').run('[{', m.id));
    const [row] = await store.getMessages(s.id);
    expect(row?.content).toBe('text survives');
    expect(row?.toolCalls).toBeUndefined();
  });

  it('the dropped tool_use leaves no orphan tool_result after toLLMMessages', async () => {
    const { toLLMMessages } = await import('@ethosagent/core');
    const { store, raw } = setup();
    const s = await store.createSession(baseSession);
    await store.appendMessage({ sessionId: s.id, role: 'user', content: 'go' });
    const a = await store.appendMessage({
      sessionId: s.id,
      role: 'assistant',
      content: 'calling',
      toolCalls: [{ id: 'tc1', name: 'read_file', input: {} }],
    });
    await store.appendMessage({
      sessionId: s.id,
      role: 'tool_result',
      content: 'body',
      toolCallId: 'tc1',
      toolName: 'read_file',
    });
    raw((db) => db.prepare('UPDATE messages SET tool_calls = ? WHERE id = ?').run('[{', a.id));
    const llm = toLLMMessages(await store.getMessages(s.id));
    expect(JSON.stringify(llm)).not.toContain('tool_result');
    expect(JSON.stringify(llm)).not.toContain('tc1');
  });

  it('contentBlocks bad JSON degrades to undefined', async () => {
    const { store, raw } = setup();
    const s = await store.createSession(baseSession);
    const m = await store.appendMessage({ sessionId: s.id, role: 'assistant', content: 'hi' });
    raw((db) => db.prepare('UPDATE messages SET content_blocks = ? WHERE id = ?').run('{x', m.id));
    const [row] = await store.getMessages(s.id);
    expect(row?.contentBlocks).toBeUndefined();
    expect(row?.content).toBe('hi');
  });

  it('an invalid timestamp becomes epoch and ordering by SQL is unchanged', async () => {
    const { store, raw } = setup();
    const s = await store.createSession(baseSession);
    const m1 = await store.appendMessage({ sessionId: s.id, role: 'user', content: 'one' });
    await store.appendMessage({ sessionId: s.id, role: 'assistant', content: 'two' });
    raw((db) => db.prepare('UPDATE messages SET timestamp = ? WHERE id = ?').run('garbage', m1.id));
    raw((db) => db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run('garbage', s.id));
    const rows = await store.getMessages(s.id);
    const expected = raw(
      (db) =>
        db
          .prepare(
            'SELECT content FROM messages WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC',
          )
          .all(s.id) as Array<{ content: string }>,
    ).map((r) => r.content);
    expect(rows.map((r) => r.content)).toEqual(expected);
    expect(rows.find((r) => r.id === m1.id)?.timestamp.getTime()).toBe(0);
    expect((await store.getSession(s.id))?.createdAt.getTime()).toBe(0);
  });

  it('getMessagePage degrades the same way', async () => {
    const { store, raw } = setup();
    const s = await store.createSession(baseSession);
    const m = await store.appendMessage({
      sessionId: s.id,
      role: 'assistant',
      content: 'paged',
      toolCalls: [{ id: 'tc1', name: 'x', input: {} }],
    });
    raw((db) =>
      db
        .prepare('UPDATE messages SET tool_calls = ?, timestamp = ? WHERE id = ?')
        .run('[{', 'garbage', m.id),
    );
    const page = await store.getMessagePage(s.id, { turns: 5 });
    expect(page?.messages).toHaveLength(1);
    expect(page?.messages[0]?.toolCalls).toBeUndefined();
    expect(page?.messages[0]?.timestamp.getTime()).toBe(0);
  });

  it('search degrades an invalid timestamp to epoch and reports it', async () => {
    const issues: RowIssue[] = [];
    const { store, raw } = setup((i) => issues.push(i));
    const s = await store.createSession(baseSession);
    const m = await store.appendMessage({ sessionId: s.id, role: 'user', content: 'zebrafinch' });
    raw((db) => db.prepare('UPDATE messages SET timestamp = ? WHERE id = ?').run('garbage', m.id));
    const hits = await store.search('zebrafinch');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.timestamp.getTime()).toBe(0);
    expect(issues).toEqual([
      { table: 'messages', id: m.id, column: 'timestamp', reason: 'invalid_timestamp' },
    ]);
  });

  it('onRowIssue fires once per row+column across repeated reads', async () => {
    const issues: RowIssue[] = [];
    const { store, raw } = setup((i) => issues.push(i));
    const s = await store.createSession(baseSession);
    const m = await store.appendMessage({ sessionId: s.id, role: 'assistant', content: 'c' });
    raw((db) => db.prepare('UPDATE messages SET tool_calls = ? WHERE id = ?').run('[{', m.id));
    raw((db) => db.prepare('UPDATE sessions SET metadata = ? WHERE id = ?').run('{', s.id));
    for (let i = 0; i < 3; i++) {
      await store.getMessages(s.id);
      await store.getSession(s.id);
    }
    expect(issues).toEqual([
      { table: 'messages', id: m.id, column: 'tool_calls', reason: 'invalid_json' },
      { table: 'sessions', id: s.id, column: 'metadata', reason: 'invalid_json' },
    ]);
  });

  it('no event content carries message text', async () => {
    const issues: RowIssue[] = [];
    const { store, raw } = setup((i) => issues.push(i));
    const s = await store.createSession(baseSession);
    const m = await store.appendMessage({
      sessionId: s.id,
      role: 'assistant',
      content: 'PRIVATE-MESSAGE-TEXT',
    });
    raw((db) => db.prepare('UPDATE messages SET content_blocks = ? WHERE id = ?').run('{x', m.id));
    await store.getMessages(s.id);
    expect(issues).toHaveLength(1);
    expect(JSON.stringify(issues)).not.toContain('PRIVATE-MESSAGE-TEXT');
    expect(Object.keys(issues[0] ?? {}).sort()).toEqual(['column', 'id', 'reason', 'table']);
  });

  it('a SqliteError from the query still throws (not masked)', async () => {
    const { store } = setup();
    const s = await store.createSession(baseSession);
    // Force a SqliteError out of the read path: the table the query reads is gone.
    (store as unknown as { db: Database.Database }).db.exec(
      'ALTER TABLE messages RENAME TO messages_gone',
    );
    await expect(store.getMessages(s.id)).rejects.toMatchObject({ errcode: expect.any(Number) });
  });
});
