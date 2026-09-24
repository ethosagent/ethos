// openclaw-9.5-adoption item 7 — a provider-side compaction row in sessions.db:
// the structural marker and the encrypted payload survive a reload, while the
// FTS index (which covers `content` only) sees the readable marker and summary
// and never the encrypted blob.

import { COMPACTION_MARKER, compactionFromStoredRow, compactionStoredRow } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteSessionStore } from '../index';

const baseSession = {
  key: 'cli:compaction',
  platform: 'cli',
  model: 'claude-sonnet-4-5',
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

const block = {
  content: 'the user wants a scraper with rate limiting',
  encryptedContent: 'zzqopaquepayloadtoken EqQBCkgIARAB==',
};

describe('compaction row in sessions.db', () => {
  let store: SQLiteSessionStore;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('round-trips the block and shows the readable marker as content', async () => {
    const session = await store.createSession(baseSession);
    await store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      ...compactionStoredRow(block),
    });
    const [row] = await store.getMessages(session.id);
    expect(row?.content.startsWith(COMPACTION_MARKER)).toBe(true);
    expect(row?.content).not.toContain('zzqopaquepayloadtoken');
    expect(row ? compactionFromStoredRow(row) : null).toEqual(block);
  });

  it('full-text search finds the summary but never the encrypted payload', async () => {
    const session = await store.createSession(baseSession);
    await store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      ...compactionStoredRow(block),
    });
    expect(await store.search('zzqopaquepayloadtoken')).toHaveLength(0);
    const hits = await store.search('scraper');
    expect(hits).toHaveLength(1);
    expect(JSON.stringify(hits)).not.toContain('zzqopaquepayloadtoken');
  });
});
