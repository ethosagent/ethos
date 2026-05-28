import { InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClarifyBridge, ClarifyBusyError, ClarifyNoSurfaceError, ClarifyTimedOutNoDefaultError, } from '../clarify/clarify-bridge';
import { FileClarifyStore } from '../clarify/file-clarify-store';
function makeRow(overrides = {}) {
    return {
        requestId: 'r1',
        sessionId: 's1',
        surfaceType: 'cli',
        surfaceContext: {},
        question: 'Which database?',
        answerableBy: 'anyone',
        createdAt: '2026-05-15T00:00:00.000Z',
        defaultDeadlineAt: '2026-05-15T00:15:00.000Z',
        ...overrides,
    };
}
describe('FileClarifyStore', () => {
    it('round-trips add / get / list / remove', async () => {
        const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
        await store.add(makeRow({ requestId: 'a', sessionId: 's1' }));
        await store.add(makeRow({ requestId: 'b', sessionId: 's2' }));
        expect((await store.get('a'))?.requestId).toBe('a');
        expect(await store.get('missing')).toBeNull();
        expect(await store.list()).toHaveLength(2);
        expect(await store.list({ sessionId: 's2' })).toHaveLength(1);
        await store.remove('a');
        expect(await store.get('a')).toBeNull();
        expect(await store.list()).toHaveLength(1);
    });
    it('add replaces a row with the same requestId', async () => {
        const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
        await store.add(makeRow({ requestId: 'a', question: 'first' }));
        await store.add(makeRow({ requestId: 'a', question: 'second' }));
        const rows = await store.list();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.question).toBe('second');
    });
    it('expired() returns only rows past the deadline', async () => {
        const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
        await store.add(makeRow({ requestId: 'old', defaultDeadlineAt: '2026-05-15T00:00:00.000Z' }));
        await store.add(makeRow({ requestId: 'new', defaultDeadlineAt: '2026-05-15T01:00:00.000Z' }));
        const expired = await store.expired(new Date('2026-05-15T00:30:00.000Z'));
        expect(expired.map((r) => r.requestId)).toEqual(['old']);
    });
    it('tolerates a corrupt pending file', async () => {
        const storage = new InMemoryStorage();
        await storage.mkdir('/ethos/clarify');
        await storage.write('/ethos/clarify/pending.json', '{ not json');
        const store = new FileClarifyStore(storage, '/ethos/clarify');
        expect(await store.list()).toEqual([]);
    });
    // The Telegram surface needs to write back the platform message id after
    // sending the prompt, so a force-reply or restart sweep can find the row.
    it('update() patches an existing row by requestId', async () => {
        const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
        await store.add(makeRow({ requestId: 'r1', surfaceContext: { chatId: 42 } }));
        await store.update('r1', { surfaceContext: { chatId: 42, messageId: 99 } });
        const row = await store.get('r1');
        expect(row?.surfaceContext).toEqual({ chatId: 42, messageId: 99 });
    });
    it('update() is a no-op for a missing requestId', async () => {
        const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
        await expect(store.update('missing', { surfaceContext: { x: 1 } })).resolves.toBeUndefined();
        expect(await store.list()).toEqual([]);
    });
});
describe('ClarifyBridge', () => {
    function makeBridge() {
        const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
        return { bridge: new ClarifyBridge(store), store };
    }
    const baseInput = {
        question: 'Which database for the migration?',
        timeoutMs: 900_000,
        answerableBy: 'anyone',
        sessionId: 's1',
        surfaceType: 'cli',
    };
    it('rejects with CLARIFY_NO_SURFACE when no presenter is registered', async () => {
        const { bridge } = makeBridge();
        await expect(bridge.request(baseInput)).rejects.toBeInstanceOf(ClarifyNoSurfaceError);
    });
    it('presents the request and resolves with the user answer', async () => {
        const { bridge, store } = makeBridge();
        const presented = [];
        bridge.setPresenter((req) => {
            presented.push(req);
            // Simulate a surface answering on the next tick.
            queueMicrotask(() => {
                void bridge.respond({ requestId: req.requestId, answer: 'postgres', source: 'user' });
            });
        });
        const res = await bridge.request({ ...baseInput, options: ['postgres', 'sqlite'] });
        expect(res.answer).toBe('postgres');
        expect(res.source).toBe('user');
        expect(presented).toHaveLength(1);
        expect(presented[0]?.question).toBe(baseInput.question);
        // Persisted before presenting, removed on resolve.
        expect(await store.list()).toHaveLength(0);
    });
    it('persists the pending row before presenting', async () => {
        const { bridge, store } = makeBridge();
        let rowsAtPresentTime = -1;
        let capturedId = '';
        const presented = new Promise((resolve) => {
            bridge.setPresenter(async (req) => {
                capturedId = req.requestId;
                rowsAtPresentTime = (await store.list()).length;
                resolve();
            });
        });
        const pending = bridge.request(baseInput);
        await presented;
        await bridge.respond({ requestId: capturedId, answer: 'x', source: 'user' });
        await pending;
        expect(rowsAtPresentTime).toBe(1);
    });
    it('rejects a second concurrent clarify for the same session with CLARIFY_BUSY', async () => {
        const { bridge } = makeBridge();
        const presented = new Promise((resolve) => bridge.setPresenter(resolve));
        const first = bridge.request(baseInput);
        const row = await presented; // presenter fires after the pending row registers
        await expect(bridge.request(baseInput)).rejects.toBeInstanceOf(ClarifyBusyError);
        await bridge.respond({ requestId: row.requestId, answer: 'done', source: 'user' });
        await expect(first).resolves.toMatchObject({ answer: 'done' });
    });
    it('allows a second clarify after the first resolves', async () => {
        const { bridge } = makeBridge();
        bridge.setPresenter((req) => {
            void bridge.respond({ requestId: req.requestId, answer: 'a', source: 'user' });
        });
        await bridge.request(baseInput);
        await expect(bridge.request(baseInput)).resolves.toMatchObject({ answer: 'a' });
    });
    describe('timeout', () => {
        beforeEach(() => vi.useFakeTimers());
        afterEach(() => vi.useRealTimers());
        it('resolves with the default on timeout', async () => {
            const { bridge, store } = makeBridge();
            bridge.setPresenter(() => { });
            const pending = bridge.request({ ...baseInput, default: 'postgres', timeoutMs: 5_000 });
            await vi.advanceTimersByTimeAsync(5_000);
            const res = await pending;
            expect(res).toMatchObject({ answer: 'postgres', source: 'timeout-default' });
            expect(await store.list()).toHaveLength(0);
        });
        it('rejects with CLARIFY_TIMED_OUT_NO_DEFAULT when no default was given', async () => {
            const { bridge } = makeBridge();
            bridge.setPresenter(() => { });
            const pending = bridge.request({ ...baseInput, timeoutMs: 5_000 });
            const assertion = expect(pending).rejects.toBeInstanceOf(ClarifyTimedOutNoDefaultError);
            await vi.advanceTimersByTimeAsync(5_000);
            await assertion;
        });
    });
    it('resolves as cancelled when the turn abort signal fires', async () => {
        const { bridge } = makeBridge();
        bridge.setPresenter(() => { });
        const controller = new AbortController();
        const pending = bridge.request({ ...baseInput, abortSignal: controller.signal });
        controller.abort();
        const res = await pending;
        expect(res.source).toBe('cancel');
    });
    it('swallows respond() for an unknown / already-resolved request id', async () => {
        const { bridge } = makeBridge();
        await expect(bridge.respond({ requestId: 'never-existed', answer: 'x', source: 'user' })).resolves.toBeUndefined();
    });
    // Restart-survival: after a gateway crash the original `request()` promise is
    // gone, but a persisted row may remain and the UI is still showing buttons.
    // A late respond() (button tap after restart) must still clean the row up
    // and notify listeners so the surface can edit the message in place.
    it('respond() cleans up a persisted row + notifies listeners when no in-memory entry exists', async () => {
        const { bridge, store } = makeBridge();
        const row = makeRow({ requestId: 'orphan', surfaceContext: { chatId: 7 } });
        await store.add(row);
        const notified = [];
        bridge.onResolved((r, resp) => {
            notified.push({ requestId: r.requestId, source: resp?.source ?? null });
        });
        await bridge.respond({ requestId: 'orphan', answer: 'postgres', source: 'user' });
        expect(await store.list()).toHaveLength(0);
        expect(notified).toEqual([{ requestId: 'orphan', source: 'user' }]);
    });
    it('sweep() notifies resolved listeners for swept persisted rows', async () => {
        const { bridge, store } = makeBridge();
        // Two rows: one expired, one fresh — only the expired one should fire.
        await store.add(makeRow({
            requestId: 'expired',
            defaultDeadlineAt: '2026-05-15T00:00:00.000Z',
        }));
        await store.add(makeRow({
            requestId: 'fresh',
            defaultDeadlineAt: '2026-05-15T02:00:00.000Z',
        }));
        const swept = [];
        bridge.onResolved((row) => {
            swept.push(row.requestId);
        });
        await bridge.sweep(new Date('2026-05-15T01:00:00.000Z'));
        expect(swept).toEqual(['expired']);
        expect(await store.list()).toHaveLength(1);
    });
    it('listPersisted() proxies to the underlying store', async () => {
        const { bridge, store } = makeBridge();
        await store.add(makeRow({ requestId: 'a', surfaceType: 'telegram' }));
        await store.add(makeRow({ requestId: 'b', surfaceType: 'cli' }));
        const tg = await bridge.listPersisted({ surfaceType: 'telegram' });
        expect(tg.map((r) => r.requestId)).toEqual(['a']);
    });
});
