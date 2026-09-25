import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkSession, InMemorySessionStore } from '@ethosagent/core';
import Database from '@ethosagent/sqlite';
import type { SessionStore, StoredMessage } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { SQLiteSessionStore } from '../index';

// `SessionFilter.parentSessionId` and the `forkSession` round-trip, run against
// BOTH shipped stores so the in-memory store cannot drift from the SQLite one.

const base = {
  platform: 'cli',
  model: 'claude-opus-4-7',
  provider: 'anthropic',
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

const factories: Array<{ name: string; make(): { store: SessionStore; close(): void } }> = [
  {
    name: 'SQLiteSessionStore',
    make: () => {
      const store = new SQLiteSessionStore(':memory:');
      return { store, close: () => store.close() };
    },
  },
  { name: 'InMemorySessionStore', make: () => ({ store: new InMemorySessionStore(), close() {} }) },
];

for (const factory of factories) {
  describe(`parentSessionId filter + fork round-trip: ${factory.name}`, () => {
    it('lists only the direct children of a session', async () => {
      const { store, close } = factory.make();
      try {
        const root = await store.createSession({ ...base, key: 'root' });
        const other = await store.createSession({ ...base, key: 'other' });
        const a = await store.createSession({ ...base, key: 'a', parentSessionId: root.id });
        const b = await store.createSession({ ...base, key: 'b', parentSessionId: root.id });
        await store.createSession({ ...base, key: 'grandchild', parentSessionId: a.id });
        await store.createSession({ ...base, key: 'x', parentSessionId: other.id });

        const kids = await store.listSessions({ parentSessionId: root.id });
        expect(kids.map((s) => s.key).sort()).toEqual([a.key, b.key]);
        expect(await store.listSessions({ parentSessionId: b.id })).toEqual([]);
      } finally {
        close();
      }
    });

    it('a fork round-trips contentBlocks, toolName, isError, traceId and usage', async () => {
      const { store, close } = factory.make();
      try {
        const src = await store.createSession({ ...base, key: 'src' });
        const rows: Array<Omit<StoredMessage, 'id' | 'timestamp'>> = [
          { sessionId: src.id, role: 'user', content: 'hi' },
          {
            sessionId: src.id,
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'bash', input: { cmd: 'ls' } }],
            usage: {
              inputTokens: 3,
              outputTokens: 4,
              cacheReadTokens: 1,
              cacheCreationTokens: 2,
              estimatedCostUsd: 0.5,
            },
            traceId: 'tr-1',
          },
          {
            sessionId: src.id,
            role: 'tool_result',
            content: 'out',
            toolCallId: 'c1',
            toolName: 'bash',
            isError: true,
          },
          {
            sessionId: src.id,
            role: 'assistant',
            content: '[provider compaction]',
            toolName: '_provider_compaction',
            contentBlocks: [{ type: 'text', text: 'opaque' }],
          },
        ];
        for (const r of rows) await store.appendMessage(r);
        const before = await store.getMessages(src.id);

        const { session } = await forkSession(store, src.id, { key: 'src:fork:1' });
        const after = await store.getMessages(session.id);
        const strip = ({ id: _i, sessionId: _s, timestamp: _t, ...rest }: StoredMessage) => rest;
        expect(after.map(strip)).toEqual(before.map(strip));
        expect((await store.getSession(session.id))?.parentSessionId).toBe(src.id);
        expect((await store.listSessions({ parentSessionId: src.id })).map((s) => s.id)).toEqual([
          session.id,
        ]);
      } finally {
        close();
      }
    });
  });
}

describe('parentSessionId filter query plan (SQLite)', () => {
  it('uses idx_sessions_parent, not a table scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ethos-parent-idx-'));
    const path = join(dir, 'sessions.db');
    const store = new SQLiteSessionStore(path);
    const db = new Database(path);
    try {
      const plan = db
        .prepare('EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE parent_session_id = ?')
        .all('x') as Array<{ detail: string }>;
      expect(plan.map((p) => p.detail).join('\n')).toContain('idx_sessions_parent');
    } finally {
      db.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
