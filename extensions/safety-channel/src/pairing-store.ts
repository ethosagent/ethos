import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Pairing store — one-time pairing codes for DM allowlist gating
// ---------------------------------------------------------------------------

const CODE_TTL_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/** Create the pairing_codes table if it doesn't exist. Call once at startup. */
export function initPairingDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_codes (
      code       TEXT NOT NULL,
      sender_id  TEXT NOT NULL,
      platform   TEXT NOT NULL,
      issued_at  INTEGER NOT NULL,
      nonce      TEXT NOT NULL,
      status     TEXT NOT NULL CHECK(status IN ('pending', 'consumed', 'expired')),
      PRIMARY KEY (code)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_pairing_sender
      ON pairing_codes(sender_id, platform, issued_at);
  `);
}

/** Generate an 8-character uppercase alphanumeric code. */
function makeCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(8);
  let result = '';
  for (const b of bytes) {
    result += alphabet[b % alphabet.length];
  }
  return result;
}

/**
 * Generate a pairing code for `(senderId, platform)`.
 * Returns the code string, or `null` if rate-limited (1 code per user per 10 min).
 * Expired codes are cleaned up on each call.
 */
export function generateCode(
  db: Database.Database,
  senderId: string,
  platform: string,
): string | null {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const expiryCutoff = now - CODE_TTL_MS;

  // Clean up expired codes
  db.prepare(
    `UPDATE pairing_codes SET status = 'expired' WHERE status = 'pending' AND issued_at < ?`,
  ).run(expiryCutoff);

  // Rate-limit check: any pending code issued within the last 10 minutes for this sender
  const recent = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM pairing_codes
       WHERE sender_id = ? AND platform = ? AND status = 'pending' AND issued_at >= ?`,
    )
    .get(senderId, platform, windowStart) as { cnt: number };

  if (recent.cnt > 0) return null;

  const code = makeCode();
  const nonce = randomBytes(8).toString('hex');

  db.prepare(
    `INSERT INTO pairing_codes (code, sender_id, platform, issued_at, nonce, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
  ).run(code, senderId, platform, now, nonce);

  return code;
}

export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'consumed' | 'expired' | 'sender_mismatch' };

/**
 * Atomically consume a pairing code.
 * Verifies: code exists, not consumed/expired, sender matches.
 * On success, flips status to 'consumed' atomically.
 */
export function consumeCode(
  db: Database.Database,
  code: string,
  senderId: string,
  platform: string,
): ConsumeResult {
  const now = Date.now();
  const expiryCutoff = now - CODE_TTL_MS;

  // First look up the row regardless of status/sender to give precise errors
  const row = db
    .prepare(`SELECT sender_id, platform, status, issued_at FROM pairing_codes WHERE code = ?`)
    .get(code) as
    | { sender_id: string; platform: string; status: string; issued_at: number }
    | undefined;

  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status === 'consumed') return { ok: false, reason: 'consumed' };
  if (row.status === 'expired' || row.issued_at < expiryCutoff)
    return { ok: false, reason: 'expired' };
  if (row.sender_id !== senderId || row.platform !== platform)
    return { ok: false, reason: 'sender_mismatch' };

  // Atomic UPDATE — only succeeds if still pending and not yet expired
  const result = db
    .prepare(
      `UPDATE pairing_codes SET status = 'consumed'
       WHERE code = ? AND status = 'pending' AND sender_id = ? AND platform = ? AND issued_at > ?`,
    )
    .run(code, senderId, platform, expiryCutoff);

  if (result.changes === 1) return { ok: true };

  // Another concurrent update beat us — re-read to give the right error
  const updated = db.prepare(`SELECT status FROM pairing_codes WHERE code = ?`).get(code) as
    | { status: string }
    | undefined;

  if (!updated) return { ok: false, reason: 'not_found' };
  if (updated.status === 'consumed') return { ok: false, reason: 'consumed' };
  return { ok: false, reason: 'expired' };
}
