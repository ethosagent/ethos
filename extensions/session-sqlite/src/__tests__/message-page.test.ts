import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySessionStore } from '@ethosagent/core';
import Database from '@ethosagent/sqlite';
import type {
  MessagePage,
  MessagePageOptions,
  MessageRole,
  SessionStore,
  StoredMessage,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQLiteSessionStore } from '../index';
import { messagePageBoundarySql, messagePageCursorSql, messagePageRangeSql } from '../message-page';

// Contract suite for `SessionStore.getMessagePage` — one set of page semantics,
// run against BOTH shipped stores so the in-memory store cannot drift from the
// SQLite one. The semantics are documented on `MessagePageOptions` in
// packages/types/src/session.ts.

const baseSession = {
  key: 'cli:paging',
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

interface StoreFactory {
  name: string;
  make(): { store: SessionStore; close(): void };
  /** Whether the store can soft-delete rows (via `undoTurns`). The in-memory store cannot. */
  softDeletes: boolean;
}

function bytesOf(m: StoredMessage): number {
  return (
    Buffer.byteLength(m.content) +
    (m.toolCalls ? Buffer.byteLength(JSON.stringify(m.toolCalls)) : 0)
  );
}

function runMessagePageContract(factory: StoreFactory): void {
  describe(`getMessagePage contract: ${factory.name}`, () => {
    let store: SessionStore;
    let close: () => void;
    let n = 0;

    beforeEach(() => {
      ({ store, close } = factory.make());
    });

    afterEach(() => {
      close();
      vi.useRealTimers();
    });

    async function newSession(): Promise<string> {
      n += 1;
      return (await store.createSession({ ...baseSession, key: `cli:paging:${n}` })).id;
    }

    async function add(
      sessionId: string,
      role: MessageRole,
      content: string,
      extra: Partial<StoredMessage> = {},
    ): Promise<StoredMessage> {
      return store.appendMessage({ sessionId, role, content, ...extra });
    }

    /** `count` turns of user → assistant(tool_use) → tool_result → assistant. */
    async function addTurns(sessionId: string, count: number, from = 0): Promise<void> {
      for (let i = from; i < from + count; i++) {
        await add(sessionId, 'user', `t${i}-user`);
        await add(sessionId, 'assistant', '', {
          toolCalls: [{ id: `call-${i}`, name: 'read_file', input: { path: `f${i}` } }],
        });
        await add(sessionId, 'tool_result', `t${i}-result`, { toolCallId: `call-${i}` });
        await add(sessionId, 'assistant', `t${i}-answer`);
      }
    }

    async function page(sessionId: string, options: MessagePageOptions): Promise<MessagePage> {
      if (!store.getMessagePage)
        throw new Error(`${factory.name} does not implement getMessagePage`);
      const result = await store.getMessagePage(sessionId, options);
      if (!result) throw new Error('expected a page, got null');
      return result;
    }

    function contents(p: MessagePage): string[] {
      return p.messages.map((m) => m.content);
    }

    /** Walk every page from newest to oldest; returns the pages in walk order. */
    async function walk(
      sessionId: string,
      options: Omit<MessagePageOptions, 'beforeMessageId'>,
    ): Promise<MessagePage[]> {
      const pages: MessagePage[] = [];
      let before: string | undefined;
      for (;;) {
        const p = await page(sessionId, {
          ...options,
          ...(before ? { beforeMessageId: before } : {}),
        });
        pages.push(p);
        if (!p.hasMore) return pages;
        const oldest = p.messages[0];
        if (!oldest) throw new Error('hasMore page with no rows');
        before = oldest.id;
        if (pages.length > 1000) throw new Error('walk did not terminate');
      }
    }

    it('returns the newest whole turns when there is no cursor', async () => {
      const s = await newSession();
      await addTurns(s, 5);
      const p = await page(s, { turns: 2 });
      expect(contents(p)).toEqual([
        't3-user',
        '',
        't3-result',
        't3-answer',
        't4-user',
        '',
        't4-result',
        't4-answer',
      ]);
      expect(p.messages[0]?.role).toBe('user');
      expect(p.hasMore).toBe(true);
    });

    it('pages back to the start with every row exactly once, each page starting at a user row', async () => {
      const s = await newSession();
      await add(s, 'system', 'leading-system');
      await addTurns(s, 7);
      const pages = await walk(s, { turns: 3 });

      expect(pages.map((p) => p.messages.length)).toEqual([12, 12, 5]);
      expect(pages.map((p) => p.hasMore)).toEqual([true, true, false]);
      for (const p of pages.slice(0, -1)) expect(p.messages[0]?.role).toBe('user');

      const walked = pages
        .slice()
        .reverse()
        .flatMap((p) => p.messages.map((m) => m.id));
      const all = (await store.getMessages(s)).map((m) => m.id);
      expect(walked).toEqual(all);
      expect(new Set(walked).size).toBe(all.length);
    });

    it('breaks same-timestamp ties by insertion order', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-13T12:00:00.000Z'));
      const s = await newSession();
      await addTurns(s, 4);

      const all = await store.getMessages(s);
      expect(new Set(all.map((m) => m.timestamp.toISOString())).size).toBe(1);

      const pages = await walk(s, { turns: 1 });
      expect(pages).toHaveLength(4);
      expect(pages.map((p) => p.messages[0]?.content)).toEqual([
        't3-user',
        't2-user',
        't1-user',
        't0-user',
      ]);
      const walked = pages
        .slice()
        .reverse()
        .flatMap((p) => p.messages.map((m) => m.id));
      expect(walked).toEqual(all.map((m) => m.id));
    });

    it('user_steer rows do not start a turn', async () => {
      const s = await newSession();
      await add(s, 'user', 'u1');
      await add(s, 'assistant', 'a1');
      await add(s, 'user_steer', 'steer');
      await add(s, 'assistant', 'a1b');
      await add(s, 'user', 'u2');
      await add(s, 'assistant', 'a2');

      const newest = await page(s, { turns: 1 });
      expect(contents(newest)).toEqual(['u2', 'a2']);
      expect(newest.hasMore).toBe(true);

      const older = await page(s, { turns: 1, beforeMessageId: newest.messages[0]?.id ?? '' });
      expect(contents(older)).toEqual(['u1', 'a1', 'steer', 'a1b']);
      expect(older.hasMore).toBe(false);
    });

    it('includes rows before the first user message in the page that reaches the start', async () => {
      const s = await newSession();
      await add(s, 'system', 'sys');
      await add(s, 'assistant', 'greeting');
      await add(s, 'user', 'u1');
      await add(s, 'assistant', 'a1');
      await add(s, 'user', 'u2');
      await add(s, 'assistant', 'a2');

      const newest = await page(s, { turns: 1 });
      expect(contents(newest)).toEqual(['u2', 'a2']);
      expect(newest.hasMore).toBe(true);
      const older = await page(s, { turns: 1, beforeMessageId: newest.messages[0]?.id ?? '' });
      expect(contents(older)).toEqual(['sys', 'greeting', 'u1', 'a1']);
      expect(older.hasMore).toBe(false);

      // Exactly as many turns as the session has: the leading rows come too.
      const whole = await page(s, { turns: 2 });
      expect(contents(whole)).toEqual(['sys', 'greeting', 'u1', 'a1', 'u2', 'a2']);
      expect(whole.hasMore).toBe(false);
    });

    it('returns a session with no user message as one page', async () => {
      const s = await newSession();
      await add(s, 'system', 'sys');
      await add(s, 'assistant', 'hello');
      const p = await page(s, { turns: 1 });
      expect(contents(p)).toEqual(['sys', 'hello']);
      expect(p.hasMore).toBe(false);
    });

    it('returns an empty final page for an empty session', async () => {
      const s = await newSession();
      expect(await page(s, { turns: 20 })).toEqual({ messages: [], hasMore: false });
    });

    it('stops adding older turns when the next one would exceed maxBytes', async () => {
      const s = await newSession();
      // Multi-byte content: the cap counts UTF-8 bytes, not UTF-16 code units.
      for (let i = 0; i < 3; i++) {
        await add(s, 'user', `${i}${'é'.repeat(50)}`);
        await add(s, 'assistant', 'ok', { toolCalls: [{ id: `c${i}`, name: 'x', input: { i } }] });
      }
      const all = await store.getMessages(s);
      const turnBytes = bytesOf(all[0] as StoredMessage) + bytesOf(all[1] as StoredMessage);
      expect(turnBytes).toBeGreaterThan(all[0]?.content.length ?? 0);

      const exactlyTwo = await page(s, { turns: 3, maxBytes: turnBytes * 2 });
      expect(exactlyTwo.messages).toHaveLength(4);
      expect(exactlyTwo.hasMore).toBe(true);

      const justUnder = await page(s, { turns: 3, maxBytes: turnBytes * 2 - 1 });
      expect(justUnder.messages).toHaveLength(2);
      expect(justUnder.messages[0]?.content.startsWith('2')).toBe(true);
      expect(justUnder.hasMore).toBe(true);
    });

    it('always returns at least one whole turn, even one larger than maxBytes', async () => {
      const s = await newSession();
      await addTurns(s, 3);
      const p = await page(s, { turns: 3, maxBytes: 1 });
      expect(contents(p)).toEqual(['t2-user', '', 't2-result', 't2-answer']);
      expect(p.hasMore).toBe(true);

      const pages = await walk(s, { turns: 3, maxBytes: 1 });
      expect(pages.map((x) => x.messages.length)).toEqual([4, 4, 4]);
    });

    it('counts leading rows toward the oldest turn when applying maxBytes', async () => {
      const s = await newSession();
      await add(s, 'system', 'x'.repeat(100));
      await add(s, 'user', 'u1');
      await add(s, 'user', 'u2');

      // Room for both turns, but not for both turns plus the leading row.
      const newest = await page(s, { turns: 5, maxBytes: 50 });
      expect(contents(newest)).toEqual(['u2']);
      expect(newest.hasMore).toBe(true);
      const older = await page(s, {
        turns: 5,
        maxBytes: 50,
        beforeMessageId: newest.messages[0]?.id ?? '',
      });
      expect(contents(older)).toEqual(['x'.repeat(100), 'u1']);
      expect(older.hasMore).toBe(false);
    });

    it('keeps a cursor valid after new messages are appended', async () => {
      const s = await newSession();
      await addTurns(s, 4);
      const first = await page(s, { turns: 2 });
      expect(first.messages[0]?.content).toBe('t2-user');

      await addTurns(s, 3, 4);

      const second = await page(s, { turns: 2, beforeMessageId: first.messages[0]?.id ?? '' });
      expect(second.messages.map((m) => m.content).filter((c) => c.endsWith('-user'))).toEqual([
        't0-user',
        't1-user',
      ]);
      expect(second.hasMore).toBe(false);
    });

    it('bounds turns: at least 1, and a larger request returns what exists', async () => {
      const s = await newSession();
      await addTurns(s, 3);
      expect((await page(s, { turns: 1 })).messages).toHaveLength(4);
      const everything = await page(s, { turns: 100 });
      expect(everything.messages).toHaveLength(12);
      expect(everything.hasMore).toBe(false);

      const getMessagePage = store.getMessagePage?.bind(store);
      if (!getMessagePage) throw new Error('missing getMessagePage');
      await expect(getMessagePage(s, { turns: 0 })).rejects.toThrow(RangeError);
      await expect(getMessagePage(s, { turns: -1 })).rejects.toThrow(RangeError);
      await expect(getMessagePage(s, { turns: 1.5 })).rejects.toThrow(RangeError);
    });

    it('returns null for a cursor that is not a row of this session', async () => {
      const a = await newSession();
      const b = await newSession();
      await addTurns(a, 2);
      await addTurns(b, 2);
      const foreign = (await page(b, { turns: 1 })).messages[0]?.id ?? '';

      expect(await store.getMessagePage?.(a, { turns: 1, beforeMessageId: foreign })).toBeNull();
      expect(await store.getMessagePage?.(a, { turns: 1, beforeMessageId: 'nope' })).toBeNull();
    });

    it.runIf(factory.softDeletes)('excludes soft-deleted rows', async () => {
      const s = await newSession();
      await add(s, 'user', 'u0');
      await add(s, 'assistant', 'a0');
      await add(s, 'user', 'u1');
      await add(s, 'assistant', 'a1');
      await add(s, 'user', 'u2');
      await add(s, 'assistant', 'a2');

      const before = await page(s, { turns: 1 });
      expect(contents(before)).toEqual(['u2', 'a2']);

      expect(await store.undoTurns(s, 1)).toBe(1);

      expect(contents(await page(s, { turns: 5 }))).toEqual(['u0', 'a0', 'u1', 'a1']);
      // A cursor naming a row deleted since it was issued still anchors its position.
      const older = await page(s, { turns: 1, beforeMessageId: before.messages[0]?.id ?? '' });
      expect(contents(older)).toEqual(['u1', 'a1']);
      expect(older.hasMore).toBe(true);
    });
  });
}

