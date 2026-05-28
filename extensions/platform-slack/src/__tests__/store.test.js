import { describe, expect, it } from 'vitest';
import { ChannelOverrideStore } from '../store/channel-overrides';
import { ThreadStateStore } from '../store/thread-state';
/**
 * Minimal in-memory Storage stub. Built locally to avoid a devDependency
 * on @ethosagent/storage-fs — the slack package shouldn't have to pull
 * in a sibling extension just for tests.
 */
function memStorage() {
    const files = new Map();
    const dirs = new Set();
    return {
        async read(p) {
            return files.has(p) ? (files.get(p) ?? null) : null;
        },
        async readBytes(p) {
            const s = files.get(p);
            return s === undefined ? null : new TextEncoder().encode(s);
        },
        async exists(p) {
            return files.has(p) || dirs.has(p);
        },
        async mtime(p) {
            return files.has(p) ? Date.now() : null;
        },
        async list(_d) {
            return [];
        },
        async listEntries(_d) {
            return [];
        },
        async write(p, content) {
            files.set(p, typeof content === 'string' ? content : Buffer.from(content).toString('utf-8'));
        },
        async append(p, content) {
            const cur = files.get(p) ?? '';
            files.set(p, cur + content);
        },
        async writeAtomic(p, content) {
            files.set(p, typeof content === 'string' ? content : Buffer.from(content).toString('utf-8'));
        },
        async mkdir(d) {
            dirs.add(d);
        },
        async remove(p) {
            files.delete(p);
            dirs.delete(p);
        },
        async rename(from, to) {
            const v = files.get(from);
            if (v !== undefined) {
                files.set(to, v);
                files.delete(from);
            }
        },
        async chmod() { },
    };
}
describe('ChannelOverrideStore', () => {
    it('persists and reloads channel modes', async () => {
        const storage = memStorage();
        const store = new ChannelOverrideStore(storage, '/slack', 'bot-a');
        await store.set('C1', 'all');
        await store.set('C2', 'thread_follow');
        expect(store.get('C1')).toBe('all');
        expect(store.get('C2')).toBe('thread_follow');
        // Fresh store backed by the same storage replays JSONL
        const replay = new ChannelOverrideStore(storage, '/slack', 'bot-a');
        await replay.load();
        expect(replay.get('C1')).toBe('all');
        expect(replay.get('C2')).toBe('thread_follow');
    });
    it('latest record for a channel wins on reload', async () => {
        const storage = memStorage();
        const store = new ChannelOverrideStore(storage, '/slack', 'bot-a');
        await store.set('C1', 'all');
        await store.set('C1', 'mention_only');
        expect(store.get('C1')).toBe('mention_only');
        const replay = new ChannelOverrideStore(storage, '/slack', 'bot-a');
        await replay.load();
        expect(replay.get('C1')).toBe('mention_only');
    });
    it('returns undefined for unknown channels', async () => {
        const store = new ChannelOverrideStore(memStorage(), '/slack', 'bot-a');
        expect(store.get('C999')).toBeUndefined();
    });
});
describe('ThreadStateStore', () => {
    it('records and recalls bot-posted threads', async () => {
        const storage = memStorage();
        const store = new ThreadStateStore(storage, '/slack', 'bot-a');
        await store.recordPost('C1', 'T1');
        expect(store.hasBotPosted('C1', 'T1')).toBe(true);
        expect(store.hasBotPosted('C1', 'T2')).toBe(false);
        expect(store.hasBotPosted('C2', 'T1')).toBe(false);
    });
    it('skips writes for keys already recorded', async () => {
        const storage = memStorage();
        const store = new ThreadStateStore(storage, '/slack', 'bot-a');
        await store.recordPost('C1', 'T1');
        await store.recordPost('C1', 'T1');
        await store.recordPost('C1', 'T1');
        // Re-load and count records to confirm no duplicates were appended
        const raw = (await storage.read('/slack/bot-a/thread-state.jsonl')) ?? '';
        const lines = raw.split('\n').filter((l) => l.trim());
        expect(lines.length).toBe(1);
    });
    it('rebuilds in-memory set from JSONL on load', async () => {
        const storage = memStorage();
        const writer = new ThreadStateStore(storage, '/slack', 'bot-a');
        await writer.recordPost('C1', 'T1');
        await writer.recordPost('C2', 'T2');
        const reader = new ThreadStateStore(storage, '/slack', 'bot-a');
        await reader.load();
        expect(reader.hasBotPosted('C1', 'T1')).toBe(true);
        expect(reader.hasBotPosted('C2', 'T2')).toBe(true);
    });
});
