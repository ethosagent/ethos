// Durable lane → session map (plan openclaw-9.5-adoption D28).
//
// `/new`, `/personality <id>`, `/fork` and `/branch <n>` move a lane onto a
// session other than its default (the lane key itself). That choice used to
// live only in `Gateway.sessionKeys`, so a restart silently put every lane back
// on its default session — and a spool-replayed row, an interrupted `retry` or
// a `wake_review` turn ran in the wrong session. This file persists the map.
//
// One file per bot, `<dataDir>/gateway/lanes/<botKey>.json`, written whole with
// `Storage.writeAtomic`. A bot runs in exactly one process (`acquireGatewayLock`
// in packages/wiring/src/gateway-lock.ts guarantees one gateway per state dir),
// so no other process writes the same file and no lock is needed; `writeAtomic`
// keeps the file from being torn, and `LaneSessionFiles.save` serializes this
// process's own writes per bot so two lanes switching at once cannot race on
// the same temp file.

import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';

/** What a lane is on, when it is not on its default session. */
export interface LaneSessionEntry {
  sessionKey: string;
  /**
   * The lane's personality override, when one is set. Persisted beside the key
   * because a session is bound to its personality at creation: restoring the
   * key without it would run the lane's default personality against a session
   * bound to another, which turn-setup refuses (`personality_locked`).
   */
  personalityId?: string;
}

const FILE_VERSION = 1;

export class LaneSessionFiles {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    private readonly storage: Storage,
    private readonly dataDir: string,
  ) {}

  private dir(): string {
    return join(this.dataDir, 'gateway', 'lanes');
  }

  path(botKey: string): string {
    return join(this.dir(), `${encodeURIComponent(botKey)}.json`);
  }

  /**
   * The bot's persisted lanes. An absent file is an empty map; a file that
   * cannot be read or parsed THROWS, so the caller can record it and fall back
   * to in-memory defaults rather than mistake corruption for "no lanes".
   */
  async load(botKey: string): Promise<Map<string, LaneSessionEntry>> {
    const raw = await this.storage.read(this.path(botKey));
    const lanes = new Map<string, LaneSessionEntry>();
    if (raw === null) return lanes;
    const parsed: unknown = JSON.parse(raw);
    const body = isRecord(parsed) && isRecord(parsed.lanes) ? parsed.lanes : null;
    if (!body || (isRecord(parsed) && parsed.version !== FILE_VERSION)) {
      throw new Error(`unrecognized lane session file ${this.path(botKey)}`);
    }
    for (const [laneKey, value] of Object.entries(body)) {
      if (!isRecord(value) || typeof value.sessionKey !== 'string') continue;
      lanes.set(laneKey, {
        sessionKey: value.sessionKey,
        ...(typeof value.personalityId === 'string' ? { personalityId: value.personalityId } : {}),
      });
    }
    return lanes;
  }

  /**
   * Replace the bot's file with `lanes`. Writes for one bot run one at a time,
   * in call order, so the last snapshot taken is the one left on disk.
   */
  save(botKey: string, lanes: Record<string, LaneSessionEntry>): Promise<void> {
    const body = `${JSON.stringify({ version: FILE_VERSION, lanes }, null, 2)}\n`;
    const previous = this.writes.get(botKey) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        await this.storage.mkdir(this.dir());
        await this.storage.writeAtomic(this.path(botKey), body);
      });
    this.writes.set(botKey, next);
    return next;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
