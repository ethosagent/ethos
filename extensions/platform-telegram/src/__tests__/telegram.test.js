import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { chunkText, reflowChunks, TelegramAdapter } from '../index';
const cache = new InMemoryAttachmentCache();
describe('chunkText', () => {
    it('returns single chunk when text is within limit', () => {
        expect(chunkText('hello', 100)).toEqual(['hello']);
    });
    it('splits at newline boundary when possible', () => {
        const text = 'line one\nline two\nline three';
        // Force a split after "line one\n" (limit = 10)
        const chunks = chunkText(text, 10);
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.join('')).toBe(text); // no content lost
    });
    it('splits at space boundary when no newline available', () => {
        const text = 'word1 word2 word3 word4';
        const chunks = chunkText(text, 12);
        expect(chunks.join('')).toBe(text);
        for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(12);
        }
    });
    it('handles text longer than 4096', () => {
        const text = 'x'.repeat(5000);
        const chunks = chunkText(text, 4096);
        expect(chunks.length).toBe(2);
        expect(chunks[0].length).toBe(4096);
        expect(chunks[1].length).toBe(904);
        expect(chunks.join('')).toBe(text);
    });
    it('preserves all content across chunks', () => {
        const text = `${'A'.repeat(100)}\n${'B'.repeat(100)}\n${'C'.repeat(100)}`;
        const chunks = chunkText(text, 150);
        expect(chunks.join('')).toBe(text);
    });
});
describe('reflowChunks', () => {
    it('edits in place, appends extras, and deletes trailing chunks', async () => {
        const calls = [];
        const ops = {
            edit: async (id, text) => {
                calls.push(`edit(${id},${text})`);
                return id;
            },
            append: async (text) => {
                calls.push(`append(${text})`);
                return `new-${text}`;
            },
            deleteId: async (id) => {
                calls.push(`delete(${id})`);
            },
        };
        // Reflow 2 existing → 3 new: 2 edits + 1 append
        const ids = await reflowChunks(['x', 'y', 'z'], ['1', '2'], ops);
        expect(ids).toEqual(['1', '2', 'new-z']);
        expect(calls).toEqual(['edit(1,x)', 'edit(2,y)', 'append(z)']);
        // Reflow 3 existing → 1 new: 1 edit + 2 deletes
        calls.length = 0;
        const ids2 = await reflowChunks(['only'], ['1', '2', '3'], ops);
        expect(ids2).toEqual(['1']);
        expect(calls).toEqual(['edit(1,only)', 'delete(2)', 'delete(3)']);
    });
    it('continues when delete throws', async () => {
        const ops = {
            edit: async (id) => id,
            append: async () => 'x',
            deleteId: async () => {
                throw new Error('blocked');
            },
        };
        await expect(reflowChunks(['a'], ['1', '2', '3'], ops)).resolves.toEqual(['1']);
    });
});
// ---------------------------------------------------------------------------
// TelegramAdapter — multi-bot routing identity
//
// Each TelegramAdapter is bound to a single bot. The adapter exposes its
// `botKey` so logs / orchestration code can disambiguate; `id` carries
// the same value so Gateway shutdown + error logs read cleanly.
// ---------------------------------------------------------------------------
describe('TelegramAdapter — botKey identity', () => {
    it('stores the configured botKey and surfaces it through the id', () => {
        // `new Bot(token)` doesn't validate the token at construction (only on
        // start/getMe), so a fake token is enough to exercise the identity
        // plumbing.
        const adapter = new TelegramAdapter({
            token: '1234567890:fake-token-for-construction-only',
            cache,
            botKey: 'researcher-bot',
        });
        expect(adapter.botKey).toBe('researcher-bot');
        expect(adapter.id).toBe('telegram:researcher-bot');
    });
    it('two adapters bound to different bots have distinct ids', () => {
        const a = new TelegramAdapter({ token: '1:a', cache, botKey: 'a' });
        const b = new TelegramAdapter({ token: '2:b', cache, botKey: 'b' });
        expect(a.id).not.toBe(b.id);
        expect(a.botKey).toBe('a');
        expect(b.botKey).toBe('b');
    });
    it('derives a stable botKey from the token when omitted (back-compat for direct constructors)', () => {
        // Adapter was historically `new TelegramAdapter({ token })` with no
        // botKey. Phase 2 makes botKey optional and derives the same
        // 24-hex sha256(token) prefix the config layer's deriveBotKey
        // produces, so old call sites keep working with a stable identity.
        const a = new TelegramAdapter({ token: '123:ABC', cache });
        const b = new TelegramAdapter({ token: '123:ABC', cache });
        expect(a.botKey).toBe(b.botKey);
        expect(a.botKey).toMatch(/^[0-9a-f]{24}$/);
        expect(a.id).toBe(`telegram:${a.botKey}`);
    });
    it('explicit botKey wins over the derived default', () => {
        const a = new TelegramAdapter({ token: '123:ABC', cache });
        const b = new TelegramAdapter({ token: '123:ABC', cache, botKey: 'explicit' });
        expect(a.botKey).not.toBe(b.botKey);
        expect(b.botKey).toBe('explicit');
    });
});
