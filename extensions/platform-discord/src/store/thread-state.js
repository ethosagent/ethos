// Tracks "this bot has posted in this thread" — needed by the
// `thread_follow` channel mode. JSONL records at
// `~/.ethos/discord/<botKey>/thread-state.jsonl`. The set is in-memory; the
// JSONL is the durable trail so the set rebuilds on restart.
import { join } from 'node:path';
import { z } from 'zod';
const RecordSchema = z.object({
    channel: z.string(),
    threadId: z.string(),
    firstPostedAt: z.number(),
});
export class ThreadStateStore {
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
        this.file = join(discordDir, botKey, 'thread-state.jsonl');
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
                        this.seen.add(this.key(parsed.data.channel, parsed.data.threadId));
                }
                catch {
                    // Skip malformed lines — partial writes or manual edits.
                }
            }
        }
        this.loaded = true;
    }
    hasBotPosted(channel, threadId) {
        return this.seen.has(this.key(channel, threadId));
    }
    /** Record an outbound post in a thread. Skips writes for keys already
     *  recorded so the JSONL doesn't grow unbounded for chatty threads. */
    async recordPost(channel, threadId) {
        await this.load();
        const k = this.key(channel, threadId);
        if (this.seen.has(k))
            return;
        this.seen.add(k);
        await this.storage.mkdir(join(this.discordDir, this.botKey));
        const record = { channel, threadId, firstPostedAt: Date.now() };
        await this.storage.append(this.file, `${JSON.stringify(record)}\n`);
    }
    key(channel, threadId) {
        return `${channel}:${threadId}`;
    }
}
