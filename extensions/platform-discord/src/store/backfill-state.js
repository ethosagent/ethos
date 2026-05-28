// Tracks "has this channel/thread been backfilled" — prevents re-fetching
// history on every message. JSONL records at
// `~/.ethos/discord/<botKey>/backfill-state.jsonl`. The set is in-memory; the
// JSONL is the durable trail so the set rebuilds on restart.
import { join } from 'node:path';
import { z } from 'zod';
const RecordSchema = z.object({
    chatId: z.string(),
    threadId: z.string(),
    at: z.number(),
});
export class BackfillStateStore {
    storage;
    discordDir;
    botKey;
    file;
    seen = new Set();
    loaded = false;
    constructor(storage, discordDir, botKey) {
        this.storage = storage;
        this.discordDir = discordDir;
        this.botKey = botKey;
        this.file = join(discordDir, botKey, 'backfill-state.jsonl');
    }
    async load() {
        if (this.loaded)
            return;
        const raw = await this.storage.read(this.file);
        if (raw) {
            for (const line of raw.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed)
                    continue;
                try {
                    const parsed = RecordSchema.safeParse(JSON.parse(trimmed));
                    if (parsed.success)
                        this.seen.add(this.key(parsed.data.chatId, parsed.data.threadId || undefined));
                }
                catch {
                    // Skip malformed lines — partial writes or manual edits.
                }
            }
        }
        this.loaded = true;
    }
    hasDone(chatId, threadId) {
        return this.seen.has(this.key(chatId, threadId));
    }
    /** Record a backfill for a channel/thread. Skips writes for keys already
     *  recorded so the JSONL doesn't grow unbounded. */
    async mark(chatId, threadId) {
        await this.load();
        const k = this.key(chatId, threadId);
        if (this.seen.has(k))
            return;
        this.seen.add(k);
        await this.storage.mkdir(join(this.discordDir, this.botKey));
        const record = { chatId, threadId: threadId ?? '', at: Date.now() };
        await this.storage.append(this.file, `${JSON.stringify(record)}\n`);
    }
    key(chatId, threadId) {
        return `${chatId}:${threadId ?? ''}`;
    }
}
