import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimDeclineSlot, DECLINE_WINDOW_MS } from '../decline-store';
import { initPairingDb } from '../pairing-store';

const key = { platform: 'telegram', botKey: 'bot-a', senderId: 'stranger-1' };

describe('decline-store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initPairingDb(db);
  });

  afterEach(() => {
    db.close();
  });

  it('first claim succeeds', () => {
    expect(claimDeclineSlot(db, key, 1_000_000)).toBe(true);
  });

  it('a second claim inside the window fails', () => {
    expect(claimDeclineSlot(db, key, 1_000_000)).toBe(true);
    expect(claimDeclineSlot(db, key, 1_000_000 + DECLINE_WINDOW_MS - 1)).toBe(false);
  });

  it('a claim after the window succeeds', () => {
    expect(claimDeclineSlot(db, key, 1_000_000)).toBe(true);
    expect(claimDeclineSlot(db, key, 1_000_000 + DECLINE_WINDOW_MS)).toBe(true);
    // The renewed claim restarts the window.
    expect(claimDeclineSlot(db, key, 1_000_000 + DECLINE_WINDOW_MS + 1)).toBe(false);
  });

  it('keys are per platform, bot and sender', () => {
    const t = 5_000_000;
    expect(claimDeclineSlot(db, key, t)).toBe(true);
    expect(claimDeclineSlot(db, { ...key, platform: 'slack' }, t)).toBe(true);
    expect(claimDeclineSlot(db, { ...key, botKey: 'bot-b' }, t)).toBe(true);
    expect(claimDeclineSlot(db, { ...key, senderId: 'stranger-2' }, t)).toBe(true);
    expect(claimDeclineSlot(db, key, t)).toBe(false);
  });

  it('prune removes rows older than the window', () => {
    const t = 10_000_000;
    claimDeclineSlot(db, key, t);
    claimDeclineSlot(db, { ...key, senderId: 'stranger-2' }, t + DECLINE_WINDOW_MS - 10);
    // A claim for a third sender, a window after the first row, prunes it.
    claimDeclineSlot(db, { ...key, senderId: 'stranger-3' }, t + DECLINE_WINDOW_MS + 1);
    const rows = db.prepare('SELECT sender_id FROM dm_declines ORDER BY sender_id').all() as {
      sender_id: string;
    }[];
    expect(rows.map((r) => r.sender_id)).toEqual(['stranger-2', 'stranger-3']);
  });

  it('initPairingDb creates dm_declines as a STRICT table', () => {
    const row = db
      .prepare(`SELECT strict FROM pragma_table_list WHERE name = 'dm_declines'`)
      .get() as { strict: number } | undefined;
    expect(row?.strict).toBe(1);
    // Idempotent: a second init over the same db does not throw.
    expect(() => initPairingDb(db)).not.toThrow();
  });
});
