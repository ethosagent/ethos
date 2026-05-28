import { describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '../in-memory-session';
const baseSession = {
    key: 'test:default',
    platform: 'test',
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
describe('InMemorySessionStore', () => {
    it('creates and retrieves a session by id', async () => {
        const store = new InMemorySessionStore();
        const session = await store.createSession(baseSession);
        expect(session.id).toBeTruthy();
        expect(session.key).toBe('test:default');
        expect(session.createdAt).toBeInstanceOf(Date);
        const found = await store.getSession(session.id);
        expect(found?.id).toBe(session.id);
        expect(found?.platform).toBe('test');
    });
    // -------------------------------------------------------------------------
    // Temporal search bounds
    // -------------------------------------------------------------------------
    it('search filters by `since` bound (inclusive)', async () => {
        const store = new InMemorySessionStore();
        const session = await store.createSession(baseSession);
        // Append an old message and manually backdate its timestamp
        const old = await store.appendMessage({
            sessionId: session.id,
            role: 'user',
            content: 'old quantum note',
        });
        old.timestamp = new Date(Date.now() - 10 * 86_400_000); // 10 days ago
        // Append a recent message
        await store.appendMessage({
            sessionId: session.id,
            role: 'user',
            content: 'recent quantum note',
        });
        // Search with since cutoff of 1 day ago
        const cutoff = new Date(Date.now() - 86_400_000);
        const results = await store.search('quantum', { since: cutoff });
        expect(results.every((r) => r.timestamp >= cutoff)).toBe(true);
        expect(results.some((r) => r.messageId === old.id)).toBe(false);
    });
    it('search filters by `until` bound (inclusive)', async () => {
        const store = new InMemorySessionStore();
        const session = await store.createSession(baseSession);
        // Append a recent message
        await store.appendMessage({
            sessionId: session.id,
            role: 'user',
            content: 'fresh quantum note',
        });
        // Append a future message and manually set its timestamp
        const future = await store.appendMessage({
            sessionId: session.id,
            role: 'user',
            content: 'future quantum note',
        });
        future.timestamp = new Date('2099-01-01T00:00:00.000Z');
        // Search with until cutoff in 2030
        const until = new Date('2030-01-01T00:00:00.000Z');
        const results = await store.search('quantum', { until });
        expect(results.every((r) => r.timestamp <= until)).toBe(true);
        expect(results.some((r) => r.messageId === future.id)).toBe(false);
    });
    it('search composes since + until + sessionId', async () => {
        const store = new InMemorySessionStore();
        const s1 = await store.createSession({ ...baseSession, key: 'k1' });
        const s2 = await store.createSession({ ...baseSession, key: 'k2' });
        // Create in-range message in s1
        await store.appendMessage({
            sessionId: s1.id,
            role: 'user',
            content: 'in-range quantum note',
        });
        // Create message in wrong session
        await store.appendMessage({
            sessionId: s2.id,
            role: 'user',
            content: 'wrong-session quantum note',
        });
        const results = await store.search('quantum', {
            sessionId: s1.id,
            since: new Date(Date.now() - 60_000),
            until: new Date(Date.now() + 60_000),
        });
        // All results should be from s1
        expect(results.every((r) => r.sessionId === s1.id)).toBe(true);
        // No results from s2
        expect(results.every((r) => r.sessionId !== s2.id)).toBe(true);
    });
});
