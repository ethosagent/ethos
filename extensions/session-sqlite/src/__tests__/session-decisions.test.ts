import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySessionStore } from '@ethosagent/core';
import Database from '@ethosagent/sqlite';
import type { AgentEvent, SessionStore } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteSessionStore } from '../index';

// `SessionStore.appendDecision` / `getDecisions` (plan
// decision-provider-personality §15.5, PD18) — one contract, run against BOTH
// shipped stores so the in-memory twin cannot drift; SQLite-only cases
// (migration, STRICT typing, cascade, a corrupt row) follow.

type DecisionEvent = Extract<AgentEvent, { type: 'decision' }>;

const baseSession = {
  key: 'cli:decisions',
  platform: 'cli',
  model: 'm',
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

function decision(id: string, extra: Partial<DecisionEvent> = {}): DecisionEvent {
  return {
    type: 'decision',
    id,
    phase: 'settled',
    site: 'approver',
    provider: 'typesafe',
    mode: 'shadow',
    outcome: 'ok',
    verdict: 'approve',
    todayVerdict: 'approve',
    disagreed: false,
    latencyMs: 12,
    personalityId: 'p',
    ...extra,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ethos-decisions-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const factories: Array<{ name: string; make(): { store: SessionStore; close(): void } }> = [
  {
    name: 'SQLiteSessionStore',
    make() {
      const store = new SQLiteSessionStore(join(dir, 'sessions.db'));
      return { store, close: () => store.close() };
    },
  },
  { name: 'InMemorySessionStore', make: () => ({ store: new InMemorySessionStore(), close() {} }) },
];

describe.each(factories)('$name — decision rows', ({ make }) => {
  it('round-trips a settled event unchanged, oldest first, seq per session', async () => {
    const { store, close } = make();
    try {
      const a = await store.createSession(baseSession);
      const b = await store.createSession({ ...baseSession, key: 'cli:other' });
      const first = decision('d1', { toolCallId: 't1', traceId: 'tr1' });
      await store.appendDecision?.(a.id, first);
      await store.appendDecision?.(b.id, decision('other'));
      // Same wall-clock millisecond is the common case: order is by seq.
      for (let i = 2; i <= 6; i++) await store.appendDecision?.(a.id, decision(`d${i}`));
      const rows = (await store.getDecisions?.(a.id)) ?? [];
      expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(rows.map((r) => r.event.id)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6']);
      expect(rows[0]?.event).toEqual(first);
      expect(rows[0]?.createdAt).toBeInstanceOf(Date);
      expect(rows[0]?.sessionId).toBe(a.id);
      expect((await store.getDecisions?.(b.id))?.map((r) => [r.seq, r.event.id])).toEqual([
        [1, 'other'],
      ]);
    } finally {
      close();
    }
  });

  it('filters to the rows a page anchors: by toolCallId or traceId', async () => {
    const { store, close } = make();
    try {
      const s = await store.createSession(baseSession);
      await store.appendDecision?.(s.id, decision('router', { site: 'router', traceId: 'tr1' }));
      await store.appendDecision?.(s.id, decision('appr', { toolCallId: 't1', traceId: 'tr1' }));
      await store.appendDecision?.(s.id, decision('inj', { toolCallId: 't2', traceId: 'tr2' }));
      const ids = async (f: { toolCallIds?: string[]; traceIds?: string[] }) =>
        ((await store.getDecisions?.(s.id, f)) ?? []).map((r) => r.event.id);
      expect(await ids({ traceIds: ['tr1'] })).toEqual(['router', 'appr']);
      expect(await ids({ toolCallIds: ['t2'] })).toEqual(['inj']);
      expect(await ids({ toolCallIds: ['t2'], traceIds: ['tr1'] })).toEqual([
        'router',
        'appr',
        'inj',
      ]);
      expect(await ids({ toolCallIds: [], traceIds: [] })).toEqual([]);
    } finally {
      close();
    }
  });

  it('deleteSession and pruneOldSessions take the rows with the session', async () => {
    const { store, close } = make();
    try {
      const gone = await store.createSession(baseSession);
      await store.appendDecision?.(gone.id, decision('x'));
      await store.deleteSession(gone.id);
      expect(await store.getDecisions?.(gone.id)).toEqual([]);

      const old = await store.createSession({ ...baseSession, key: 'cli:old' });
      await store.appendDecision?.(old.id, decision('y'));
      await store.pruneOldSessions(new Date(Date.now() + 60_000));
      expect(await store.getDecisions?.(old.id)).toEqual([]);
    } finally {
      close();
    }
  });

  it('refuses a row for a session that does not exist', async () => {
    const { store, close } = make();
    try {
      await expect(store.appendDecision?.('nope', decision('x'))).rejects.toThrow();
    } finally {
      close();
    }
  });
});

describe('SQLiteSessionStore — session_decisions table', () => {
  it('migrates an existing sessions.db: the table is added, messages untouched', async () => {
    const path = join(dir, 'sessions.db');
    const before = new SQLiteSessionStore(path);
    const s = await before.createSession(baseSession);
    await before.appendMessage({ sessionId: s.id, role: 'user', content: 'hello' });
    before.close();
    // Make it a pre-N7c database: no session_decisions table.
    const raw = new Database(path);
    raw.exec('DROP TABLE session_decisions');
    raw.close();

    const after = new SQLiteSessionStore(path);
    try {
      expect((await after.getMessages(s.id)).map((m) => m.content)).toEqual(['hello']);
      expect(await after.getDecisions(s.id)).toEqual([]);
      await after.appendDecision(s.id, decision('d1'));
      expect((await after.getDecisions(s.id)).map((r) => r.seq)).toEqual([1]);
    } finally {
      after.close();
    }
  });

  it('is STRICT: a mistyped column is refused, not coerced', async () => {
    const path = join(dir, 'sessions.db');
    const store = new SQLiteSessionStore(path);
    const s = await store.createSession(baseSession);
    store.close();
    const raw = new Database(path);
    try {
      const sql = raw
        .prepare('SELECT sql FROM sqlite_master WHERE name = ?')
        .get('session_decisions') as { sql: string };
      expect(sql.sql).toMatch(/\) STRICT$/);
      expect(() =>
        raw
          .prepare(
            'INSERT INTO session_decisions (session_id, seq, event, created_at) VALUES (?,?,?,?)',
          )
          .run(s.id, 'one', '{}', new Date().toISOString()),
      ).toThrow();
    } finally {
      raw.close();
    }
  });

  it('skips a row whose event no longer parses, keeps the rest', async () => {
    const path = join(dir, 'sessions.db');
    const store = new SQLiteSessionStore(path);
    const s = await store.createSession(baseSession);
    await store.appendDecision(s.id, decision('good'));
    const raw = new Database(path);
    raw
      .prepare(
        'INSERT INTO session_decisions (session_id, seq, event, created_at) VALUES (?,?,?,?)',
      )
      .run(s.id, 2, '{not json', new Date().toISOString());
    raw.close();
    try {
      await store.appendDecision(s.id, decision('after'));
      expect((await store.getDecisions(s.id)).map((r) => [r.seq, r.event.id])).toEqual([
        [1, 'good'],
        [3, 'after'],
      ]);
    } finally {
      store.close();
    }
  });
});
