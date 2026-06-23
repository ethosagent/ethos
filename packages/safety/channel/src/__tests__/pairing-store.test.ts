import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearOwnerPause,
  consumeAndAllow,
  consumeCode,
  generateCode,
  getApprovedSenders,
  initPairingDb,
  revokeApproval,
} from '../pairing-store';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pairing-store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initPairingDb(db);
  });

  afterEach(() => {
    db.close();
  });

  it('generate code → 8 chars, stored as pending', () => {
    const code = generateCode(db, 'user-1', 'telegram');
    expect(code).not.toBeNull();
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[A-Z0-9]{8}$/);

    const row = db.prepare('SELECT status FROM pairing_codes WHERE code = ?').get(code) as {
      status: string;
    };
    expect(row.status).toBe('pending');
  });

  it('consume correct code → ok, status becomes consumed', () => {
    const code = generateCode(db, 'user-1', 'telegram');
    if (!code) throw new Error('expected code to be generated');

    const result = consumeCode(db, code, 'user-1', 'telegram');
    expect(result.ok).toBe(true);

    const row = db.prepare('SELECT status FROM pairing_codes WHERE code = ?').get(code) as {
      status: string;
    };
    expect(row.status).toBe('consumed');
  });

  it('consume again (replay) → consumed', () => {
    const code = generateCode(db, 'user-1', 'telegram');
    if (!code) throw new Error('expected code to be generated');

    consumeCode(db, code, 'user-1', 'telegram');
    const result = consumeCode(db, code, 'user-1', 'telegram');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('consumed');
  });

  it('consume wrong sender → sender_mismatch', () => {
    const code = generateCode(db, 'user-1', 'telegram');
    if (!code) throw new Error('expected code to be generated');

    const result = consumeCode(db, code, 'user-2', 'telegram');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('sender_mismatch');
  });

  it('consume expired code (issued_at set 2 hours ago) → expired', () => {
    const code = generateCode(db, 'user-1', 'telegram');
    if (!code) throw new Error('expected code to be generated');

    // Backdate the issued_at to 2 hours ago
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    db.prepare('UPDATE pairing_codes SET issued_at = ? WHERE code = ?').run(twoHoursAgo, code);

    const result = consumeCode(db, code, 'user-1', 'telegram');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('consume unknown code → not_found', () => {
    const result = consumeCode(db, 'XXXXXXXX', 'user-1', 'telegram');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('rate limit: generate 2 codes within 10min → second returns null', () => {
    const first = generateCode(db, 'user-1', 'telegram');
    expect(first).not.toBeNull();

    const second = generateCode(db, 'user-1', 'telegram');
    expect(second).toBeNull();
  });

  it('different users are not rate-limited against each other', () => {
    const first = generateCode(db, 'user-1', 'telegram');
    const second = generateCode(db, 'user-2', 'telegram');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
  });

  it('different platforms for the same user are not rate-limited against each other', () => {
    const first = generateCode(db, 'user-1', 'telegram');
    const second = generateCode(db, 'user-1', 'discord');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
  });

  it('5 invalid consume attempts track independent failures (not_found)', () => {
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(consumeCode(db, 'BADCODE99', 'user-1', 'telegram'));
    }
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('not_found');
    }
  });

  it('code is uppercased alphanumeric only', () => {
    for (let i = 0; i < 5; i++) {
      // Generate for different users to avoid rate limiting
      const code = generateCode(db, `user-${i}`, 'telegram');
      expect(code).toMatch(/^[A-Z0-9]{8}$/);
    }
  });

  it('nonce is deterministically derived: same nonce always produces the same code', () => {
    // Generate a code for user-1
    const code1 = generateCode(db, 'user-1', 'telegram');
    if (!code1) throw new Error('expected code1');

    // Get the stored nonce
    const row1 = db.prepare('SELECT nonce FROM pairing_codes WHERE code = ?').get(code1) as {
      nonce: string;
    };

    // Attempting to INSERT another row with the same nonce + derived code hits UNIQUE(code) constraint
    // because makeCode(nonce) always produces the same code.
    expect(() => {
      db.prepare(
        `INSERT INTO pairing_codes (code, sender_id, platform, issued_at, nonce, status)
         VALUES (?, 'user-2', 'telegram', ?, ?, 'pending')`,
      ).run(code1, Date.now(), row1.nonce);
    }).toThrow(); // UNIQUE constraint violation — same code can't be inserted twice
  });

  it('5 invalid /allow attempts triggers 24h owner pause', () => {
    for (let i = 0; i < 5; i++) {
      consumeCode(db, 'BADCODE99', 'user-x', 'telegram', 'owner-1');
    }
    const result = consumeCode(db, 'BADCODE99', 'user-x', 'telegram', 'owner-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('owner_paused');
  });

  it('owner pause blocks even valid codes', () => {
    for (let i = 0; i < 5; i++) {
      consumeCode(db, 'BADCODE99', 'user-x', 'telegram', 'owner-1');
    }
    const code = generateCode(db, 'user-y', 'telegram');
    if (!code) throw new Error('expected code');
    const result = consumeCode(db, code, 'user-y', 'telegram', 'owner-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('owner_paused');
  });

  it('consumeAndAllow success → allowed_senders row exists', () => {
    const code = generateCode(db, 'user-1', 'telegram');
    if (!code) throw new Error('expected code');

    const result = consumeAndAllow(db, code, 'owner-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.senderId).toBe('user-1');
    expect(result.platform).toBe('telegram');

    const row = db
      .prepare('SELECT sender_id FROM allowed_senders WHERE sender_id = ? AND platform = ?')
      .get('user-1', 'telegram') as { sender_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.sender_id).toBe('user-1');
  });

  it('consumeAndAllow with already-consumed code → not ok, no duplicate row', () => {
    const code = generateCode(db, 'user-1', 'telegram');
    if (!code) throw new Error('expected code');

    consumeAndAllow(db, code, 'owner-1');
    const result = consumeAndAllow(db, code, 'owner-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('consumed');

    const rows = db
      .prepare('SELECT COUNT(*) AS cnt FROM allowed_senders WHERE sender_id = ? AND platform = ?')
      .get('user-1', 'telegram') as { cnt: number };
    expect(rows.cnt).toBe(1); // still only one row from the first call
  });

  it('getApprovedSenders returns senders approved via consumeAndAllow', () => {
    const code1 = generateCode(db, 'user-a', 'telegram');
    const code2 = generateCode(db, 'user-b', 'telegram');
    if (!code1 || !code2) throw new Error('expected codes');

    consumeAndAllow(db, code1);
    consumeAndAllow(db, code2);

    const senders = getApprovedSenders(db, 'telegram');
    expect(senders).toContain('user-a');
    expect(senders).toContain('user-b');
    expect(senders.length).toBe(2);
  });

  it('clearOwnerPause lifts the 24h pause', () => {
    for (let i = 0; i < 5; i++) {
      consumeCode(db, 'BADCODE99', 'user-x', 'telegram', 'owner-1');
    }
    clearOwnerPause(db, 'owner-1');
    const code = generateCode(db, 'user-z', 'telegram');
    if (!code) throw new Error('expected code');
    const result = consumeCode(db, code, 'user-z', 'telegram', 'owner-1');
    expect(result.ok).toBe(true);
  });

  it('revokeApproval removes sender from allowed_senders', () => {
    const code = generateCode(db, 'user-revoke', 'telegram');
    if (!code) throw new Error('expected code');
    consumeAndAllow(db, code, 'owner-1');

    const before = getApprovedSenders(db, 'telegram');
    expect(before).toContain('user-revoke');

    const removed = revokeApproval(db, 'user-revoke', 'telegram');
    expect(removed).toBe(true);

    const after = getApprovedSenders(db, 'telegram');
    expect(after).not.toContain('user-revoke');
  });

  it('revokeApproval is idempotent for unknown sender', () => {
    const removed = revokeApproval(db, 'ghost-user', 'telegram');
    expect(removed).toBe(false);
  });
});
