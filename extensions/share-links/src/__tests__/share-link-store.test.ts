import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AmbiguousSharePrefixError,
  type CreateShareLinkInput,
  hashShareToken,
  MAX_SNAPSHOT_BYTES,
  SharePrefixTooShortError,
  SnapshotTooLargeError,
  SqliteShareLinkStore,
} from '../index';

const T0 = new Date('2026-11-22T12:00:00.000Z');
const HOUR = 3_600_000;
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

function input(overrides: Partial<CreateShareLinkInput> = {}): CreateShareLinkInput {
  return {
    sessionId: 'web:s1',
    personalityId: 'researcher',
    title: 'A chat',
    options: '{"includeToolNames":false,"pii":true}',
    snapshot: '{"v":1,"turns":[]}',
    expiresAt: at(HOUR),
    actor: 'web:admin',
    ...overrides,
  };
}

/** Raw handle on the store's own connection — `synchronous` is per-connection. */
function rawDb(store: unknown): Database.Database {
  return (store as { db: Database.Database }).db;
}

describe('SqliteShareLinkStore — create', () => {
  let store: SqliteShareLinkStore;
  beforeEach(() => {
    store = new SqliteShareLinkStore(':memory:', { now: () => T0 });
  });
  afterEach(() => store.close());

  it('generates a 32-byte base64url token (43 chars)', () => {
    const { token } = store.create(input());
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.create(input()).token).not.toBe(token);
  });

  it('stores the sha256 hash, never the token, in any column', () => {
    const { token, record } = store.create(input());
    expect(record.prefix).toBe(token.slice(0, 8));
    const row = rawDb(store).prepare('SELECT * FROM share_links').get() as Record<string, unknown>;
    expect(row.token_hash).toBe(hashShareToken(token));
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    for (const value of Object.values(row)) {
      expect(String(value)).not.toContain(token);
    }
    const events = rawDb(store).prepare('SELECT * FROM share_link_events').all();
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it('appends a created event carrying the actor', () => {
    const { record } = store.create(input({ actor: 'cli' }));
    expect(store.listEvents(record.id)).toEqual([
      expect.objectContaining({ linkId: record.id, kind: 'created', actor: 'cli' }),
    ]);
  });

  it('refuses a snapshot over 2 MB with a typed error naming the limit', () => {
    expect(MAX_SNAPSHOT_BYTES).toBe(2 * 1024 * 1024);
    const big = 'x'.repeat(MAX_SNAPSHOT_BYTES + 1);
    let caught: unknown;
    try {
      store.create(input({ snapshot: big }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SnapshotTooLargeError);
    expect((caught as Error).message).toContain('2097152');
    expect((caught as SnapshotTooLargeError).limitBytes).toBe(MAX_SNAPSHOT_BYTES);
    expect(rawDb(store).prepare('SELECT COUNT(*) AS n FROM share_links').get()).toEqual({ n: 0 });
  });

  it('measures the cap in bytes, not characters', () => {
    const multibyte = 'é'.repeat(MAX_SNAPSHOT_BYTES / 2 + 1); // 2 bytes each
    expect(() => store.create(input({ snapshot: multibyte }))).toThrow(SnapshotTooLargeError);
  });
});

describe('SqliteShareLinkStore — findLive', () => {
  let store: SqliteShareLinkStore;
  beforeEach(() => {
    store = new SqliteShareLinkStore(':memory:', { now: () => T0 });
  });
  afterEach(() => store.close());

  it('returns the row with its snapshot while live', () => {
    const { token, record } = store.create(input());
    const found = store.findLive(hashShareToken(token), T0);
    expect(found?.id).toBe(record.id);
    expect(found?.snapshot).toBe('{"v":1,"turns":[]}');
  });

  it('misses an unknown hash', () => {
    expect(store.findLive(hashShareToken('nope'), T0)).toBeNull();
  });

  it('misses a revoked row', () => {
    const { token, record } = store.create(input());
    store.revoke(record.id, 'cli');
    expect(store.findLive(hashShareToken(token), T0)).toBeNull();
  });

  it('misses an expired row, including at the exact expiry instant', () => {
    const { token } = store.create(input());
    expect(store.findLive(hashShareToken(token), at(HOUR - 1))).not.toBeNull();
    expect(store.findLive(hashShareToken(token), at(HOUR))).toBeNull();
    expect(store.findLive(hashShareToken(token), at(HOUR + 1))).toBeNull();
  });
});

describe('SqliteShareLinkStore — revoke', () => {
  let store: SqliteShareLinkStore;
  beforeEach(() => {
    store = new SqliteShareLinkStore(':memory:', { now: () => T0 });
  });
  afterEach(() => store.close());

  it('revoke purges the snapshot and appends a revoked event in one transaction', () => {
    const { record } = store.create(input());
    const revoked = store.revoke(record.id, 'web:admin');
    expect(revoked?.revokedAt).toBe(T0.toISOString());
    const row = rawDb(store)
      .prepare('SELECT snapshot, revoked_at FROM share_links WHERE id = ?')
      .get(record.id);
    expect(row).toEqual({ snapshot: null, revoked_at: T0.toISOString() });
    expect(store.listEvents(record.id).map((e) => [e.kind, e.actor])).toEqual([
      ['created', 'web:admin'],
      ['revoked', 'web:admin'],
    ]);
  });

  it('rolls the snapshot null-out back if the event insert fails', () => {
    const { record } = store.create(input());
    rawDb(store).exec('DROP TABLE share_link_events');
    expect(() => store.revoke(record.id, 'cli')).toThrow();
    const row = rawDb(store)
      .prepare('SELECT snapshot, revoked_at FROM share_links WHERE id = ?')
      .get(record.id) as { snapshot: string | null; revoked_at: string | null };
    expect(row.snapshot).not.toBeNull();
    expect(row.revoked_at).toBeNull();
  });

  it('resolves by prefix', () => {
    const { token, record } = store.create(input());
    expect(store.revoke(token.slice(0, 8), 'cli')?.id).toBe(record.id);
  });

  it('returns null for an unknown or empty reference', () => {
    store.create(input());
    expect(store.revoke('zzzzzzzz', 'cli')).toBeNull();
    expect(store.revoke('', 'cli')).toBeNull();
  });

  it('is idempotent: a second revoke adds no event', () => {
    const { record } = store.create(input());
    store.revoke(record.id, 'cli');
    const again = store.revoke(record.id, 'cli');
    expect(again?.revokedAt).toBe(T0.toISOString());
    expect(store.listEvents(record.id)).toHaveLength(2);
  });

  it('refuses an ambiguous prefix with a typed error and revokes nothing', () => {
    const a = store.create(input());
    const b = store.create(input());
    // Force a shared prefix: both rows now start with "AAAAAAAA".
    rawDb(store)
      .prepare('UPDATE share_links SET prefix = ? WHERE id = ?')
      .run('AAAAAAAA', a.record.id);
    rawDb(store)
      .prepare('UPDATE share_links SET prefix = ? WHERE id = ?')
      .run('AAAAAAAB', b.record.id);
    let caught: unknown;
    try {
      store.revoke('AAAAAAA', 'cli');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AmbiguousSharePrefixError);
    expect((caught as AmbiguousSharePrefixError).prefix).toBe('AAAAAAA');
    expect(store.list({ activeOnly: true })).toHaveLength(2);
    // A longer prefix disambiguates.
    expect(store.revoke('AAAAAAAB', 'cli')?.id).toBe(b.record.id);
  });

  it('a revoked twin does not make a prefix ambiguous for the live link', () => {
    const a = store.create(input());
    const b = store.create(input());
    const db = rawDb(store);
    db.prepare('UPDATE share_links SET prefix = ? WHERE id = ?').run('AAAAAAAA', a.record.id);
    db.prepare('UPDATE share_links SET prefix = ? WHERE id = ?').run('AAAAAAAB', b.record.id);
    store.revoke(a.record.id, 'cli');
    expect(store.revoke('AAAAAA', 'cli')?.id).toBe(b.record.id);
    expect(store.findLive(hashShareToken(b.token), T0)).toBeNull();
  });

  it('refuses a prefix under 4 chars with a typed error; an exact id still works', () => {
    const { record } = store.create(input());
    for (const short of ['a', record.prefix.slice(0, 3)]) {
      expect(() => store.revoke(short, 'cli')).toThrow(SharePrefixTooShortError);
    }
    expect(store.list({ activeOnly: true })).toHaveLength(1);
    expect(store.revoke(record.prefix.slice(0, 4), 'cli')?.id).toBe(record.id);
    const other = store.create(input());
    expect(store.revoke(other.record.id, 'cli')?.id).toBe(other.record.id);
  });

  it('revokeForSession revokes every live link of that session only', () => {
    const a = store.create(input({ sessionId: 'web:s1' }));
    const b = store.create(input({ sessionId: 'web:s1' }));
    const other = store.create(input({ sessionId: 'web:s2' }));
    expect(store.revokeForSession('web:s1', 'web:admin')).toBe(2);
    expect(store.findLive(hashShareToken(a.token), T0)).toBeNull();
    expect(store.findLive(hashShareToken(b.token), T0)).toBeNull();
    expect(store.findLive(hashShareToken(other.token), T0)).not.toBeNull();
    expect(store.listEvents(a.record.id).map((e) => e.kind)).toEqual(['created', 'revoked']);
    expect(store.revokeForSession('web:s1', 'web:admin')).toBe(0);
  });
});

describe('SqliteShareLinkStore — purgeExpired', () => {
  let store: SqliteShareLinkStore;
  beforeEach(() => {
    store = new SqliteShareLinkStore(':memory:', { now: () => T0 });
  });
  afterEach(() => store.close());

  it('nulls the snapshot of expired rows and appends a purged event', () => {
    const old = store.create(input({ expiresAt: at(HOUR) }));
    const fresh = store.create(input({ expiresAt: at(10 * HOUR) }));
    expect(store.purgeExpired(at(2 * HOUR))).toBe(1);
    const row = rawDb(store)
      .prepare('SELECT snapshot FROM share_links WHERE id = ?')
      .get(old.record.id);
    expect(row).toEqual({ snapshot: null });
    expect(store.listEvents(old.record.id).map((e) => [e.kind, e.actor])).toEqual([
      ['created', 'web:admin'],
      ['purged', 'system'],
    ]);
    expect(store.findLive(hashShareToken(fresh.token), at(2 * HOUR))).not.toBeNull();
  });

  it('purges once only and skips already-revoked rows', () => {
    const revoked = store.create(input());
    store.revoke(revoked.record.id, 'cli');
    store.create(input());
    expect(store.purgeExpired(at(2 * HOUR))).toBe(1);
    expect(store.purgeExpired(at(2 * HOUR))).toBe(0);
    expect(store.listEvents(revoked.record.id).map((e) => e.kind)).toEqual(['created', 'revoked']);
  });

  it('records the supplied actor', () => {
    const { record } = store.create(input());
    store.purgeExpired(at(2 * HOUR), 'cli');
    expect(store.listEvents(record.id).at(-1)).toMatchObject({ kind: 'purged', actor: 'cli' });
  });
});

describe('SqliteShareLinkStore — recordView and list', () => {
  let clock: Date;
  let store: SqliteShareLinkStore;
  beforeEach(() => {
    clock = T0;
    store = new SqliteShareLinkStore(':memory:', { now: () => clock });
  });
  afterEach(() => store.close());

  it('recordView bumps view_count and last_viewed_at', () => {
    const { record } = store.create(input());
    store.recordView(record.id, at(5 * 60_000));
    store.recordView(record.id, at(6 * 60_000));
    const [row] = store.list({ activeOnly: false });
    expect(row?.viewCount).toBe(2);
    expect(row?.lastViewedAt).toBe(at(6 * 60_000).toISOString());
  });

  it('list orders newest first with a rowid tie-break at equal timestamps', () => {
    const a = store.create(input({ title: 'a' }));
    const b = store.create(input({ title: 'b' }));
    const c = store.create(input({ title: 'c' }));
    expect(store.list({ activeOnly: false }).map((r) => r.id)).toEqual([
      c.record.id,
      b.record.id,
      a.record.id,
    ]);
  });

  it('list never carries the snapshot', () => {
    store.create(input());
    expect(Object.keys(store.list({ activeOnly: false })[0] ?? {})).not.toContain('snapshot');
  });

  it('activeOnly hides revoked and expired rows', () => {
    const live = store.create(input({ expiresAt: at(10 * HOUR) }));
    const revoked = store.create(input({ expiresAt: at(10 * HOUR) }));
    store.create(input({ expiresAt: at(HOUR) }));
    store.revoke(revoked.record.id, 'cli');
    clock = at(2 * HOUR);
    expect(store.list({ activeOnly: true }).map((r) => r.id)).toEqual([live.record.id]);
    expect(store.list({ activeOnly: false })).toHaveLength(3);
  });
});

describe('SqliteShareLinkStore — append-only events and schema', () => {
  it('exposes no update or delete method for events', () => {
    const names = Object.getOwnPropertyNames(SqliteShareLinkStore.prototype);
    const eventMutators = names.filter(
      (n) => /event/i.test(n) && /(update|delete|remove|clear|edit|set)/i.test(n),
    );
    expect(eventMutators).toEqual([]);
    expect(names).toContain('listEvents');
  });

  it('declares both tables STRICT', () => {
    const store = new SqliteShareLinkStore(':memory:');
    const tables = rawDb(store)
      .prepare(
        `SELECT name, strict FROM pragma_table_list WHERE name IN ('share_links','share_link_events')`,
      )
      .all() as Array<{ name: string; strict: number }>;
    expect(tables.map((t) => [t.name, t.strict]).sort()).toEqual([
      ['share_link_events', 1],
      ['share_links', 1],
    ]);
    store.close();
  });

  it("rejects an event kind outside 'created' | 'revoked' | 'purged'", () => {
    const store = new SqliteShareLinkStore(':memory:');
    expect(() =>
      rawDb(store)
        .prepare(
          `INSERT INTO share_link_events (link_id, kind, actor, at) VALUES ('x','viewed','cli','t')`,
        )
        .run(),
    ).toThrow();
    store.close();
  });
});

describe('SqliteShareLinkStore — durability posture', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share-links-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stays at synchronous = FULL in WAL mode', () => {
    // A revoke that a power cut can roll back reopens a public URL (plan D10),
    // so this store must never be swept to synchronous = NORMAL.
    const store = new SqliteShareLinkStore(join(dir, 'nested', 'share-links.db'));
    const sync = rawDb(store).pragma('synchronous') as Array<{ synchronous: number }>;
    expect(sync[0]?.synchronous).toBe(2);
    const mode = rawDb(store).pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(mode[0]?.journal_mode).toBe('wal');
    store.close();
  });
});

