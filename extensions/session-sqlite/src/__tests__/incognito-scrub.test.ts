import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import type { AgentEvent } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteContextLog } from '../context-log';
import { SQLiteSessionStore } from '../index';

// `SessionStore.scrubIncognito` (plan incognito-sessions D7/D8, §5.2): blank
// conversation text of incognito sessions and their `<key>:` descendants, keep
// every row and its usage columns.

const usage = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 10,
  cacheCreationTokens: 5,
  estimatedCostUsd: 0.25,
  apiCallCount: 1,
  compactionCount: 0,
};

const base = {
  platform: 'cli',
  model: 'claude-opus-4-7',
  provider: 'anthropic',
  workingDir: '/tmp',
  usage,
};

const HOUR_MS = 3_600_000;

describe('SQLiteSessionStore.scrubIncognito', () => {
  let dir: string;
  let dbPath: string;
  let store: SQLiteSessionStore;
  let ctxLog: SQLiteContextLog;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'incognito-scrub-'));
    dbPath = join(dir, 'sessions.db');
    store = new SQLiteSessionStore(dbPath);
    ctxLog = new SQLiteContextLog(dbPath);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // biome-ignore lint/suspicious/noExplicitAny: direct DB access for test setup and inspection
  const db = (): any => (store as any).db;

  async function session(key: string, incognito: boolean, title = 'secret title') {
    return store.createSession({
      ...base,
      key,
      title,
      metadata: incognito ? { incognito: true } : {},
    });
  }

  async function say(sessionId: string, content: string, extra: Record<string, unknown> = {}) {
    return store.appendMessage({
      sessionId,
      role: 'assistant',
      content,
      toolCalls: [{ id: 't1', name: 'bash', input: { cmd: content } }],
      contentBlocks: [{ type: 'text', text: content }],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0.1,
      },
      ...extra,
    });
  }

  function backdate(messageId: string, ms: number): void {
    db()
      .prepare('UPDATE messages SET timestamp = ? WHERE id = ?')
      .run(new Date(Date.now() - ms).toISOString(), messageId);
  }

  function rawMessage(id: string) {
    return db()
      .prepare(
        'SELECT role, content, tool_calls, content_blocks, input_tokens, timestamp FROM messages WHERE id = ?',
      )
      .get(id) as {
      role: string;
      content: string;
      tool_calls: string | null;
      content_blocks: string | null;
      input_tokens: number | null;
      timestamp: string;
    };
  }

  it('matches keyed descendants of a key with an astral character (substr counts chars, not UTF-16 units)', async () => {
    const key = 'cli:🎉-proj:1700000000';
    const inc = await session(key, true);
    const child = await session(`${key}:sub:x`, false);
    const other = await session('cli:🎉-proj:1700000001:sub:x', false);
    await say(inc.id, 'a');
    await say(child.id, 'b');
    const o = await say(other.id, 'c');

    const res = await store.scrubIncognito({ sessionKey: key });

    expect(res.sessionIds.sort()).toEqual([inc.id, child.id].sort());
    expect(rawMessage(o.id).content).toBe('c');
  });

  it('scrubs an incognito session and its descendants by key; leaves a normal session alone', async () => {
    const inc = await session('web:inc', true);
    const child = await session('web:inc:sub:x', false);
    const normal = await session('web:normal', false);
    const m1 = await say(inc.id, 'zebrawordalpha');
    const m2 = await say(child.id, 'zebrawordalpha child');
    const m3 = await say(normal.id, 'zebrawordalpha normal');

    const res = await store.scrubIncognito({ sessionKey: 'web:inc' });

    expect(res.messages).toBe(2);
    expect(res.sessionIds.sort()).toEqual([inc.id, child.id].sort());
    for (const id of [m1.id, m2.id]) {
      const r = rawMessage(id);
      expect(r.content).toBe('');
      expect(r.tool_calls).toBeNull();
      expect(r.content_blocks).toBeNull();
      expect(r.role).toBe('assistant');
    }
    expect((await store.getSession(inc.id))?.title).toBeUndefined();
    expect((await store.getSession(child.id))?.title).toBeUndefined();
    expect(rawMessage(m3.id).content).toBe('zebrawordalpha normal');
    expect((await store.getSession(normal.id))?.title).toBe('secret title');
  });

  it('a non-incognito session key passed explicitly is not scrubbed', async () => {
    const normal = await session('web:normal', false);
    const m = await say(normal.id, 'keep me');
    const res = await store.scrubIncognito({ sessionKey: 'web:normal' });
    expect(res).toEqual({ messages: 0, sessionIds: [] });
    expect(rawMessage(m.id).content).toBe('keep me');
  });

  it('FTS no longer finds scrubbed text and still finds the control', async () => {
    const inc = await session('web:inc', true);
    const normal = await session('web:normal', false);
    await say(inc.id, 'quokkaunique in incognito');
    await say(normal.id, 'quokkaunique in control');
    expect((await store.search('quokkaunique')).length).toBe(2);

    await store.scrubIncognito({});

    const hits = await store.search('quokkaunique');
    expect(hits.map((h) => h.sessionId)).toEqual([normal.id]);
  });

  it('usage survives: usageAggregate total, message usage columns and session rollup are unchanged', async () => {
    const inc = await session('web:inc', true);
    const m = await say(inc.id, 'spend text');
    const win = {
      since: new Date(Date.now() - 24 * HOUR_MS),
      until: new Date(Date.now() + HOUR_MS),
    };
    const before = await store.usageAggregate({ ...win, dimension: 'day' });
    const sessionBefore = await store.getSession(inc.id);

    await store.scrubIncognito({ sessionKey: 'web:inc' });

    expect(await store.usageAggregate({ ...win, dimension: 'day' })).toEqual(before);
    expect((await store.getSession(inc.id))?.usage).toEqual(sessionBefore?.usage);
    expect(rawMessage(m.id).input_tokens).toBe(10);
    expect(rawMessage(m.id).timestamp).toBeTruthy();
  });

  it('olderThan only scrubs old messages', async () => {
    const inc = await session('web:inc', true);
    const old = await say(inc.id, 'old text');
    const fresh = await say(inc.id, 'fresh text');
    backdate(old.id, 25 * HOUR_MS);
    backdate(fresh.id, 1 * HOUR_MS);

    const res = await store.scrubIncognito({ olderThan: new Date(Date.now() - 24 * HOUR_MS) });

    expect(res.messages).toBe(1);
    expect(rawMessage(old.id).content).toBe('');
    expect(rawMessage(fresh.id).content).toBe('fresh text');
  });

  it('olderThan with a sessionKey honours both', async () => {
    const a = await session('web:a', true);
    const b = await session('web:b', true);
    const aOld = await say(a.id, 'a old');
    const aNew = await say(a.id, 'a new');
    const bOld = await say(b.id, 'b old');
    backdate(aOld.id, 25 * HOUR_MS);
    backdate(bOld.id, 25 * HOUR_MS);

    const res = await store.scrubIncognito({
      sessionKey: 'web:a',
      olderThan: new Date(Date.now() - 24 * HOUR_MS),
    });

    expect(res.messages).toBe(1);
    expect(rawMessage(aOld.id).content).toBe('');
    expect(rawMessage(aNew.id).content).toBe('a new');
    expect(rawMessage(bOld.id).content).toBe('b old');
  });

  it('without a sessionKey, scrubs descendants of an incognito session even when unstamped', async () => {
    await session('web:inc', true);
    const child = await session('web:inc:job:7', false);
    const m = await say(child.id, 'child text');
    const res = await store.scrubIncognito({});
    expect(res.sessionIds).toContain(child.id);
    expect(rawMessage(m.id).content).toBe('');
  });

  it('soft-deleted rows are scrubbed too', async () => {
    const inc = await session('web:inc', true);
    const m = await say(inc.id, 'deleted text');
    db()
      .prepare('UPDATE messages SET deleted_at = ? WHERE id = ?')
      .run(new Date().toISOString(), m.id);

    const res = await store.scrubIncognito({ sessionKey: 'web:inc' });

    expect(res.messages).toBe(1);
    expect(rawMessage(m.id).content).toBe('');
  });

  it('a key with % or _ does not over-match', async () => {
    const inc = await session('web:a_b%', true);
    const real = await session('web:a_b%:sub:1', false);
    const lookalike = await session('web:aXbZZ:sub:1', false);
    const likeSibling = await session('web:a_b%x', false);
    const mReal = await say(real.id, 'real child');
    const mLook = await say(lookalike.id, 'lookalike');
    const mSib = await say(likeSibling.id, 'sibling');
    await say(inc.id, 'root');

    await store.scrubIncognito({ sessionKey: 'web:a_b%' });

    expect(rawMessage(mReal.id).content).toBe('');
    expect(rawMessage(mLook.id).content).toBe('lookalike');
    expect(rawMessage(mSib.id).content).toBe('sibling');
  });

  it('clears compression summaries, context events and decisions of targets only', async () => {
    const inc = await session('web:inc', true);
    const normal = await session('web:normal', false);
    for (const s of [inc, normal]) {
      const m = await say(s.id, 'x');
      await store.recordCompression({
        sessionId: s.id,
        engineName: 'e',
        originalCount: 2,
        keptCount: 1,
        summaryText: 'summary of secrets',
        summaryTokens: 3,
        preTotalTokens: 10,
        postTotalTokens: 5,
        durationMs: 1,
      });
      await ctxLog.append({
        sessionId: s.id,
        messageId: m.id,
        kind: 'k',
        mode: 'm',
        hash: 'h',
        meta: { a: 1 },
        timestamp: 1,
      } as never);
      await store.appendDecision(s.id, {
        type: 'decision',
        id: 'd1',
        phase: 'settled',
        site: 'approver',
        provider: 'typesafe',
        mode: 'shadow',
      } as AgentEvent as Extract<AgentEvent, { type: 'decision' }>);
    }

    await store.scrubIncognito({ sessionKey: 'web:inc' });

    const count = (table: string, id: string): number =>
      (
        db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(id) as {
          n: number;
        }
      ).n;
    expect(count('session_context_events', inc.id)).toBe(0);
    expect(count('session_decisions', inc.id)).toBe(0);
    expect(count('session_context_events', normal.id)).toBe(1);
    expect(count('session_decisions', normal.id)).toBe(1);
    expect((await store.listCompressions(inc.id))[0]?.summaryText).toBeUndefined();
    expect((await store.listCompressions(normal.id))[0]?.summaryText).toBe('summary of secrets');
  });

  it('olderThan sweep leaves a live incognito session with no old messages untouched', async () => {
    const inc = await session('web:live', true);
    const m = await say(inc.id, 'recent text');
    backdate(m.id, 1 * HOUR_MS);
    await store.recordCompression({
      sessionId: inc.id,
      engineName: 'e',
      originalCount: 2,
      keptCount: 1,
      summaryText: 'live summary',
      summaryTokens: 3,
      preTotalTokens: 10,
      postTotalTokens: 5,
      durationMs: 1,
    });
    await store.appendDecision(inc.id, {
      type: 'decision',
      id: 'd1',
      phase: 'settled',
      site: 'approver',
      provider: 'typesafe',
      mode: 'shadow',
    } as AgentEvent as Extract<AgentEvent, { type: 'decision' }>);

    const res = await store.scrubIncognito({ olderThan: new Date(Date.now() - 24 * HOUR_MS) });

    expect(res).toEqual({ messages: 0, sessionIds: [] });
    expect((await store.getSession(inc.id))?.title).toBe('secret title');
    expect((await store.listCompressions(inc.id))[0]?.summaryText).toBe('live summary');
    expect((await store.getDecisions(inc.id)).length).toBe(1);
    expect(rawMessage(m.id).content).toBe('recent text');
  });

  it('is idempotent: a second scrub reports no messages', async () => {
    const inc = await session('web:inc', true);
    await say(inc.id, 'once');
    expect((await store.scrubIncognito({})).messages).toBe(1);
    expect(await store.scrubIncognito({})).toEqual({ messages: 0, sessionIds: [] });
  });

  it('tolerates a session row with malformed metadata JSON', async () => {
    const inc = await session('web:inc', true);
    const bad = await session('web:bad', false);
    db().prepare('UPDATE sessions SET metadata = ? WHERE id = ?').run('{not json', bad.id);
    await say(inc.id, 'text');
    const res = await store.scrubIncognito({});
    expect(res.messages).toBe(1);
  });

  it('leaves a raw handle readable: the database file is still valid', async () => {
    const inc = await session('web:inc', true);
    await say(inc.id, 'text');
    await store.scrubIncognito({});
    const raw = new Database(dbPath, { readonly: true });
    try {
      expect((raw.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(1);
    } finally {
      raw.close();
    }
  });
});
