/**
 * Phase 3 team memory tests.
 *
 * Integration test: write via team_memory_write, read back via team_memory_read,
 * verify fact is present.
 *
 * Regression test: personality memory continues to work in the same session
 * (scopes are isolated).
 */
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { createMemoryReadTool, createMemoryWriteTool, createTeamMemoryReadTool, createTeamMemorySearchTool, createTeamMemoryWriteTool, } from '../index';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeCtx(overrides = {}) {
    return {
        sessionId: 'test-session',
        sessionKey: 'cli:test',
        platform: 'cli',
        workingDir: '/tmp',
        currentTurn: 1,
        messageCount: 1,
        abortSignal: new AbortController().signal,
        emit: () => { },
        resultBudgetChars: 80_000,
        ...overrides,
    };
}
// ---------------------------------------------------------------------------
// Integration test: write then read
// ---------------------------------------------------------------------------
describe('team memory — integration', () => {
    it('team_memory_write followed by team_memory_read returns the written fact', async () => {
        const storage = new InMemoryStorage();
        const teamMemory = new MarkdownFileMemoryProvider({
            dir: '/ethos/teams/alpha/memory',
            storage,
        });
        const writeTool = createTeamMemoryWriteTool(teamMemory);
        const readTool = createTeamMemoryReadTool(teamMemory);
        const ctx = makeCtx({ teamId: 'alpha', memoryScopeId: 'personality:tester' });
        const writeResult = await writeTool.execute({ action: 'add', key: 'architecture', content: 'We use a layered monorepo.' }, ctx);
        expect(writeResult.ok).toBe(true);
        const readResult = await readTool.execute({ key: 'architecture' }, ctx);
        expect(readResult.ok).toBe(true);
        expect('value' in readResult && readResult.value).toContain('layered monorepo');
    });
    it('two agents sharing the same team provider both see the written fact', async () => {
        const storage = new InMemoryStorage();
        // Both agents share the same dir — simulates same team session.
        const sharedTeamMemory = new MarkdownFileMemoryProvider({
            dir: '/ethos/teams/beta/memory',
            storage,
        });
        const writerCtx = makeCtx({ teamId: 'beta' });
        const readerCtx = makeCtx({ teamId: 'beta' });
        const writeTool = createTeamMemoryWriteTool(sharedTeamMemory);
        const readTool = createTeamMemoryReadTool(sharedTeamMemory);
        await writeTool.execute({ action: 'replace', key: 'decisions', content: 'We use TypeScript strict mode.' }, writerCtx);
        const result = await readTool.execute({ key: 'decisions' }, readerCtx);
        expect(result.ok).toBe(true);
        expect('value' in result && result.value).toContain('TypeScript strict mode');
    });
    it('team_memory_read with implicit .md suffix resolves the same file', async () => {
        const storage = new InMemoryStorage();
        const teamMemory = new MarkdownFileMemoryProvider({
            dir: '/ethos/teams/gamma/memory',
            storage,
        });
        const ctx = makeCtx({ teamId: 'gamma' });
        await createTeamMemoryWriteTool(teamMemory).execute({ action: 'add', key: 'onboarding.md', content: 'Read the ARCHITECTURE.md first.' }, ctx);
        // Read with key without extension — should resolve to onboarding.md
        const result = await createTeamMemoryReadTool(teamMemory).execute({ key: 'onboarding' }, ctx);
        expect(result.ok).toBe(true);
        expect('value' in result && result.value).toContain('ARCHITECTURE.md');
    });
    it('team_memory_search finds content by keyword', async () => {
        const storage = new InMemoryStorage();
        const teamMemory = new MarkdownFileMemoryProvider({
            dir: '/ethos/teams/delta/memory',
            storage,
        });
        const ctx = makeCtx({ teamId: 'delta' });
        await createTeamMemoryWriteTool(teamMemory).execute({
            action: 'add',
            key: 'gotchas',
            content: 'SQLite WAL mode is essential for concurrent readers.',
        }, ctx);
        await createTeamMemoryWriteTool(teamMemory).execute({ action: 'add', key: 'conventions', content: 'Use single quotes in all TypeScript files.' }, ctx);
        const result = await createTeamMemorySearchTool(teamMemory).execute({ query: 'SQLite' }, ctx);
        expect(result.ok).toBe(true);
        expect('value' in result && result.value).toContain('WAL mode');
        expect('value' in result && result.value).not.toContain('single quotes');
    });
});
// ---------------------------------------------------------------------------
// Security test: isSafeTopicKey rejects invalid keys
// ---------------------------------------------------------------------------
describe('team memory — key validation rejection', () => {
    const storage = new InMemoryStorage();
    const teamMemory = new MarkdownFileMemoryProvider({
        dir: '/ethos/teams/security-test/memory',
        storage,
    });
    const readTool = createTeamMemoryReadTool(teamMemory);
    const writeTool = createTeamMemoryWriteTool(teamMemory);
    const ctx = makeCtx({ teamId: 'security-test' });
    it('rejects empty string key', async () => {
        const result = await readTool.execute({ key: '' }, ctx);
        expect(result.ok).toBe(false);
        expect('error' in result && result.error).toMatch(/invalid|key/i);
    });
    it('rejects path traversal key: ../etc/passwd', async () => {
        const result = await readTool.execute({ key: '../etc/passwd' }, ctx);
        expect(result.ok).toBe(false);
        expect('error' in result && result.error).toMatch(/invalid/i);
    });
    it('rejects key with slash: foo/bar', async () => {
        const result = await writeTool.execute({ action: 'add', key: 'foo/bar', content: 'x' }, ctx);
        expect(result.ok).toBe(false);
        expect('error' in result && result.error).toMatch(/invalid/i);
    });
    it('rejects key with null byte: foo\\x00bar', async () => {
        const result = await readTool.execute({ key: 'foo\x00bar' }, ctx);
        expect(result.ok).toBe(false);
        expect('error' in result && result.error).toMatch(/invalid/i);
    });
    it('rejects key with dot in the middle: foo.bar', async () => {
        // foo.bar has no .md suffix; stripped stays foo.bar — dot is not in [a-zA-Z0-9_-]
        const result = await readTool.execute({ key: 'foo.bar' }, ctx);
        expect(result.ok).toBe(false);
        expect('error' in result && result.error).toMatch(/invalid/i);
    });
});
// ---------------------------------------------------------------------------
// Regression test: personality memory still works alongside team memory
// ---------------------------------------------------------------------------
describe('team memory — regression: personality memory isolation', () => {
    it('personality memory is unaffected when team memory is also written', async () => {
        // Simulate what production wiring does: two separate providers, same session.
        const personalityStorage = new InMemoryStorage();
        const teamStorage = new InMemoryStorage();
        const personalityMemory = new MarkdownFileMemoryProvider({
            dir: '/ethos/personalities/engineer',
            storage: personalityStorage,
        });
        const teamMemory = new MarkdownFileMemoryProvider({
            dir: '/ethos/teams/alpha/memory',
            storage: teamStorage,
        });
        const ctx = makeCtx({ teamId: 'alpha', memoryScopeId: 'personality:engineer' });
        // Write to both scopes.
        const personalityWriteTool = createMemoryWriteTool(personalityMemory);
        const teamWriteTool = createTeamMemoryWriteTool(teamMemory);
        await personalityWriteTool.execute({ store: 'memory', action: 'add', content: 'Personality fact: refactored memory system.' }, ctx);
        await teamWriteTool.execute({ action: 'add', key: 'architecture', content: 'Team fact: shared kanban board.' }, ctx);
        // Read personality memory — must only see personality fact.
        const personalityReadTool = createMemoryReadTool(personalityMemory);
        const personalityResult = await personalityReadTool.execute({ store: 'memory' }, ctx);
        expect(personalityResult.ok).toBe(true);
        const personalityText = 'value' in personalityResult ? personalityResult.value : '';
        expect(personalityText).toContain('Personality fact');
        expect(personalityText).not.toContain('Team fact');
        // Read team memory — must only see team fact.
        const teamReadTool = createTeamMemoryReadTool(teamMemory);
        const teamResult = await teamReadTool.execute({ key: 'architecture' }, ctx);
        expect(teamResult.ok).toBe(true);
        const teamText = 'value' in teamResult ? teamResult.value : '';
        expect(teamText).toContain('Team fact');
        expect(teamText).not.toContain('Personality fact');
    });
    it('team memory tool returns not_available when no teamId in context', async () => {
        const storage = new InMemoryStorage();
        const teamMemory = new MarkdownFileMemoryProvider({ dir: '/ethos/teams/solo/memory', storage });
        // Simulate solo session: ctx has no teamId.
        const ctx = makeCtx({ teamId: undefined, memoryScopeId: 'personality:solo' });
        const result = await createTeamMemoryReadTool(teamMemory).execute({ key: 'decisions' }, ctx);
        expect(result.ok).toBe(false);
        expect('code' in result && result.code).toBe('not_available');
    });
});