describe('SqliteShareLinkStore — revokeOrphans', () => {
  let store: SqliteShareLinkStore;
  beforeEach(() => {
    store = new SqliteShareLinkStore(':memory:', { now: () => T0 });
  });
  afterEach(() => store.close());

  it('revokes live links whose session no longer exists, as a system `revoked` event, and no others', async () => {
    const gone1 = store.create(input({ sessionId: 'gone' })).record;
    const gone2 = store.create(input({ sessionId: 'gone' })).record;
    const kept = store.create(input({ sessionId: 'kept' })).record;
    const alreadyRevoked = store.create(input({ sessionId: 'gone2' })).record;
    store.revoke(alreadyRevoked.id, 'web:admin');
    const asked: string[] = [];
    const n = await store.revokeOrphans(async (id) => {
      asked.push(id);
      return id === 'kept';
    }, 'system');
    expect(n).toBe(2);
    // One existence check per distinct session with a live link (batch-friendly).
    expect(asked.sort()).toEqual(['gone', 'kept']);
    for (const r of [gone1, gone2]) {
      expect(store.listEvents(r.id).map((e) => [e.kind, e.actor])).toEqual([
        ['created', 'web:admin'],
        ['revoked', 'system'],
      ]);
    }
    expect(store.list({ activeOnly: true }).map((r) => r.id)).toEqual([kept.id]);
    // The already-revoked link gained no second event.
    expect(store.listEvents(alreadyRevoked.id)).toHaveLength(2);
  });

  it('an existence check that throws aborts the sweep and revokes nothing for that session', async () => {
    const link = store.create(input({ sessionId: 's' })).record;
    await expect(
      store.revokeOrphans(async () => {
        throw new Error('sessions.db busy');
      }, 'system'),
    ).rejects.toThrow('sessions.db busy');
    expect(store.list({ activeOnly: true }).map((r) => r.id)).toEqual([link.id]);
  });
});

