import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consumeCode, generateCode, initPairingDb } from '../pairing-store';

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
});
