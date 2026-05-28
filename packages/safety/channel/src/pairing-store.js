import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Pairing store — one-time pairing codes for DM allowlist gating
// ---------------------------------------------------------------------------
const CODE_TTL_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
/** Create the pairing tables if they don't exist. Call once at startup. */
export function initPairingDb(db) {
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

    CREATE TABLE IF NOT EXISTS pairing_consume_attempts (
      owner_id     TEXT NOT NULL,
      attempted_at INTEGER NOT NULL,
      succeeded    INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_consume_attempts_owner
      ON pairing_consume_attempts(owner_id, attempted_at);

    CREATE TABLE IF NOT EXISTS pairing_owner_pauses (
      owner_id     TEXT PRIMARY KEY,
      paused_until INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS allowed_senders (
      sender_id  TEXT NOT NULL,
      platform   TEXT NOT NULL,
      added_at   INTEGER NOT NULL,
      added_by   TEXT,
      PRIMARY KEY (sender_id, platform)
    ) STRICT;
  `);
}
/** Derive an 8-character uppercase alphanumeric code from a nonce via SHA-256. */
function makeCode(nonce) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const hash = createHash('sha256').update(nonce).digest();
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += alphabet[(hash[i] ?? 0) % alphabet.length];
  }
  return result;
}
/**
 * Generate a pairing code for `(senderId, platform)`.
 * Returns the code string, or `null` if rate-limited (1 code per user per 10 min).
 * Expired codes are cleaned up on each call.
 */
export function generateCode(db, senderId, platform) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const expiryCutoff = now - CODE_TTL_MS;
  // Clean up expired codes
  db.prepare(
    `UPDATE pairing_codes SET status = 'expired' WHERE status = 'pending' AND issued_at < ?`,
  ).run(expiryCutoff);
  // Rate-limit check: any pending code issued within the last 10 minutes for this sender
  const recent = db
    .prepare(`SELECT COUNT(*) AS cnt FROM pairing_codes
       WHERE sender_id = ? AND platform = ? AND status = 'pending' AND issued_at >= ?`)
    .get(senderId, platform, windowStart);
  if (recent.cnt > 0) return null;
  const nonce = randomBytes(8);
  const nonceHex = nonce.toString('hex');
  const code = makeCode(nonce);
  db.prepare(`INSERT INTO pairing_codes (code, sender_id, platform, issued_at, nonce, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`).run(code, senderId, platform, now, nonceHex);
  return code;
}
const LOCKOUT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
/**
 * Global (non-owner-keyed) rate limit on failed consume attempts.
 * Prevents an attacker from locking out a specific user by submitting
 * attempts under their ownerId. The global limit catches brute-force
 * attempts regardless of which ownerId is claimed.
 */
const GLOBAL_LOCKOUT_THRESHOLD = 20;
/** Record a failed consume attempt for ownerId and trigger lockout if threshold is reached. */
function recordFailedAttempt(db, ownerId, now) {
  db.prepare(
    `INSERT INTO pairing_consume_attempts (owner_id, attempted_at, succeeded) VALUES (?, ?, 0)`,
  ).run(ownerId, now);
  const windowStart = now - LOCKOUT_WINDOW_MS;
  // Check global attempt rate first — if the system is under brute-force
  // attack, pause ALL owners rather than letting the attacker target one.
  const globalCount = db
    .prepare(`SELECT COUNT(*) AS cnt FROM pairing_consume_attempts
       WHERE succeeded = 0 AND attempted_at >= ?`)
    .get(windowStart);
  if (globalCount.cnt >= GLOBAL_LOCKOUT_THRESHOLD) {
    // Pause the claimed ownerId; the global threshold means we're under
    // attack so locking out the claimed identity is acceptable.
    db.prepare(
      `INSERT OR REPLACE INTO pairing_owner_pauses (owner_id, paused_until) VALUES (?, ?)`,
    ).run(ownerId, now + LOCKOUT_DURATION_MS);
    return;
  }
  const failCount = db
    .prepare(`SELECT COUNT(*) AS cnt FROM pairing_consume_attempts
       WHERE owner_id = ? AND succeeded = 0 AND attempted_at >= ?`)
    .get(ownerId, windowStart);
  if (failCount.cnt >= LOCKOUT_THRESHOLD) {
    db.prepare(
      `INSERT OR REPLACE INTO pairing_owner_pauses (owner_id, paused_until) VALUES (?, ?)`,
    ).run(ownerId, now + LOCKOUT_DURATION_MS);
  }
}
/**
 * Atomically consume a pairing code.
 * Verifies: code exists, not consumed/expired, sender matches.
 * On success, flips status to 'consumed' atomically.
 * When ownerId is provided, enforces a 24h pause after 5 failed attempts.
 */
export function consumeCode(db, code, senderId, platform, ownerId) {
  const now = Date.now();
  const expiryCutoff = now - CODE_TTL_MS;
  if (ownerId !== undefined) {
    const pause = db
      .prepare(`SELECT paused_until FROM pairing_owner_pauses WHERE owner_id = ?`)
      .get(ownerId);
    if (pause !== undefined && pause.paused_until > now) {
      return { ok: false, reason: 'owner_paused' };
    }
  }
  // First look up the row regardless of status/sender to give precise errors
  const row = db
    .prepare(`SELECT sender_id, platform, status, issued_at FROM pairing_codes WHERE code = ?`)
    .get(code);
  let result;
  if (!row) {
    result = { ok: false, reason: 'not_found' };
  } else if (row.status === 'consumed') {
    result = { ok: false, reason: 'consumed' };
  } else if (row.status === 'expired' || row.issued_at < expiryCutoff) {
    result = { ok: false, reason: 'expired' };
  } else if (row.sender_id !== senderId || row.platform !== platform) {
    result = { ok: false, reason: 'sender_mismatch' };
  } else {
    // Atomic UPDATE — only succeeds if still pending and not yet expired
    const updateResult = db
      .prepare(`UPDATE pairing_codes SET status = 'consumed'
         WHERE code = ? AND status = 'pending' AND sender_id = ? AND platform = ? AND issued_at > ?`)
      .run(code, senderId, platform, expiryCutoff);
    if (updateResult.changes === 1) {
      result = { ok: true };
    } else {
      // Another concurrent update beat us — re-read to give the right error
      const updated = db.prepare(`SELECT status FROM pairing_codes WHERE code = ?`).get(code);
      if (!updated) {
        result = { ok: false, reason: 'not_found' };
      } else if (updated.status === 'consumed') {
        result = { ok: false, reason: 'consumed' };
      } else {
        result = { ok: false, reason: 'expired' };
      }
    }
  }
  if (ownerId !== undefined && !result.ok) {
    recordFailedAttempt(db, ownerId, now);
  }
  return result;
}
/**
 * Atomically consume a pairing code and add the sender to `allowed_senders` in one transaction.
 * Looks up sender_id and platform from the code row itself — no need to pass them separately.
 * When ownerId is provided, enforces a 24h pause after 5 failed attempts.
 */
export function consumeAndAllow(db, code, ownerId) {
  const txn = db.transaction(() => {
    const now = Date.now();
    const expiryCutoff = now - CODE_TTL_MS;
    // Check owner pause
    if (ownerId !== undefined) {
      const pause = db
        .prepare('SELECT paused_until FROM pairing_owner_pauses WHERE owner_id = ?')
        .get(ownerId);
      if (pause !== undefined && pause.paused_until > now) {
        return { ok: false, reason: 'owner_paused' };
      }
    }
    const row = db
      .prepare('SELECT sender_id, platform, status, issued_at FROM pairing_codes WHERE code = ?')
      .get(code);
    if (!row) {
      if (ownerId !== undefined) recordFailedAttempt(db, ownerId, now);
      return { ok: false, reason: 'not_found' };
    }
    if (row.status === 'consumed') {
      if (ownerId !== undefined) recordFailedAttempt(db, ownerId, now);
      return { ok: false, reason: 'consumed' };
    }
    if (row.status === 'expired' || row.issued_at < expiryCutoff) {
      if (ownerId !== undefined) recordFailedAttempt(db, ownerId, now);
      return { ok: false, reason: 'expired' };
    }
    const updated = db
      .prepare(`UPDATE pairing_codes SET status = 'consumed'
         WHERE code = ? AND status = 'pending' AND issued_at > ?`)
      .run(code, expiryCutoff);
    if (updated.changes !== 1) {
      if (ownerId !== undefined) recordFailedAttempt(db, ownerId, now);
      return { ok: false, reason: 'consumed' };
    }
    db.prepare(`INSERT OR IGNORE INTO allowed_senders (sender_id, platform, added_at, added_by)
       VALUES (?, ?, ?, ?)`).run(row.sender_id, row.platform, now, ownerId ?? null);
    return { ok: true, senderId: row.sender_id, platform: row.platform };
  });
  return txn();
}
/**
 * Return all sender IDs that have been approved (via `consumeAndAllow`) for a given platform.
 */
export function getApprovedSenders(db, platform) {
  return db
    .prepare('SELECT sender_id FROM allowed_senders WHERE platform = ?')
    .all(platform)
    .map((r) => r.sender_id);
}
/** Clear the 24h owner pause and failure attempt log (used by `ethos security audit --fix`). */
export function clearOwnerPause(db, ownerId) {
  db.prepare(`DELETE FROM pairing_owner_pauses WHERE owner_id = ?`).run(ownerId);
  db.prepare(`DELETE FROM pairing_consume_attempts WHERE owner_id = ?`).run(ownerId);
}
/**
 * Remove a sender from `allowed_senders` for a given platform.
 * Idempotent — no-op if the row doesn't exist.
 * Returns true if a row was deleted.
 */
export function revokeApproval(db, senderId, platform) {
  const result = db
    .prepare('DELETE FROM allowed_senders WHERE sender_id = ? AND platform = ?')
    .run(senderId, platform);
  return result.changes > 0;
}
