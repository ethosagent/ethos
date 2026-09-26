import Database from '@ethosagent/sqlite';
import { describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../../stores/idempotency-store';

function busyTimeout(db: Database.Database): number {
  const rows = db.pragma('busy_timeout') as Array<{ timeout: number }>;
  return rows[0]?.timeout ?? -1;
}

describe('IdempotencyStore — busy_timeout', () => {
  it('its own sessions.db connection waits 5000ms instead of throwing SQLITE_BUSY', () => {
    // It opens a second connection on sessions.db, which gateway + serve + CLI
    // all hold. The @ethosagent/sqlite default is 0 ("database is locked").
    const store = new IdempotencyStore(':memory:');
    const db = (store as unknown as { db: Database.Database }).db;
    expect(busyTimeout(db)).toBe(5000);
    db.close();
  });

  it("leaves a borrowed handle's settings alone", () => {
    const db = new Database(':memory:');
    new IdempotencyStore(db);
    expect(busyTimeout(db)).toBe(0);
    db.close();
  });
});
