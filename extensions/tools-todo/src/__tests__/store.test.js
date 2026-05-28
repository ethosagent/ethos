import { describe, expect, it } from 'vitest';
import { InMemoryTodoStore, MultipleInProgressError, TodoNotFoundError } from '../store';
describe('InMemoryTodoStore', () => {
    describe('set / add / update / clear round-trip', () => {
        it('set returns ids starting at t1', async () => {
            const store = new InMemoryTodoStore();
            const result = await store.set('cli:sess', [
                { content: 'Plan refactor', activeForm: 'Planning refactor' },
                { content: 'Run tests', activeForm: 'Running tests' },
            ]);
            expect(result).toEqual({ count: 2, ids: ['t1', 't2'] });
        });
        it('add appends after set and continues the id counter', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [{ content: 'A', activeForm: 'A' }]);
            const { id } = await store.add('s', { content: 'B', activeForm: 'B' });
            expect(id).toBe('t2');
            expect(store.list('s', 'all').map((i) => i.id)).toEqual(['t1', 't2']);
        });
        it('update can patch status / content / activeForm / notes independently', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [{ content: 'A', activeForm: 'Aing' }]);
            await store.update('s', 't1', { status: 'in_progress' });
            let item = store.list('s', 'all')[0];
            expect(item?.status).toBe('in_progress');
            expect(item?.content).toBe('A');
            await store.update('s', 't1', { content: 'A renamed' });
            item = store.list('s', 'all')[0];
            expect(item?.status).toBe('in_progress'); // unchanged
            expect(item?.content).toBe('A renamed');
        });
        it('update with undefined fields leaves them unchanged', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [{ content: 'A', activeForm: 'Aing' }]);
            await store.update('s', 't1', { notes: 'hello' });
            await store.update('s', 't1', { status: 'in_progress' }); // notes omitted
            expect(store.list('s', 'all')[0]?.notes).toBe('hello');
        });
        it('clear empties the list and reports the count cleared', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [
                { content: 'A', activeForm: 'A' },
                { content: 'B', activeForm: 'B' },
            ]);
            const cleared = await store.clear('s');
            expect(cleared).toEqual({ cleared: 2 });
            expect(store.list('s', 'all')).toEqual([]);
        });
    });
    describe('session isolation', () => {
        it('two sessionKeys do not bleed into each other', async () => {
            const store = new InMemoryTodoStore();
            await store.set('alpha', [{ content: 'A', activeForm: 'A' }]);
            await store.set('beta', [{ content: 'B', activeForm: 'B' }]);
            expect(store.list('alpha', 'all').map((i) => i.content)).toEqual(['A']);
            expect(store.list('beta', 'all').map((i) => i.content)).toEqual(['B']);
        });
    });
    describe('id counter', () => {
        it('starts at t1 for a fresh session', async () => {
            const store = new InMemoryTodoStore();
            const { id } = await store.add('s', { content: 'A', activeForm: 'A' });
            expect(id).toBe('t1');
        });
        it('resets to t1 on todo_set (start-over operation)', async () => {
            const store = new InMemoryTodoStore();
            await store.add('s', { content: 'A', activeForm: 'A' });
            await store.add('s', { content: 'B', activeForm: 'B' }); // t2
            const result = await store.set('s', [{ content: 'C', activeForm: 'C' }]);
            expect(result.ids).toEqual(['t1']);
        });
        it('resets to t1 on todo_clear (start-over operation)', async () => {
            const store = new InMemoryTodoStore();
            await store.add('s', { content: 'A', activeForm: 'A' });
            await store.add('s', { content: 'B', activeForm: 'B' }); // t2
            await store.clear('s');
            const { id } = await store.add('s', { content: 'C', activeForm: 'C' });
            expect(id).toBe('t1');
        });
    });
    describe('LRU eviction', () => {
        it('drops the oldest session when capacity is exceeded', async () => {
            const store = new InMemoryTodoStore({ maxSessions: 2 });
            await store.set('a', [{ content: 'A', activeForm: 'A' }]);
            await store.set('b', [{ content: 'B', activeForm: 'B' }]);
            await store.set('c', [{ content: 'C', activeForm: 'C' }]); // evicts 'a'
            expect(store.list('a', 'all')).toEqual([]); // gone
            expect(store.list('b', 'all').map((i) => i.content)).toEqual(['B']);
            expect(store.list('c', 'all').map((i) => i.content)).toEqual(['C']);
        });
        it('default cap is 16 — 17th session evicts the first', async () => {
            const store = new InMemoryTodoStore();
            for (let i = 0; i < 16; i++) {
                await store.set(`s${i}`, [{ content: `T${i}`, activeForm: `T${i}` }]);
            }
            await store.set('s16', [{ content: 'T16', activeForm: 'T16' }]); // 17th key
            expect(store.list('s0', 'all')).toEqual([]); // evicted
            expect(store.list('s16', 'all').map((i) => i.content)).toEqual(['T16']);
        });
    });
    describe('per-session mutex', () => {
        it('serializes two parallel adds so both items land with distinct ids', async () => {
            const store = new InMemoryTodoStore();
            const [a, b] = await Promise.all([
                store.add('s', { content: 'A', activeForm: 'A' }),
                store.add('s', { content: 'B', activeForm: 'B' }),
            ]);
            expect(a.id).not.toBe(b.id);
            expect(store.list('s', 'all')).toHaveLength(2);
            const ids = store.list('s', 'all').map((i) => i.id);
            expect(new Set(ids).size).toBe(2);
        });
        it('a failing update does not poison subsequent operations on the same session', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [{ content: 'A', activeForm: 'A' }]);
            await store.update('s', 't1', { status: 'in_progress' });
            // Reject — t1 already in_progress
            const blocked = store.add('s', { content: 'B', activeForm: 'B' }).then(async (added) => {
                return store.update('s', added.id, { status: 'in_progress' });
            });
            await expect(blocked).rejects.toBeInstanceOf(MultipleInProgressError);
            // Recovery — chain still works for the next op.
            const next = await store.add('s', { content: 'C', activeForm: 'C' });
            expect(next.id).toBe('t3');
        });
    });
    describe('in_progress invariant', () => {
        it('rejects a second in_progress with MultipleInProgressError', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [
                { content: 'A', activeForm: 'A' },
                { content: 'B', activeForm: 'B' },
            ]);
            await store.update('s', 't1', { status: 'in_progress' });
            await expect(store.update('s', 't2', { status: 'in_progress' })).rejects.toBeInstanceOf(MultipleInProgressError);
        });
        it('flipping the already-in_progress task to in_progress is a no-op (no error)', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [{ content: 'A', activeForm: 'A' }]);
            await store.update('s', 't1', { status: 'in_progress' });
            const result = await store.update('s', 't1', { status: 'in_progress' });
            expect(result).toEqual({ ok: true });
        });
        it('records completed_at when status flips to completed', async () => {
            const store = new InMemoryTodoStore({ now: () => '2026-05-11T00:00:00.000Z' });
            await store.set('s', [{ content: 'A', activeForm: 'A' }]);
            await store.update('s', 't1', { status: 'completed' });
            expect(store.list('s', 'all')[0]?.completed_at).toBe('2026-05-11T00:00:00.000Z');
        });
        it('clears completed_at when flipped back to pending', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [{ content: 'A', activeForm: 'A' }]);
            await store.update('s', 't1', { status: 'completed' });
            await store.update('s', 't1', { status: 'pending' });
            expect(store.list('s', 'all')[0]?.completed_at).toBeUndefined();
        });
    });
    describe('list filter', () => {
        it('default "open" excludes completed', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [
                { content: 'A', activeForm: 'A' },
                { content: 'B', activeForm: 'B' },
            ]);
            await store.update('s', 't2', { status: 'completed' });
            expect(store.list('s').map((i) => i.id)).toEqual(['t1']);
        });
        it('"all" returns everything', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [
                { content: 'A', activeForm: 'A' },
                { content: 'B', activeForm: 'B' },
            ]);
            await store.update('s', 't2', { status: 'completed' });
            expect(store.list('s', 'all').map((i) => i.id)).toEqual(['t1', 't2']);
        });
        it('specific status filter returns only that status', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [
                { content: 'A', activeForm: 'A' },
                { content: 'B', activeForm: 'B' },
                { content: 'C', activeForm: 'C' },
            ]);
            await store.update('s', 't1', { status: 'in_progress' });
            await store.update('s', 't2', { status: 'completed' });
            expect(store.list('s', 'in_progress').map((i) => i.id)).toEqual(['t1']);
            expect(store.list('s', 'completed').map((i) => i.id)).toEqual(['t2']);
            expect(store.list('s', 'pending').map((i) => i.id)).toEqual(['t3']);
        });
    });
    describe('add position', () => {
        it('default is "end"', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [{ content: 'A', activeForm: 'A' }]);
            await store.add('s', { content: 'B', activeForm: 'B' });
            expect(store.list('s', 'all').map((i) => i.content)).toEqual(['A', 'B']);
        });
        it('"start" prepends', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [{ content: 'A', activeForm: 'A' }]);
            await store.add('s', { content: 'Z', activeForm: 'Z', position: 'start' });
            expect(store.list('s', 'all').map((i) => i.content)).toEqual(['Z', 'A']);
        });
        it('numeric position inserts at index', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [
                { content: 'A', activeForm: 'A' },
                { content: 'C', activeForm: 'C' },
            ]);
            await store.add('s', { content: 'B', activeForm: 'B', position: 1 });
            expect(store.list('s', 'all').map((i) => i.content)).toEqual(['A', 'B', 'C']);
        });
        it('clamps out-of-range numeric position to [0, len]', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [
                { content: 'A', activeForm: 'A' },
                { content: 'B', activeForm: 'B' },
            ]);
            await store.add('s', { content: 'Z', activeForm: 'Z', position: -10 });
            await store.add('s', { content: 'END', activeForm: 'END', position: 999 });
            expect(store.list('s', 'all').map((i) => i.content)).toEqual(['Z', 'A', 'B', 'END']);
        });
    });
    describe('notes', () => {
        it('round-trips notes up to 500 chars verbatim', async () => {
            const store = new InMemoryTodoStore();
            const fivehundred = 'x'.repeat(500);
            const result = await store.add('s', {
                content: 'A',
                activeForm: 'A',
                notes: fivehundred,
            });
            expect(result.notes_truncated).toBeUndefined();
            expect(store.list('s', 'all')[0]?.notes).toBe(fivehundred);
        });
        it('truncates notes longer than 500 chars with `…` and surfaces notes_truncated', async () => {
            const store = new InMemoryTodoStore();
            const longNote = 'x'.repeat(600);
            const result = await store.add('s', {
                content: 'A',
                activeForm: 'A',
                notes: longNote,
            });
            expect(result.notes_truncated).toBe(true);
            const stored = store.list('s', 'all')[0]?.notes;
            expect(stored).toHaveLength(500);
            expect(stored?.endsWith('…')).toBe(true);
        });
        it('todo_update also truncates + flags notes_truncated', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [{ content: 'A', activeForm: 'A' }]);
            const result = await store.update('s', 't1', { notes: 'x'.repeat(501) });
            expect(result.notes_truncated).toBe(true);
        });
    });
    describe('error contract', () => {
        it('update on unknown id throws TodoNotFoundError', async () => {
            const store = new InMemoryTodoStore();
            await store.set('s', [{ content: 'A', activeForm: 'A' }]);
            await expect(store.update('s', 't99', { status: 'completed' })).rejects.toBeInstanceOf(TodoNotFoundError);
        });
    });
});
