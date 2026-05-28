// JSONL-backed per-channel mode overrides.
//
// One file per bot at `~/.ethos/discord/<botKey>/channel-overrides.jsonl`.
// Each line is `{ channel, mode, updatedAt }`. The latest record for a
// channel wins (append-only with a small in-memory index).
import { join } from 'node:path';
import { z } from 'zod';
import { ChannelModeSchema } from '../config';
const RecordSchema = z.object({
    channel: z.string(),
    mode: ChannelModeSchema,
    updatedAt: z.number(),
});
export class ChannelOverrideStore {
    storage;
    discordDir;
    botKey;
    file;
    index = new Map();
    loaded = false;
    constructor(storage, discordDir, botKey) {
        this.storage = storage;
        this.discordDir = discordDir;
        this.botKey = botKey;
        this.file = join(discordDir, botKey, 'channel-overrides.jsonl');
    }
    /** Load existing records into the in-memory index. Idempotent. */
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
                        this.index.set(parsed.data.channel, parsed.data.mode);
                }
                catch {
                    // Skip malformed lines — partial writes or manual edits.
                }
            }
        }
        this.loaded = true;
    }
    get(channel) {
        return this.index.get(channel);
    }
    async set(channel, mode) {
        await this.load();
        this.index.set(channel, mode);
        await this.storage.mkdir(join(this.discordDir, this.botKey));
        const record = { channel, mode, updatedAt: Date.now() };
        await this.storage.append(this.file, `${JSON.stringify(record)}\n`);
    }
    /** Snapshot of all channel->mode entries; useful for /ethos help. */
    entries() {
        return Array.from(this.index.entries());
    }
}
