// JSONL-backed per-channel mode overrides.
//
// One file per bot at `~/.ethos/telegram/<botKey>/channel-overrides.jsonl`.
// Each line is `{ channel, mode, updatedAt, regexPattern? }`. The latest
// record for a channel wins (append-only with a small in-memory index).
import { join } from 'node:path';
import { z } from 'zod';
import { ChannelModeSchema } from '../config';

const RecordSchema = z.object({
  channel: z.string(),
  mode: ChannelModeSchema,
  updatedAt: z.number(),
  regexPattern: z.string().optional(),
});
export class ChannelOverrideStore {
  storage;
  baseDir;
  file;
  index = new Map();
  loaded = false;
  constructor(storage, baseDir) {
    this.storage = storage;
    this.baseDir = baseDir;
    this.file = join(baseDir, 'channel-overrides.jsonl');
  }
  /** Load existing records into the in-memory index. Idempotent. */
  async load() {
    if (this.loaded) return;
    const raw = await this.storage.read(this.file);
    if (raw) {
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = RecordSchema.safeParse(JSON.parse(trimmed));
          if (parsed.success) {
            this.index.set(parsed.data.channel, {
              mode: parsed.data.mode,
              regexPattern: parsed.data.regexPattern,
            });
          }
        } catch {
          // Skip malformed lines — partial writes or manual edits.
        }
      }
    }
    this.loaded = true;
  }
  get(channel) {
    return this.index.get(channel);
  }
  async set(channel, mode, regexPattern) {
    await this.load();
    this.index.set(channel, { mode, regexPattern });
    await this.storage.mkdir(this.baseDir);
    const record = {
      channel,
      mode,
      updatedAt: Date.now(),
      ...(regexPattern !== undefined ? { regexPattern } : {}),
    };
    await this.storage.append(this.file, `${JSON.stringify(record)}\n`);
  }
  /** Snapshot of all channel entries; useful for diagnostics. */
  entries() {
    return Array.from(this.index.entries());
  }
}
