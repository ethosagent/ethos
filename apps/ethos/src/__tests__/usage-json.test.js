import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDuration } from '../commands/usage';
// ---------------------------------------------------------------------------
// parseDuration unit tests
// ---------------------------------------------------------------------------
describe('parseDuration', () => {
    it('parses hours correctly', () => {
        expect(parseDuration('24h')).toBe(86_400_000);
    });
    it('parses days correctly', () => {
        expect(parseDuration('7d')).toBe(604_800_000);
    });
    it('parses minutes correctly', () => {
        expect(parseDuration('30m')).toBe(1_800_000);
    });
    it('returns 0 for invalid format', () => {
        expect(parseDuration('invalid')).toBe(0);
    });
    it('returns 0 for zero hours', () => {
        expect(parseDuration('0h')).toBe(0);
    });
    it('returns 0 for missing unit', () => {
        expect(parseDuration('24')).toBe(0);
    });
    it('returns 0 for unsupported unit', () => {
        expect(parseDuration('2w')).toBe(0);
    });
    it('parses single-digit values', () => {
        expect(parseDuration('1h')).toBe(3_600_000);
        expect(parseDuration('1d')).toBe(86_400_000);
        expect(parseDuration('1m')).toBe(60_000);
    });
});
// ---------------------------------------------------------------------------
// Aggregation logic tests via SQLiteSessionStore
// ---------------------------------------------------------------------------
const baseUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
};
describe('ethos usage aggregation', () => {
    let store;
    beforeEach(() => {
        const dbPath = join(tmpdir(), `usage-test-${Date.now()}.db`);
        store = new SQLiteSessionStore(dbPath);
    });
    afterEach(() => {
        store.close();
    });
    it('listSessions with since filter returns only recent sessions', async () => {
        const now = new Date();
        const _old = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48h ago
        // Insert an old session manually — created_at is set via upsert
        await store.createSession({
            key: 'cli:old',
            platform: 'cli',
            model: 'claude-opus-4-7',
            provider: 'anthropic',
            usage: { ...baseUsage, inputTokens: 100, estimatedCostUsd: 0.01 },
        });
        // Insert a recent session
        await store.createSession({
            key: 'cli:recent',
            platform: 'cli',
            model: 'claude-sonnet-4-5',
            provider: 'anthropic',
            usage: { ...baseUsage, inputTokens: 200, estimatedCostUsd: 0.02 },
        });
        // Query with since = 1 hour ago — should see both since upsert sets created_at = now
        const since1h = new Date(now.getTime() - 60 * 60 * 1000);
        const results = await store.listSessions({ since: since1h, limit: 100 });
        expect(results.length).toBe(2);
    });
    it('aggregates tokens across sessions', async () => {
        await store.createSession({
            key: 'cli:a',
            platform: 'cli',
            model: 'claude-opus-4-7',
            provider: 'anthropic',
            usage: { ...baseUsage, inputTokens: 500, outputTokens: 100, estimatedCostUsd: 0.05 },
        });
        await store.createSession({
            key: 'cli:b',
            platform: 'cli',
            model: 'claude-opus-4-7',
            provider: 'anthropic',
            usage: { ...baseUsage, inputTokens: 300, outputTokens: 50, estimatedCostUsd: 0.03 },
        });
        const since = new Date(Date.now() - 60 * 60 * 1000);
        const sessions = await store.listSessions({ since, limit: 100 });
        const totalInput = sessions.reduce((acc, s) => acc + s.usage.inputTokens, 0);
        const totalOutput = sessions.reduce((acc, s) => acc + s.usage.outputTokens, 0);
        const totalCost = sessions.reduce((acc, s) => acc + s.usage.estimatedCostUsd, 0);
        expect(totalInput).toBe(800);
        expect(totalOutput).toBe(150);
        expect(Math.round(totalCost * 100) / 100).toBe(0.08);
    });
    it('groups sessions by provider and model', async () => {
        await store.createSession({
            key: 'cli:a',
            platform: 'cli',
            model: 'claude-opus-4-7',
            provider: 'anthropic',
            usage: { ...baseUsage, inputTokens: 100, estimatedCostUsd: 0.01 },
        });
        await store.createSession({
            key: 'cli:b',
            platform: 'cli',
            model: 'gpt-4o',
            provider: 'openai',
            usage: { ...baseUsage, inputTokens: 200, estimatedCostUsd: 0.02 },
        });
        const since = new Date(Date.now() - 60 * 60 * 1000);
        const sessions = await store.listSessions({ since, limit: 100 });
        const providerMap = new Map();
        for (const s of sessions) {
            const key = `${s.provider}:${s.model}`;
            providerMap.set(key, (providerMap.get(key) ?? 0) + s.usage.inputTokens);
        }
        expect(providerMap.get('anthropic:claude-opus-4-7')).toBe(100);
        expect(providerMap.get('openai:gpt-4o')).toBe(200);
    });
    it('groups sessions by personality', async () => {
        await store.createSession({
            key: 'cli:a',
            platform: 'cli',
            model: 'claude-opus-4-7',
            provider: 'anthropic',
            personalityId: 'hermes',
            usage: { ...baseUsage, apiCallCount: 3, estimatedCostUsd: 0.01 },
        });
        await store.createSession({
            key: 'cli:b',
            platform: 'cli',
            model: 'claude-opus-4-7',
            provider: 'anthropic',
            personalityId: 'ethos',
            usage: { ...baseUsage, apiCallCount: 5, estimatedCostUsd: 0.02 },
        });
        const since = new Date(Date.now() - 60 * 60 * 1000);
        const sessions = await store.listSessions({ since, limit: 100 });
        const personalityMap = new Map();
        for (const s of sessions) {
            const pid = s.personalityId ?? 'unknown';
            personalityMap.set(pid, (personalityMap.get(pid) ?? 0) + s.usage.apiCallCount);
        }
        expect(personalityMap.get('hermes')).toBe(3);
        expect(personalityMap.get('ethos')).toBe(5);
    });
});