describe('SqliteShareLinkStore — world links', () => {
  let store: SqliteShareLinkStore;
  beforeEach(() => {
    store = new SqliteShareLinkStore(':memory:', { now: () => T0 });
  });
  afterEach(() => store.close());

  it('revoke purges the world snapshot', () => {
    const a = store.create(input({ sessionId: 'world:acme', kind: 'world' })).record;
    const b = store.create(input({ sessionId: 'world:acme', kind: 'world' })).record;
    const other = store.create(input({ sessionId: 'world:other', kind: 'world' })).record;
    expect(a.kind).toBe('world');
    expect(a.subjectId).toBe('world:acme');
    expect(store.revoke(a.id, 'web:admin')?.snapshot).toBeNull();
    expect(store.revokeForSubject('world:acme', 'web:admin')).toBe(1);
    const snaps = rawDb(store)
      .prepare('SELECT id, snapshot FROM share_links WHERE session_id = ? ORDER BY rowid')
      .all('world:acme') as Array<{ id: string; snapshot: string | null }>;
    expect(snaps.map((r) => r.snapshot)).toEqual([null, null]);
    expect(store.listEvents(b.id).map((e) => e.kind)).toEqual(['created', 'revoked']);
    expect(store.list({ activeOnly: true }).map((r) => r.id)).toEqual([other.id]);
  });

  it('the orphan sweep never revokes a world link, and list can filter by kind', async () => {
    const world = store.create(input({ sessionId: 'world:acme', kind: 'world' })).record;
    const sess = store.create(input({ sessionId: 'gone' })).record;
    const asked: string[] = [];
    expect(
      await store.revokeOrphans(async (id) => {
        asked.push(id);
        return false;
      }, 'system'),
    ).toBe(1);
    expect(asked).toEqual(['gone']);
    expect(store.list({ activeOnly: true, kind: 'world' }).map((r) => r.id)).toEqual([world.id]);
    expect(store.list({ activeOnly: false, kind: 'session' }).map((r) => r.id)).toEqual([sess.id]);
  });
});

