import { describe, expect, it } from 'vitest';
import { getMessages } from '../tools/get-messages';
import { getSession } from '../tools/get-session';
import { listSessions } from '../tools/list-sessions';
import { searchSessions } from '../tools/search-sessions';
// ---------------------------------------------------------------------------
// Mock session store
// ---------------------------------------------------------------------------
function makeSession(overrides = {}) {
    return {
        id: 'sess-1',
        key: 'cli:test',
        platform: 'cli',
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        title: 'Test session',
        usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            estimatedCostUsd: 0.01,
            apiCallCount: 1,
            compactionCount: 0,
        },
        createdAt: new Date('2025-01-01T00:00:00Z'),
        updatedAt: new Date('2025-01-01T01:00:00Z'),
        ...overrides,
    };
}
function makeMessage(overrides = {}) {
    return {
        id: 'msg-1',
        sessionId: 'sess-1',
        role: 'user',
        content: 'Hello world',
        timestamp: new Date('2025-01-01T00:00:00Z'),
        ...overrides,
    };
}
function createMockStore(options) {
    const sessions = options?.sessions ?? [makeSession()];
    const messages = options?.messages ?? [makeMessage()];
    const searchResults = options?.searchResults ?? [];
    return {
        createSession: async () => sessions[0] ?? makeSession(),
        getSession: async (id) => sessions.find((s) => s.id === id) ?? null,
        getSessionByKey: async () => null,
        updateSession: async () => { },
        deleteSession: async () => { },
        listSessions: async (filter) => {
            const since = filter?.since;
            const result = since ? sessions.filter((s) => s.createdAt >= since) : sessions;
            const limit = filter?.limit ?? result.length;
            return result.slice(0, limit);
        },
        appendMessage: async () => messages[0] ?? makeMessage(),
        getMessages: async (sessionId, opts) => {
            const filtered = messages.filter((m) => m.sessionId === sessionId);
            const limit = opts?.limit ?? filtered.length;
            return filtered.slice(0, limit);
        },
        updateUsage: async () => { },
        search: async (_query, opts) => {
            const limit = opts?.limit ?? searchResults.length;
            let filtered = searchResults;
            const since = opts?.since;
            if (since) {
                filtered = filtered.filter((r) => r.timestamp >= since);
            }
            const until = opts?.until;
            if (until) {
                filtered = filtered.filter((r) => r.timestamp <= until);
            }
            return filtered.slice(0, limit);
        },
        recordCompression: async () => ({
            id: 'comp-1',
            sessionId: 'sess-1',
            createdAt: new Date(),
            engineName: 'test',
            originalCount: 10,
            keptCount: 5,
            summaryTokens: 100,
            preTotalTokens: 1000,
            postTotalTokens: 500,
            durationMs: 100,
        }),
        listCompressions: async () => [],
        recordTurnStart: async () => ({ turnNumber: 1, lastCompactionTurn: 0 }),
        recordCompactionTurn: async () => { },
        pruneOldSessions: async () => 0,
        vacuum: async () => { },
    };
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('list_sessions', () => {
    it('returns sessions with serialised dates', async () => {
        const store = createMockStore();
        const result = await listSessions(store, 20);
        expect(result).toHaveLength(1);
        const first = result[0];
        expect(first.id).toBe('sess-1');
        expect(first.createdAt).toBe('2025-01-01T00:00:00.000Z');
        expect(first.updatedAt).toBe('2025-01-01T01:00:00.000Z');
    });
    it('respects limit', async () => {
        const sessions = [
            makeSession({ id: 'sess-1' }),
            makeSession({ id: 'sess-2' }),
            makeSession({ id: 'sess-3' }),
        ];
        const store = createMockStore({ sessions });
        const result = await listSessions(store, 2);
        expect(result).toHaveLength(2);
    });
    it('filters by since date', async () => {
        const sessions = [
            makeSession({ id: 'sess-old', createdAt: new Date('2025-01-01T00:00:00Z') }),
            makeSession({ id: 'sess-new', createdAt: new Date('2025-06-01T00:00:00Z') }),
        ];
        const store = createMockStore({ sessions });
        const result = await listSessions(store, 20, '2025-03-01');
        expect(result).toHaveLength(1);
        const first = result[0];
        expect(first.id).toBe('sess-new');
    });
    it('ignores invalid since value', async () => {
        const store = createMockStore();
        const result = await listSessions(store, 20, 'not-a-date');
        expect(result).toHaveLength(1);
    });
});
describe('get_session', () => {
    it('returns session with messages', async () => {
        const messages = [
            makeMessage({ id: 'msg-1', content: 'Hello' }),
            makeMessage({ id: 'msg-2', role: 'assistant', content: 'Hi there' }),
        ];
        const store = createMockStore({ messages });
        const result = await getSession(store, 'sess-1', 50);
        expect('error' in result).toBe(false);
        if (!('error' in result)) {
            expect(result.session.id).toBe('sess-1');
            expect(result.messages).toHaveLength(2);
        }
    });
    it('returns error for missing session', async () => {
        const store = createMockStore();
        const result = await getSession(store, 'nonexistent', 50);
        expect('error' in result).toBe(true);
        if ('error' in result) {
            expect(result.error).toContain('not found');
        }
    });
});
describe('get_messages', () => {
    it('returns messages for a session', async () => {
        const messages = [
            makeMessage({ id: 'msg-1', content: 'Hello' }),
            makeMessage({ id: 'msg-2', role: 'assistant', content: 'Hi' }),
        ];
        const store = createMockStore({ messages });
        const result = await getMessages(store, 'sess-1', 50);
        expect(result).toHaveLength(2);
        const first = result[0];
        expect(first.content).toBe('Hello');
        expect(first.timestamp).toBe('2025-01-01T00:00:00.000Z');
    });
    it('returns empty array for unknown session', async () => {
        const store = createMockStore();
        const result = await getMessages(store, 'unknown', 50);
        expect(result).toEqual([]);
    });
});
describe('search_sessions', () => {
    it('returns search results with serialised timestamps', async () => {
        const searchResults = [
            {
                sessionId: 'sess-1',
                messageId: 'msg-1',
                snippet: 'found the keyword here',
                score: 0.95,
                timestamp: new Date('2025-01-01T00:30:00Z'),
            },
        ];
        const store = createMockStore({ searchResults });
        const result = await searchSessions(store, 'keyword', 10);
        expect(result).toHaveLength(1);
        const first = result[0];
        expect(first.snippet).toContain('keyword');
        expect(first.timestamp).toBe('2025-01-01T00:30:00.000Z');
        expect(first.score).toBe(0.95);
    });
    it('returns empty array when no matches', async () => {
        const store = createMockStore({ searchResults: [] });
        const result = await searchSessions(store, 'nonexistent', 10);
        expect(result).toEqual([]);
    });
    it('respects limit', async () => {
        const searchResults = [
            {
                sessionId: 'sess-1',
                messageId: 'msg-1',
                snippet: 'one',
                score: 0.9,
                timestamp: new Date(),
            },
            {
                sessionId: 'sess-1',
                messageId: 'msg-2',
                snippet: 'two',
                score: 0.8,
                timestamp: new Date(),
            },
            {
                sessionId: 'sess-1',
                messageId: 'msg-3',
                snippet: 'three',
                score: 0.7,
                timestamp: new Date(),
            },
        ];
        const store = createMockStore({ searchResults });
        const result = await searchSessions(store, 'test', 2);
        expect(result).toHaveLength(2);
    });
    it('filters results by since bound', async () => {
        const searchResults = [
            {
                sessionId: 'sess-1',
                messageId: 'msg-1',
                snippet: 'old message',
                score: 0.9,
                timestamp: new Date('2025-01-01T00:00:00Z'),
            },
            {
                sessionId: 'sess-1',
                messageId: 'msg-2',
                snippet: 'new message',
                score: 0.8,
                timestamp: new Date('2025-06-01T00:00:00Z'),
            },
        ];
        const store = createMockStore({ searchResults });
        const result = await searchSessions(store, 'message', 10, '2025-03-01');
        expect(result).toHaveLength(1);
        const first = result[0];
        expect(first.snippet).toBe('new message');
    });
    it('filters results by until bound', async () => {
        const searchResults = [
            {
                sessionId: 'sess-1',
                messageId: 'msg-1',
                snippet: 'old message',
                score: 0.9,
                timestamp: new Date('2025-01-01T00:00:00Z'),
            },
            {
                sessionId: 'sess-1',
                messageId: 'msg-2',
                snippet: 'new message',
                score: 0.8,
                timestamp: new Date('2025-06-01T00:00:00Z'),
            },
        ];
        const store = createMockStore({ searchResults });
        const result = await searchSessions(store, 'message', 10, undefined, '2025-03-01');
        expect(result).toHaveLength(1);
        const first = result[0];
        expect(first.snippet).toBe('old message');
    });
    it('ignores invalid date strings', async () => {
        const searchResults = [
            {
                sessionId: 'sess-1',
                messageId: 'msg-1',
                snippet: 'a result',
                score: 0.9,
                timestamp: new Date('2025-01-01T00:00:00Z'),
            },
        ];
        const store = createMockStore({ searchResults });
        const result = await searchSessions(store, 'result', 10, 'not-a-date', 'also-bad');
        expect(result).toHaveLength(1);
    });
});
