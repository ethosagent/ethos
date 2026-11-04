// plan incognito-sessions D11 — the MCP server never serves an incognito session.
import type { SearchResult, Session, SessionStore, StoredMessage } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { getMessages } from '../tools/get-messages';
import { getSession } from '../tools/get-session';
import { listSessions } from '../tools/list-sessions';
import { searchSessions } from '../tools/search-sessions';

const USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

function session(id: string, metadata?: Record<string, unknown>): Session {
  return {
    id,
    key: `cli:${id}`,
    platform: 'cli',
    model: 'm',
    provider: 'p',
    usage: USAGE,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...(metadata ? { metadata } : {}),
  };
}

const sessions = [session('plain'), session('secret', { incognito: true })];
const message: StoredMessage = {
  id: 'm1',
  sessionId: 'secret',
  role: 'user',
  content: 'private words',
  timestamp: new Date('2025-01-01T00:00:00Z'),
};

function hit(sessionId: string): SearchResult {
  return { sessionId, messageId: 'm1', snippet: 's', score: 1, timestamp: new Date() };
}

const store = {
  listSessions: async () => sessions,
  getSession: async (id: string) => sessions.find((s) => s.id === id) ?? null,
  getMessages: async () => [message],
  search: async () => [hit('plain'), hit('secret'), hit('gone')],
} as unknown as SessionStore;

describe('mcp-server incognito filter', () => {
  it('list_sessions skips incognito sessions', async () => {
    const out = (await listSessions(store, 20)) as { id: string }[];
    expect(out.map((s) => s.id)).toEqual(['plain']);
  });

  it('search_sessions skips incognito hits and hits with no session row', async () => {
    const out = (await searchSessions(store, 'q', 10)) as { sessionId: string }[];
    expect(out.map((r) => r.sessionId)).toEqual(['plain']);
  });

  it('get_messages refuses an incognito session and serves a normal one', async () => {
    const refused = await getMessages(store, 'secret', 10);
    expect(refused).toEqual({ error: expect.stringContaining('incognito') });
    expect(JSON.stringify(refused)).not.toContain('private words');
    expect(Array.isArray(await getMessages(store, 'plain', 10))).toBe(true);
  });

  it('get_session refuses an incognito session', async () => {
    const refused = await getSession(store, 'secret', 10);
    expect(refused).toEqual({ error: expect.stringContaining('incognito') });
    expect('session' in (await getSession(store, 'plain', 10))).toBe(true);
  });
});
