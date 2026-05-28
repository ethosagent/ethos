import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { MarkdownFileMemoryProvider } from '../index';
function makeCtx(scopeId) {
    return {
        scopeId,
        sessionId: 'test',
        sessionKey: 'cli:test',
        platform: 'cli',
        workingDir: '/tmp',
    };
}
describe('MarkdownFileMemoryProvider — scope isolation', () => {
    it('a single provider with two different scopeIds has fully isolated stores (mirrors production topology)', async () => {
        const storage = new InMemoryStorage();
        const provider = new MarkdownFileMemoryProvider({ dir: '/ethos', storage });
        const ctxA = makeCtx('personality:alpha');
        const ctxB = makeCtx('personality:beta');
        await provider.sync([{ action: 'add', key: 'MEMORY.md', content: 'Alpha fact.' }], ctxA);
        await provider.sync([{ action: 'add', key: 'MEMORY.md', content: 'Beta fact.' }], ctxB);
        const snapshotA = await provider.prefetch(ctxA);
        const snapshotB = await provider.prefetch(ctxB);
        const allA = snapshotA?.entries.map((e) => e.content).join('\n') ?? '';
        const allB = snapshotB?.entries.map((e) => e.content).join('\n') ?? '';
        expect(allA).toContain('Alpha fact.');
        expect(allA).not.toContain('Beta fact.');
        expect(allB).toContain('Beta fact.');
        expect(allB).not.toContain('Alpha fact.');
    });
    it('a write to one scope is invisible to a read in the other scope', async () => {
        const storage = new InMemoryStorage();
        const provider = new MarkdownFileMemoryProvider({ dir: '/ethos', storage });
        const ctxA = makeCtx('personality:alpha');
        const ctxB = makeCtx('personality:beta');
        await provider.sync([{ action: 'replace', key: 'MEMORY.md', content: 'Alpha only.' }], ctxA);
        const entry = await provider.read('MEMORY.md', ctxB);
        expect(entry).toBeNull();
    });
    it('USER.md is scoped per-personality (no longer shared across scopes)', async () => {
        const storage = new InMemoryStorage();
        const provider = new MarkdownFileMemoryProvider({ dir: '/ethos', storage });
        const ctxA = makeCtx('personality:alpha');
        const ctxB = makeCtx('personality:beta');
        await provider.sync([{ action: 'replace', key: 'USER.md', content: 'Alpha user info.' }], ctxA);
        const entryA = await provider.read('USER.md', ctxA);
        expect(entryA?.content).toContain('Alpha user info.');
        const entryB = await provider.read('USER.md', ctxB);
        expect(entryB).toBeNull();
    });
    it('user:<userId> scope stores USER.md in users/<userId>/', async () => {
        const storage = new InMemoryStorage();
        const provider = new MarkdownFileMemoryProvider({ dir: '/ethos', storage });
        const userCtx = makeCtx('user:abc123');
        await provider.sync([{ action: 'replace', key: 'USER.md', content: 'Per-user profile.' }], userCtx);
        const entry = await provider.read('USER.md', userCtx);
        expect(entry?.content).toContain('Per-user profile.');
    });
});
