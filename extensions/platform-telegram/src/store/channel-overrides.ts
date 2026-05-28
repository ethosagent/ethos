// JSONL-backed per-channel mode overrides.
//
// One file per bot at `~/.ethos/telegram/<botKey>/channel-overrides.jsonl`.
// Each line is `{ channel, mode, updatedAt, regexPattern? }`. The latest
// record for a channel wins (append-only with a small in-memory index).

import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import { z } from 'zod';
import { type ChannelMode, ChannelModeSchema } from '../config';

const RecordSchema = z.object({
  channel: z.string(),
  mode: ChannelModeSchema,
  updatedAt: z.number(),
  regexPattern: z.string().optional(),
});
type ChannelOverrideRecord = z.infer<typeof RecordSchema>;

export interface ChannelOverrideEntry {
  mode: ChannelMode;
  regexPattern?: string;
}

export class ChannelOverrideStore {
  private readonly file: string;
  private readonly index = new Map<string, ChannelOverrideEntry>();
  private loaded = false;

  constructor(
    private readonly storage: Storage,
    private readonly baseDir: string,
  ) {
    this.file = join(baseDir, 'channel-overrides.jsonl');
  }

  /** Load existing records into the in-memory index. Idempotent. */
  async load(): Promise<void> {
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

  get(channel: string): ChannelOverrideEntry | undefined {
    return this.index.get(channel);
  }

  async set(channel: string, mode: ChannelMode, regexPattern?: string): Promise<void> {
    await this.load();
    this.index.set(channel, { mode, regexPattern });
    await this.storage.mkdir(this.baseDir);
    const record: ChannelOverrideRecord = {
      channel,
      mode,
      updatedAt: Date.now(),
      ...(regexPattern !== undefined ? { regexPattern } : {}),
    };
    await this.storage.append(this.file, `${JSON.stringify(record)}\n`);
  }

  /** Snapshot of all channel entries; useful for diagnostics. */
  entries(): Array<[string, ChannelOverrideEntry]> {
    return Array.from(this.index.entries());
  }
}