runMessagePageContract({
  name: 'SQLiteSessionStore',
  make: () => {
    const store = new SQLiteSessionStore(':memory:');
    return { store, close: () => store.close() };
  },
  softDeletes: true,
});

runMessagePageContract({
  name: 'InMemorySessionStore',
  make: () => ({ store: new InMemorySessionStore(), close: () => {} }),
  softDeletes: false,
});

describe('getMessagePage query plan (SQLite)', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-message-page-'));
    const path = join(dir, 'sessions.db');
    store = new SQLiteSessionStore(path);
    db = new Database(path);
  });

  afterEach(() => {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function plan(sql: string, params: unknown[]): string[] {
    return (
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>
    ).map((r) => r.detail);
  }

  it('resolves the cursor by primary key', () => {
    const detail = plan(messagePageCursorSql, ['m', 's']);
    expect(detail).toHaveLength(1);
    expect(detail[0]).toMatch(/^SEARCH messages USING INDEX sqlite_autoindex_messages_1 \(id=\?\)/);
  });

  for (const hasCursor of [false, true]) {
    it(`finds the boundary through idx_messages_session (cursor: ${hasCursor})`, () => {
      const params = ['s', ...(hasCursor ? ['2026-01-01T00:00:00.000Z', 1] : []), 0];
      const detail = plan(messagePageBoundarySql(hasCursor), params);
      expect(detail).toHaveLength(1);
      expect(detail[0]).toMatch(
        /^SEARCH messages USING INDEX idx_messages_session \(session_id=\?/,
      );
    });

    for (const hasLowerBound of [false, true]) {
      it(`reads the range through idx_messages_session (cursor: ${hasCursor}, lower bound: ${hasLowerBound})`, () => {
        const params = [
          's',
          ...(hasCursor ? ['2026-01-01T00:00:00.000Z', 9] : []),
          ...(hasLowerBound ? ['2025-01-01T00:00:00.000Z', 1] : []),
        ];
        const detail = plan(messagePageRangeSql(hasCursor, hasLowerBound), params);
        // One SEARCH line and no `USE TEMP B-TREE FOR ORDER BY`: the index's
        // implicit trailing rowid already satisfies the DESC ordering.
        expect(detail).toHaveLength(1);
        expect(detail[0]).toMatch(
          /^SEARCH messages USING INDEX idx_messages_session \(session_id=\?/,
        );
      });
    }
  }
});
