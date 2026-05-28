// Tracks "has this channel/thread been backfilled already" — so the bot
// fetches history at most once per conversation. JSONL records at
// `~/.ethos/slack/<botKey>/backfill-state.jsonl`. The set is in-memory; the
// JSONL is the durable trail so the set rebuilds on restart.
import { join } from 'node:path';
import { z } from 'zod';
const RecordSchema = z.object({
    channel: z.string(),
    threadTs: z.string(),
    at: z.number(),
});
export class BackfillStateStore {
    storage;
    slackDir;
    botKey;
    file;
    seen = new Set();
    loaded = false;
    constructor(storage, slackDir, botKey) {
        this.storage = storage;
        this.slackDir = slackDir;
        this.botKey = botKey;
        this.file = join(slackDir, botKey, 'backfill-state.jsonl');
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
                const parsed = RecordSchema.safeParse(JSON.parse(trimmed));
                if (parsed.success)
                    this.seen.add(this.key(parsed.data.channel, parsed.data.threadTs));
            }
        }
        this.loaded = true;
    }
    hasDone(channel, threadTs) {
        return this.seen.has(this.key(channel, threadTs));
    }
    /** Record that backfill has been performed for a channel/thread. Skips
     *  writes for keys already recorded so the JSONL doesn't grow unbounded. */
    async mark(channel, threadTs) {
        await this.load();
        const k = this.key(channel, threadTs);
        if (this.seen.has(k))
            return;
        this.seen.add(k);
        await this.storage.mkdir(join(this.slackDir, this.botKey));
        const record = { channel, threadTs: threadTs ?? '', at: Date.now() };
        await this.storage.append(this.file, `${JSON.stringify(record)}\n`);
    }
    key(channel, threadTs) {
        return `${channel}:${threadTs ?? ''}`;
    }
}
