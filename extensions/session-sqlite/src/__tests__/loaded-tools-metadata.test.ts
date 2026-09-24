// reach-and-containment Part 1 (C6) — `persistLoaded` against the REAL
// SQLite store. `SQLiteSessionStore.updateSession` replaces `metadata`
// wholesale, so the writer must read, merge, then write; this pins that the
// other metadata keys survive and the loaded set keeps its load order.

import { persistLoaded } from '@ethosagent/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteSessionStore } from '../index';

const baseSession = {
  key: 'cli:loaded',
  platform: 'cli',
  model: 'm',
  provider: 'p',
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

describe('persistLoaded — read-merge-write into sessions.metadata', () => {
  let store: SQLiteSessionStore;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('merges loadedTools into existing metadata without clobbering other keys', async () => {
    const session = await store.createSession({
      ...baseSession,
      metadata: { title_source: 'auto', nested: { a: 1 } },
    });

    await persistLoaded(store, session.id, ['mcp__gh__list_issues']);
    await persistLoaded(store, session.id, ['mcp__gh__list_issues', 'mcp__gh__close_issue']);

    const reread = await store.getSession(session.id);
    expect(reread?.metadata).toEqual({
      title_source: 'auto',
      nested: { a: 1 },
      loadedTools: ['mcp__gh__list_issues', 'mcp__gh__close_issue'],
    });
  });

  it('works on a session that had no metadata, and a later writer keeps the loaded set', async () => {
    const session = await store.createSession(baseSession);
    await persistLoaded(store, session.id, ['b', 'a']);

    // Another writer doing its own read-merge-write keeps loadedTools intact.
    const current = await store.getSession(session.id);
    await store.updateSession(session.id, { metadata: { ...current?.metadata, other: true } });

    const reread = await store.getSession(session.id);
    expect(reread?.metadata).toEqual({ loadedTools: ['b', 'a'], other: true });
  });
});
