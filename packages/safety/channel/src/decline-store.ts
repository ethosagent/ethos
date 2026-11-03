import type Database from '@ethosagent/sqlite';

// ---------------------------------------------------------------------------
// Decline window store — one refusal per sender per window under
// `dmPolicy: 'decline'`. The table is created by `initPairingDb`
// (pairing-store.ts) so every host that opens pairing.db has it.
// ---------------------------------------------------------------------------

/** One refusal per (platform, bot, sender) per 24 hours (plan hermes-0.22-hardening D19). */
export const DECLINE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The sender whose refusal window is being claimed. `botKey` is the pre-resolution bot key. */
export interface DeclineKey {
  platform: string;
  botKey: string;
  senderId: string;
}

/**
 * Claim the refusal slot for `key`. Returns `true` when this caller owns the
 * slot (no refusal in the last `DECLINE_WINDOW_MS`) and so may send one.
 *
 * The claim is ONE upsert whose
 * affected-row count is the answer: a fresh key inserts (1 change); an
 * expired row is overwritten by the conditional `DO UPDATE ... WHERE` (1
 * change); a key still inside its window matches the conflict, fails the
 * WHERE, and changes nothing (0); expired rows are pruned after a winning claim. So two processes sharing pairing.db cannot
 * both win the same slot. Pinned by `decline-store.test.ts`.
 */
export function claimDeclineSlot(
  db: Database.Database,
  key: DeclineKey,
  now: number = Date.now(),
): boolean {
  const cutoff = now - DECLINE_WINDOW_MS;
  const result = db
    .prepare(
      `INSERT INTO dm_declines (platform, bot_key, sender_id, declined_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (platform, bot_key, sender_id) DO UPDATE SET declined_at = excluded.declined_at
         WHERE dm_declines.declined_at <= ?`,
    )
    .run(key.platform, key.botKey, key.senderId, now, cutoff);
  if (result.changes !== 1) return false;
  // Housekeeping only on a win: the conditional upsert above already overwrites
  // an expired row, so pruning never gates a claim.
  db.prepare('DELETE FROM dm_declines WHERE declined_at < ?').run(cutoff);
  return true;
}
