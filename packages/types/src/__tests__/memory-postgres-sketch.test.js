/**
 * Cross-phase verification: Adding a hypothetical third backend
 * (MemoryPostgresProvider) requires only implementing the contract —
 * no changes to agent code, tools, or wiring beyond the config switch.
 *
 * This test sketches a Postgres-backed provider using an in-memory Map
 * as the backing store (not a real database). It asserts that implementing
 * the MemoryProvider interface requires zero changes outside the new class.
 */
import { describe, expect, it } from 'vitest';
/**
 * Sketch implementation of a Postgres-backed memory provider.
 * Uses an in-memory Map to simulate the backing store (compile-time proof).
 */
class MemoryPostgresProvider {
    store = new Map();
    async prefetch(ctx) {
        const scopeStore = this.store.get(ctx.scopeId);
        if (!scopeStore || scopeStore.size === 0) {
            return null;
        }
        const entries = Array.from(scopeStore.entries()).map(([key, content]) => ({
            key,
            content,
        }));
        return { entries };
    }
    async read(key, ctx) {
        let scopeStore = this.store.get(ctx.scopeId);
        if (!scopeStore) {
            scopeStore = new Map();
            this.store.set(ctx.scopeId, scopeStore);
        }
        const content = scopeStore.get(key);
        if (content === undefined) {
            return null;
        }
        return {
            key,
            content,
            metadata: {
                lastUpdatedAt: Date.now(),
                lastUpdatedBy: ctx.sessionId,
            },
        };
    }
    async search(query, ctx, _opts) {
        const scopeStore = this.store.get(ctx.scopeId);
        if (!scopeStore) {
            return [];
        }
        const results = [];
        const lowerQuery = query.toLowerCase();
        for (const [key, content] of scopeStore.entries()) {
            if (content.toLowerCase().includes(lowerQuery) || key.toLowerCase().includes(lowerQuery)) {
                results.push({
                    key,
                    content,
                    metadata: {
                        lastUpdatedAt: Date.now(),
                        lastUpdatedBy: ctx.sessionId,
                    },
                });
            }
        }
        return results;
    }
    async sync(updates, ctx) {
        let scopeStore = this.store.get(ctx.scopeId);
        if (!scopeStore) {
            scopeStore = new Map();
            this.store.set(ctx.scopeId, scopeStore);
        }
        for (const update of updates) {
            switch (update.action) {
                case 'add': {
                    const current = scopeStore.get(update.key) ?? '';
                    scopeStore.set(update.key, current ? current + update.content : update.content);
                    break;
                }
                case 'replace': {
                    scopeStore.set(update.key, update.content);
                    break;
                }
                case 'remove': {
                    const current = scopeStore.get(update.key);
                    if (current) {
                        const lines = current.split('\n');
                        const filtered = lines
                            .filter((line) => !line.includes(update.substringMatch))
                            .join('\n');
                        scopeStore.set(update.key, filtered);
                    }
                    break;
                }
                case 'delete': {
                    scopeStore.delete(update.key);
                    break;
                }
            }
        }
    }
    async list(ctx, _opts) {
        const scopeStore = this.store.get(ctx.scopeId);
        if (!scopeStore) {
            return [];
        }
        return Array.from(scopeStore.keys()).map((key) => ({
            key,
            metadata: {
                lastUpdatedAt: Date.now(),
            },
        }));
    }
}
describe('MemoryPostgresProvider sketch', () => {
    it('implements the MemoryProvider interface without external dependencies', () => {
        // Type assignability check: MemoryPostgresProvider satisfies MemoryProvider.
        const provider = new MemoryPostgresProvider();
        expect(provider).toBeDefined();
    });
    it('executes all five contract methods without error', async () => {
        const provider = new MemoryPostgresProvider();
        const ctx = {
            scopeId: 'test:scope',
            sessionId: 'test-session',
            sessionKey: 'test-key',
            platform: 'test',
            workingDir: '/tmp',
        };
        // prefetch (empty scope)
        const empty = await provider.prefetch(ctx);
        expect(empty).toBeNull();
        // sync: add
        await provider.sync([{ action: 'add', key: 'test', content: 'hello' }], ctx);
        // read
        const entry = await provider.read('test', ctx);
        expect(entry).toEqual({
            key: 'test',
            content: 'hello',
            metadata: expect.objectContaining({
                lastUpdatedBy: ctx.sessionId,
            }),
        });
        // search
        const results = await provider.search('hello', ctx);
        expect(results).toHaveLength(1);
        expect(results[0].key).toBe('test');
        // list
        const refs = await provider.list(ctx);
        expect(refs).toHaveLength(1);
        expect(refs[0].key).toBe('test');
        // prefetch (non-empty scope)
        const snapshot = await provider.prefetch(ctx);
        expect(snapshot).toEqual({
            entries: [{ key: 'test', content: 'hello' }],
        });
    });
});