describe('SqliteShareLinkStore — migration', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share-links-mig-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('migration keeps existing rows as kind session', () => {
    const path = join(dir, 'share-links.db');
    // A v1 file: no `kind` column, user_version 1.
    const old = new Database(path);
    old.exec(`CREATE TABLE share_links (
      id TEXT PRIMARY KEY, prefix TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL, personality_id TEXT NOT NULL, title TEXT NOT NULL,
      options TEXT NOT NULL, snapshot TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      revoked_at TEXT, view_count INTEGER NOT NULL DEFAULT 0, last_viewed_at TEXT
    ) STRICT;
    CREATE TABLE share_link_events (
      id INTEGER PRIMARY KEY, link_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('created', 'revoked', 'purged')),
      actor TEXT NOT NULL, at TEXT NOT NULL
    ) STRICT;`);
    old
      .prepare(
        `INSERT INTO share_links (id, prefix, token_hash, session_id, personality_id, title, options, snapshot, created_at, expires_at)
         VALUES ('l1', 'abcdefgh', 'h1', 'web:s1', 'p', 't', '{}', '{}', ?, ?)`,
      )
      .run(T0.toISOString(), at(HOUR).toISOString());
    old.pragma('user_version = 1');
    old.close();

    const store = new SqliteShareLinkStore(path, { now: () => T0 });
    const rows = store.list({ activeOnly: false });
    expect(rows.map((r) => [r.id, r.kind, r.subjectId])).toEqual([['l1', 'session', 'web:s1']]);
    store.close();
    // Opening again is a no-op (idempotent).
    const again = new SqliteShareLinkStore(path, { now: () => T0 });
    expect(again.list({ activeOnly: false })).toHaveLength(1);
    again.close();
  });
});
