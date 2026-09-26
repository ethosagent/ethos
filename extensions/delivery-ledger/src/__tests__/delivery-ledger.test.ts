import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteDeliveryLedger } from '../index';

function ledger() {
  return new SQLiteDeliveryLedger(':memory:');
}

function input(overrides: Partial<Parameters<SQLiteDeliveryLedger['record']>[0]> = {}) {
  return {
    botKey: 'bot-a',
    platform: 'telegram',
    chatId: 'chat-1',
    sessionId: 'telegram:bot-a:chat-1',
    content: 'the reply',
    ...overrides,
  };
}

describe('SQLiteDeliveryLedger — record / confirm', () => {
  let store: SQLiteDeliveryLedger;
  beforeEach(() => {
    store = ledger();
  });

  it('records a pending obligation with a content hash', async () => {
    const id = await store.record(input());
    const row = await store.get(id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('pending');
    expect(row?.botKey).toBe('bot-a');
    expect(row?.content).toBe('the reply');
    // sha256 hex.
    expect(row?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('markDelivered flips the row and removes it from the pending pool', async () => {
    const id = await store.record(input());
    await store.markDelivered(id);
    expect((await store.get(id))?.status).toBe('delivered');
    expect(await store.listPending(['bot-a'])).toHaveLength(0);
  });

  it('get returns null for an unknown id', async () => {
    expect(await store.get('nope')).toBeNull();
  });
});

describe('SQLiteDeliveryLedger — ownership', () => {
  it('listPending only returns obligations for the caller-owned botKeys', async () => {
    const store = ledger();
    const a = await store.record(input({ botKey: 'bot-a' }));
    const b = await store.record(input({ botKey: 'bot-b' }));
    const c = await store.record(input({ botKey: 'bot-c' }));

    const owned = await store.listPending(['bot-a', 'bot-b']);
    expect(owned.map((o) => o.id).sort()).toEqual([a, b].sort());
    // bot-c belongs to a different deployment sharing the ledger file.
    expect(owned.some((o) => o.id === c)).toBe(false);
    expect((await store.get(c))?.status).toBe('pending');
  });

  it('a process owning no bots owns no obligations', async () => {
    const store = ledger();
    await store.record(input());
    expect(await store.listPending([])).toEqual([]);
  });

  it('orders pending obligations oldest-first', async () => {
    const store = ledger();
    const first = await store.record(input({ content: 'one' }));
    const second = await store.record(input({ content: 'two' }));
    const pending = await store.listPending(['bot-a']);
    expect(pending.map((o) => o.id)).toEqual([first, second]);
  });
});

describe('SQLiteDeliveryLedger — atomic claim', () => {
  it('exactly one of two claims on the same row wins', async () => {
    const store = ledger();
    const id = await store.record(input());

    const [a, b] = await Promise.all([store.claim(id), store.claim(id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await store.get(id))?.status).toBe('redelivering');
  });

  it('two ledger handles on ONE db file claim each obligation exactly once', () => {
    // Two processes sharing a ledger, modelled as two handles over one db.
    // The conditional UPDATE is what separates them; a read-then-write check
    // would let both win.
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE delivery_obligations (
        id TEXT PRIMARY KEY, bot_key TEXT NOT NULL, platform TEXT NOT NULL,
        chat_id TEXT NOT NULL, session_id TEXT NOT NULL, content_hash TEXT NOT NULL,
        content TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL,
        thread_id TEXT
      ) STRICT;
      INSERT INTO delivery_obligations
      VALUES ('x','bot-a','telegram','c','s','h','body',1,'pending',NULL);
    `);
    const claimOnce = () =>
      db
        .prepare(
          `UPDATE delivery_obligations SET status = 'redelivering'
           WHERE id = ? AND status = 'pending'`,
        )
        .run('x').changes === 1;
    expect([claimOnce(), claimOnce()].filter(Boolean)).toHaveLength(1);
    db.close();
  });

  it('claim fails on an already-delivered row', async () => {
    const store = ledger();
    const id = await store.record(input());
    await store.markDelivered(id);
    expect(await store.claim(id)).toBe(false);
  });

  it('release returns a claimed row to the pending pool', async () => {
    const store = ledger();
    const id = await store.record(input());
    expect(await store.claim(id)).toBe(true);
    expect(await store.listPending(['bot-a'])).toHaveLength(0);
    await store.release(id);
    expect((await store.get(id))?.status).toBe('pending');
    expect(await store.listPending(['bot-a'])).toHaveLength(1);
  });

  it('release never resurrects a delivered row', async () => {
    const store = ledger();
    const id = await store.record(input());
    await store.markDelivered(id);
    await store.release(id);
    expect((await store.get(id))?.status).toBe('delivered');
  });
});

describe('SQLiteDeliveryLedger — retention', () => {
  it('prunes delivered rows past the cutoff and never prunes pending ones', async () => {
    const store = ledger();
    const old = await store.record(input({ content: 'old delivered' }));
    const recent = await store.record(input({ content: 'recent delivered' }));
    const stuck = await store.record(input({ content: 'never confirmed' }));
    await store.markDelivered(old);
    await store.markDelivered(recent);

    // Backdate the two rows we want treated as aged.
    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    const ancient = Date.now() - 8 * 86_400_000;
    db.prepare('UPDATE delivery_obligations SET created_at = ? WHERE id IN (?, ?)').run(
      ancient,
      old,
      stuck,
    );

    const removed = await store.pruneDelivered(Date.now() - 7 * 86_400_000);
    expect(removed).toBe(1);
    expect(await store.get(old)).toBeNull();
    expect((await store.get(recent))?.status).toBe('delivered');
    // Pending is never pruned, however old — an aged pending row is not proof
    // of a crash, and it is the entire point of the ledger.
    expect((await store.get(stuck))?.status).toBe('pending');
  });

  it('does not prune a claimed (redelivering) row', async () => {
    const store = ledger();
    const id = await store.record(input());
    await store.claim(id);
    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    db.prepare('UPDATE delivery_obligations SET created_at = 0 WHERE id = ?').run(id);
    expect(await store.pruneDelivered(Date.now())).toBe(0);
    expect((await store.get(id))?.status).toBe('redelivering');
  });
});

describe('SQLiteDeliveryLedger — schema', () => {
  it('creates a STRICT table stamped at the current user_version', async () => {
    const store = ledger();
    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    const sql = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='delivery_obligations'`)
      .get() as { sql: string };
    expect(sql.sql).toMatch(/STRICT/);

    const version = db.pragma('user_version') as Array<{ user_version: number }>;
    expect(version[0]?.user_version).toBe(6);

    // STRICT enforcement is real: a TEXT into an INTEGER column throws.
    expect(() =>
      db
        .prepare(
          `INSERT INTO delivery_obligations
           (id, bot_key, platform, chat_id, session_id, content_hash, content, created_at, status)
           VALUES ('bad','b','p','c','s','h','x','not-a-number','pending')`,
        )
        .run(),
    ).toThrow();
  });

  it('survives reopening an existing database (idempotent migration)', async () => {
    // A file-backed round trip is the only way to reopen; :memory: dies with
    // the handle. tmpdir keeps it out of ~/.ethos.
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'delivery-ledger-'));
    const path = join(dir, 'nested', 'delivery.db');
    try {
      const first = new SQLiteDeliveryLedger(path);
      const id = await first.record(input());
      first.close();

      const second = new SQLiteDeliveryLedger(path);
      expect((await second.get(id))?.content).toBe('the reply');
      expect(await second.listPending(['bot-a'])).toHaveLength(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips the thread a reply belonged to', async () => {
    const store = ledger();
    const threaded = await store.record(input({ threadId: 'thread-7' }));
    const rootChat = await store.record(input({ content: 'root reply' }));

    expect((await store.get(threaded))?.threadId).toBe('thread-7');
    // Absent, not '' and not the string 'null' — an adapter would forward
    // either of those to the platform verbatim.
    expect((await store.get(rootChat))?.threadId).toBeUndefined();

    const pending = await store.listPending(['bot-a']);
    expect(pending.map((o) => o.threadId)).toEqual(['thread-7', undefined]);
  });

  it('normalizes an empty-string threadId to no thread', async () => {
    const store = ledger();
    const id = await store.record(input({ threadId: '' }));
    expect((await store.get(id))?.threadId).toBeUndefined();
    // NULL in the column, not ''.
    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    const row = db.prepare('SELECT thread_id FROM delivery_obligations WHERE id = ?').get(id) as {
      thread_id: string | null;
    };
    expect(row.thread_id).toBeNull();
  });

  it('refuses to open a database written by newer code', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'delivery-ledger-'));
    const path = join(dir, 'delivery.db');
    try {
      const first = new SQLiteDeliveryLedger(path);
      const db = (first as unknown as { db: InstanceType<typeof Database> }).db;
      db.pragma('user_version = 99');
      first.close();
      expect(() => new SQLiteDeliveryLedger(path)).toThrow(/refusing to open/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// v1 → v3 migration
//
// The shipped v1 table had no `thread_id`. Nothing has run it in production,
// but the migration PATH is the thing under test: a table that can only be
// created fresh is a table whose migration story is untested. A v1 file now
// also has to survive the v3 step, so this covers the whole chain in one hop —
// the case a long-idle deployment actually hits.
// ---------------------------------------------------------------------------

/** The exact v1 schema, stamped at user_version = 1. */
const V1_SCHEMA = `
  CREATE TABLE delivery_obligations (
    id           TEXT PRIMARY KEY,
    bot_key      TEXT NOT NULL,
    platform     TEXT NOT NULL,
    chat_id      TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
  ) STRICT;

  CREATE INDEX delivery_status_bot ON delivery_obligations(status, bot_key);
  CREATE INDEX delivery_status_created ON delivery_obligations(status, created_at);
`;

describe('SQLiteDeliveryLedger — v1 → v3 migration', () => {
  let dir: string;
  let path: string;
  let rm: (p: string, o: { recursive: boolean; force: boolean }) => void;

  beforeEach(async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    rm = rmSync;
    dir = mkdtempSync(join(tmpdir(), 'delivery-ledger-v1-'));
    path = join(dir, 'delivery.db');

    // A v1 ledger with two rows already in it.
    const db = new Database(path);
    db.exec(V1_SCHEMA);
    db.pragma('user_version = 1');
    db.prepare(
      `INSERT INTO delivery_obligations
       (id, bot_key, platform, chat_id, session_id, content_hash, content, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('old-1', 'bot-a', 'telegram', 'chat-1', 'sess-1', 'hash-1', 'survivor', 1, 'pending');
    db.prepare(
      `INSERT INTO delivery_obligations
       (id, bot_key, platform, chat_id, session_id, content_hash, content, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('old-2', 'bot-a', 'telegram', 'chat-2', 'sess-2', 'hash-2', 'confirmed', 2, 'delivered');
    db.close();
  });

  afterEach(() => {
    rm(dir, { recursive: true, force: true });
  });

  it('upgrades to v3 without losing pre-existing rows', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
      const version = db.pragma('user_version') as Array<{ user_version: number }>;
      expect(version[0]?.user_version).toBe(6);

      const survivor = await store.get('old-1');
      expect(survivor?.content).toBe('survivor');
      expect(survivor?.status).toBe('pending');
      expect(await store.get('old-2')).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it('gives pre-existing rows a null threadId, so they redeliver to the root chat', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      // Still sweepable, and with no thread claim it could not honour.
      const pending = await store.listPending(['bot-a']);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBe('old-1');
      expect(pending[0]?.threadId).toBeUndefined();

      const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
      const raw = db
        .prepare(`SELECT thread_id FROM delivery_obligations WHERE id = 'old-1'`)
        .get() as { thread_id: string | null };
      expect(raw.thread_id).toBeNull();
    } finally {
      store.close();
    }
  });

  it('keeps the table STRICT after the migration', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
      const sql = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='delivery_obligations'`)
        .get() as { sql: string };
      expect(sql.sql).toMatch(/STRICT/);
      expect(sql.sql).toMatch(/thread_id/);

      // Enforcement is real, not just the keyword surviving in the DDL text.
      expect(() =>
        db
          .prepare(
            `INSERT INTO delivery_obligations
             (id, bot_key, platform, chat_id, session_id, content_hash, content, created_at,
              status, thread_id)
             VALUES ('bad','b','p','c','s','h','x','not-a-number','pending',NULL)`,
          )
          .run(),
      ).toThrow();
      // ...including on the column the migration added. (A number would be
      // losslessly coerced to TEXT even under STRICT; a BLOB is what STRICT
      // actually refuses.)
      expect(() =>
        db
          .prepare(`UPDATE delivery_obligations SET thread_id = x'deadbeef' WHERE id = 'old-1'`)
          .run(),
      ).toThrow();
    } finally {
      store.close();
    }
  });

  it('a migrated ledger accepts new threaded writes', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      const id = await store.record({
        botKey: 'bot-a',
        platform: 'slack',
        chatId: 'C1',
        sessionId: 'slack:bot-a:C1:1700.1',
        threadId: '1700.1',
        content: 'threaded after upgrade',
      });
      expect((await store.get(id))?.threadId).toBe('1700.1');
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Voice obligations (v3)
// ---------------------------------------------------------------------------

describe('SQLiteDeliveryLedger — voice obligations', () => {
  it('round-trips a voice obligation through get and listPending', async () => {
    const store = ledger();
    const id = await store.record(
      input({
        content: 'the spoken words',
        kind: 'voice',
        artifactRef: 'voice/2026-08-14/abc.ogg',
        mediaFormat: 'ogg_opus',
      }),
    );

    const row = await store.get(id);
    expect(row?.kind).toBe('voice');
    expect(row?.artifactRef).toBe('voice/2026-08-14/abc.ogg');
    expect(row?.mediaFormat).toBe('ogg_opus');
    // The spoken text is stored, not a placeholder: the row stays readable and
    // still hashes to something a dedup comparison can use.
    expect(row?.content).toBe('the spoken words');
    expect(row?.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const pending = await store.listPending(['bot-a']);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.artifactRef).toBe('voice/2026-08-14/abc.ogg');
    expect(pending[0]?.mediaFormat).toBe('ogg_opus');
  });

  it('defaults an obligation with no kind to text, with no media fields', async () => {
    const store = ledger();
    const id = await store.record(input());
    const row = await store.get(id);
    expect(row?.kind).toBe('text');
    // Absent, not '' — a caller that forwarded '' to an artifact store would
    // fail late and confusingly.
    expect(row?.artifactRef).toBeUndefined();
    expect(row?.mediaFormat).toBeUndefined();

    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    const raw = db
      .prepare('SELECT artifact_ref, media_format FROM delivery_obligations WHERE id = ?')
      .get(id) as { artifact_ref: string | null; media_format: string | null };
    expect(raw.artifact_ref).toBeNull();
    expect(raw.media_format).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// v2 → v3 migration
//
// The v2 shape is the one deployments actually have on disk today, so this is
// the upgrade that has to be right.
// ---------------------------------------------------------------------------

/** The exact v2 schema, stamped at user_version = 2. */
const V2_SCHEMA = `
  CREATE TABLE delivery_obligations (
    id           TEXT PRIMARY KEY,
    bot_key      TEXT NOT NULL,
    platform     TEXT NOT NULL,
    chat_id      TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    thread_id    TEXT
  ) STRICT;

  CREATE INDEX delivery_status_bot ON delivery_obligations(status, bot_key);
  CREATE INDEX delivery_status_created ON delivery_obligations(status, created_at);
`;

describe('SQLiteDeliveryLedger — v2 → v3 migration', () => {
  let dir: string;
  let path: string;
  let rm: (p: string, o: { recursive: boolean; force: boolean }) => void;

  beforeEach(async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    rm = rmSync;
    dir = mkdtempSync(join(tmpdir(), 'delivery-ledger-v2-'));
    path = join(dir, 'delivery.db');

    const db = new Database(path);
    db.exec(V2_SCHEMA);
    db.pragma('user_version = 2');
    db.prepare(
      `INSERT INTO delivery_obligations
       (id, bot_key, platform, chat_id, session_id, content_hash, content, created_at, status,
        thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'v2-1',
      'bot-a',
      'slack',
      'C1',
      'sess-1',
      'hash-1',
      'written before voice existed',
      1,
      'pending',
      '1700.1',
    );
    db.close();
  });

  afterEach(() => {
    rm(dir, { recursive: true, force: true });
  });

  it('carries the pre-v3 row forward and reads it as text', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
      const version = db.pragma('user_version') as Array<{ user_version: number }>;
      expect(version[0]?.user_version).toBe(6);

      const row = await store.get('v2-1');
      expect(row?.content).toBe('written before voice existed');
      expect(row?.threadId).toBe('1700.1');
      // NULL in the column, 'text' on read — which is what the row was.
      expect(row?.kind).toBe('text');
      expect(row?.artifactRef).toBeUndefined();
      const raw = db.prepare(`SELECT kind FROM delivery_obligations WHERE id = 'v2-1'`).get() as {
        kind: string | null;
      };
      expect(raw.kind).toBeNull();

      // Still sweepable after the upgrade.
      expect((await store.listPending(['bot-a']))[0]?.id).toBe('v2-1');
    } finally {
      store.close();
    }
  });

  it('a migrated ledger accepts voice writes and stays STRICT', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      const id = await store.record({
        botKey: 'bot-a',
        platform: 'telegram',
        chatId: 'chat-1',
        sessionId: 'telegram:bot-a:chat-1',
        content: 'spoken after upgrade',
        kind: 'voice',
        artifactRef: 'voice/xyz.ogg',
        mediaFormat: 'ogg_opus',
      });
      expect((await store.get(id))?.kind).toBe('voice');

      const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
      const sql = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='delivery_obligations'`)
        .get() as { sql: string };
      expect(sql.sql).toMatch(/STRICT/);
      // Enforcement is real on the added columns, not just the keyword
      // surviving in the DDL text. (A number coerces losslessly to TEXT even
      // under STRICT; a BLOB is what STRICT actually refuses.)
      expect(() =>
        db.prepare(`UPDATE delivery_obligations SET kind = x'deadbeef' WHERE id = 'v2-1'`).run(),
      ).toThrow();
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Abandonment
// ---------------------------------------------------------------------------

describe('SQLiteDeliveryLedger — abandonStale', () => {
  const DAY = 86_400_000;

  /** Backdate rows so they sit on the far side of the cutoff. */
  function backdate(store: SQLiteDeliveryLedger, ids: string[], at: number) {
    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    for (const id of ids) {
      db.prepare('UPDATE delivery_obligations SET created_at = ? WHERE id = ?').run(at, id);
    }
  }

  it('abandons only owned, only old, only live rows — and returns them', async () => {
    const store = ledger();
    const stale = await store.record(input({ content: 'stale pending' }));
    const staleClaimed = await store.record(input({ content: 'stale claimed' }));
    const fresh = await store.record(input({ content: 'fresh pending' }));
    const otherBot = await store.record(input({ botKey: 'bot-z', content: 'not ours' }));
    const staleDelivered = await store.record(input({ content: 'already delivered' }));
    await store.claim(staleClaimed);
    await store.markDelivered(staleDelivered);
    backdate(store, [stale, staleClaimed, otherBot, staleDelivered], Date.now() - 30 * DAY);

    const abandoned = await store.abandonStale(['bot-a'], Date.now() - 7 * DAY);

    // A process that claimed a row and died leaves it 'redelivering' forever;
    // that is exactly the state the backstop exists for, so it is swept too.
    expect(abandoned.map((o) => o.id).sort()).toEqual([stale, staleClaimed].sort());
    expect(abandoned.every((o) => o.status === 'abandoned')).toBe(true);

    expect((await store.get(stale))?.status).toBe('abandoned');
    expect((await store.get(staleClaimed))?.status).toBe('abandoned');
    // Young enough to still belong to a live send.
    expect((await store.get(fresh))?.status).toBe('pending');
    // Old, but a peer process owns bot-z and gets to make its own call.
    expect((await store.get(otherBot))?.status).toBe('pending');
    // Terminal already; abandonment is not a re-decision.
    expect((await store.get(staleDelivered))?.status).toBe('delivered');
  });

  it('returns a voice obligation with the artifact the caller has to release', async () => {
    const store = ledger();
    const id = await store.record(
      input({ kind: 'voice', artifactRef: 'voice/old.ogg', mediaFormat: 'ogg_opus' }),
    );
    backdate(store, [id], Date.now() - 30 * DAY);

    const [abandoned] = await store.abandonStale(['bot-a'], Date.now() - 7 * DAY);
    expect(abandoned?.kind).toBe('voice');
    expect(abandoned?.artifactRef).toBe('voice/old.ogg');
  });

  it('removes abandoned rows from the redelivery pool for good', async () => {
    const store = ledger();
    const id = await store.record(input());
    backdate(store, [id], 0);
    await store.abandonStale(['bot-a'], Date.now());

    expect(await store.listPending(['bot-a'])).toHaveLength(0);
    // Not claimable either — abandonment is terminal, not a pause.
    expect(await store.claim(id)).toBe(false);
    // And release() cannot walk it back: its guard is 'redelivering'.
    await store.release(id);
    expect((await store.get(id))?.status).toBe('abandoned');
  });

  it('a process owning no bots abandons nothing', async () => {
    const store = ledger();
    const id = await store.record(input());
    backdate(store, [id], 0);
    expect(await store.abandonStale([], Date.now())).toEqual([]);
    expect((await store.get(id))?.status).toBe('pending');
  });

  it('prunes abandoned rows alongside delivered ones', async () => {
    const store = ledger();
    const abandoned = await store.record(input({ content: 'gave up' }));
    const delivered = await store.record(input({ content: 'confirmed' }));
    const stuck = await store.record(input({ content: 'still owed' }));
    const claimed = await store.record(input({ content: 'mid-send' }));
    await store.markDelivered(delivered);
    await store.claim(claimed);
    backdate(store, [abandoned, delivered, stuck, claimed], 0);
    await store.abandonStale(['bot-a'], 1);

    // abandonStale swept `stuck` and `claimed` too — re-pend them so the prune
    // is tested against live rows that are just as old as the terminal ones.
    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    db.prepare(`UPDATE delivery_obligations SET status = 'pending' WHERE id = ?`).run(stuck);
    db.prepare(`UPDATE delivery_obligations SET status = 'redelivering' WHERE id = ?`).run(claimed);

    expect(await store.pruneDelivered(Date.now())).toBe(2);
    expect(await store.get(abandoned)).toBeNull();
    expect(await store.get(delivered)).toBeNull();
    expect((await store.get(stuck))?.status).toBe('pending');
    expect((await store.get(claimed))?.status).toBe('redelivering');
  });
});

describe('SQLiteDeliveryLedger — operator reads', () => {
  /** Move a row's created_at so ordering is deterministic in-test. */
  function backdate(store: SQLiteDeliveryLedger, id: string, at: number) {
    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    db.prepare('UPDATE delivery_obligations SET created_at = ? WHERE id = ?').run(at, id);
  }

  it('stats counts every status, with voice rows also counted separately', async () => {
    const store = ledger();
    await store.record(input({ content: 'text pending' }));
    const textDelivered = await store.record(input({ content: 'text delivered' }));
    await store.markDelivered(textDelivered);
    await store.record(input({ kind: 'voice', artifactRef: 'a1', content: 'voice pending' }));
    const voiceDelivered = await store.record(
      input({ kind: 'voice', artifactRef: 'a2', content: 'voice delivered' }),
    );
    await store.markDelivered(voiceDelivered);
    const claimed = await store.record(input({ kind: 'voice', content: 'voice claimed' }));
    await store.claim(claimed);

    expect(await store.stats()).toEqual({
      pending: 2,
      redelivering: 1,
      delivered: 2,
      abandoned: 0,
      voice: { pending: 1, redelivering: 1, delivered: 1, abandoned: 0 },
    });
  });

  it('stats counts abandoned rows and reports zeros for an empty ledger', async () => {
    const store = ledger();
    expect(await store.stats()).toEqual({
      pending: 0,
      redelivering: 0,
      delivered: 0,
      abandoned: 0,
      voice: { pending: 0, redelivering: 0, delivered: 0, abandoned: 0 },
    });
    const id = await store.record(input({ kind: 'voice', content: 'gave up' }));
    backdate(store, id, 0);
    await store.abandonStale(['bot-a'], 1);
    const stats = await store.stats();
    expect(stats.abandoned).toBe(1);
    expect(stats.voice.abandoned).toBe(1);
  });

  it('counts a pre-v3 row (kind IS NULL) as text, never as voice', async () => {
    const store = ledger();
    const id = await store.record(input());
    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    db.prepare('UPDATE delivery_obligations SET kind = NULL WHERE id = ?').run(id);
    const stats = await store.stats();
    expect(stats.pending).toBe(1);
    expect(stats.voice.pending).toBe(0);
  });

  it('listRecent returns newest first, across every botKey', async () => {
    const store = ledger();
    const oldest = await store.record(input({ botKey: 'bot-a', content: 'first' }));
    const middle = await store.record(input({ botKey: 'bot-z', content: 'second' }));
    const newest = await store.record(input({ botKey: 'bot-a', content: 'third' }));
    backdate(store, oldest, 1000);
    backdate(store, middle, 2000);
    backdate(store, newest, 3000);

    // Not ownership-filtered: an operator reading one file sees the whole file.
    expect((await store.listRecent(10)).map((o) => o.id)).toEqual([newest, middle, oldest]);
  });

  it('listRecent clamps the limit to 1-200 instead of throwing', async () => {
    const store = ledger();
    for (let i = 0; i < 3; i++) await store.record(input({ content: `n${i}` }));
    expect(await store.listRecent(0)).toHaveLength(1);
    expect(await store.listRecent(-5)).toHaveLength(1);
    expect(await store.listRecent(1000)).toHaveLength(3);
    expect(await store.listRecent(Number.NaN)).toHaveLength(3);
  });

  it('listRecent carries the voice fields a display needs', async () => {
    const store = ledger();
    await store.record(
      input({
        kind: 'voice',
        artifactRef: 'artifacts/abc.opus',
        mediaFormat: 'opus',
        threadId: 'thread-7',
        content: 'the spoken text',
      }),
    );
    const [row] = await store.listRecent(1);
    expect(row?.kind).toBe('voice');
    expect(row?.artifactRef).toBe('artifacts/abc.opus');
    expect(row?.mediaFormat).toBe('opus');
    expect(row?.threadId).toBe('thread-7');
    expect(row?.content).toBe('the spoken text');
  });
});

// ---------------------------------------------------------------------------
// Durability posture — see AGENTS.md's SQLite store roster.
// ---------------------------------------------------------------------------

/** Reads `PRAGMA synchronous` off the store's OWN handle — it is a
 *  per-connection setting, so a second connection to the same file would
 *  report its own default and prove nothing. 2 = FULL (SQLite's default),
 *  1 = NORMAL. */
function syncPragma(store: unknown): number {
  const rows = (store as { db: { pragma(s: string): unknown } }).db.pragma('synchronous');
  return (rows as Array<{ synchronous: number }>)[0]?.synchronous ?? -1;
}

describe('SQLiteDeliveryLedger — durability posture', () => {
  it('stays at synchronous = FULL', () => {
    // NOT a candidate for `synchronous = NORMAL`, and this pin is here so a
    // later blanket sweep of the SQLite stores cannot take it silently.
    //
    // This ledger exists SPECIFICALLY to survive a crash: an obligation is
    // written `pending` BEFORE the platform call and marked `delivered` only
    // after it is confirmed, so that `sweepPendingDeliveries()` can redeliver
    // whatever is still pending. Under NORMAL a power loss can roll back the
    // last commits — which is exactly the `pending` row for the reply that was
    // in flight when the power went. The sweep would then find nothing and the
    // reply is lost for good, the one outcome this file was built to prevent.
    // The write path is ~2 commits per reply on a human-conversation cadence,
    // so FULL costs roughly 9ms against a multi-second turn.
    const store = new SQLiteDeliveryLedger(':memory:');
    // Asserted against the opened database, not the source text.
    expect(syncPragma(store)).toBe(2);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// findBySession (O-T5, plan/phases/trust-before-reach.md)
//
// The outbox dispatcher's restart question: an item left `sending` by a process
// that is gone — did its send ever reach the platform? `sendTracked` writes the
// row BEFORE `adapter.send`, so "no row" is proof nothing was sent and "a row"
// means the ledger owns the retry from here.
// ---------------------------------------------------------------------------

describe('SQLiteDeliveryLedger — findBySession', () => {
  let store: SQLiteDeliveryLedger;
  beforeEach(() => {
    store = ledger();
  });
  afterEach(() => {
    store.close();
  });

  it('returns the row written under that session and nothing for an unknown one', async () => {
    const id = await store.record(input({ sessionId: 'outbox:obx_1', content: 'the post' }));
    await store.record(input({ sessionId: 'outbox:obx_2', content: 'another post' }));

    const rows = await store.findBySession('outbox:obx_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(id);
    expect(rows[0]?.content).toBe('the post');

    expect(await store.findBySession('outbox:never-existed')).toEqual([]);
  });

  it('does not filter by status — a delivered row is still evidence the call happened', async () => {
    const id = await store.record(input({ sessionId: 'outbox:obx_3' }));
    await store.markDelivered(id);
    const rows = await store.findBySession('outbox:obx_3');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('delivered');
  });

  it('returns every attempt under one session, newest first', async () => {
    const first = await store.record(input({ sessionId: 'outbox:obx_4', content: 'attempt one' }));
    const second = await store.record(input({ sessionId: 'outbox:obx_4', content: 'attempt two' }));
    const rows = await store.findBySession('outbox:obx_4');
    // Same millisecond is the common case here; the rowid tie-break is what
    // makes "newest first" mean something.
    expect(rows.map((r) => r.id)).toEqual([second, first]);
  });
});

// ---------------------------------------------------------------------------
// v3 → v4 migration — `inbound_ref`, the inbound spool's double-reply guard
// (plan reach-and-containment D2-6).
// ---------------------------------------------------------------------------

/** The exact v3 schema, stamped at user_version = 3. */
const V3_SCHEMA = `
  CREATE TABLE delivery_obligations (
    id           TEXT PRIMARY KEY,
    bot_key      TEXT NOT NULL,
    platform     TEXT NOT NULL,
    chat_id      TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    thread_id    TEXT,
    kind         TEXT,
    artifact_ref TEXT,
    media_format TEXT
  ) STRICT;

  CREATE INDEX delivery_status_bot ON delivery_obligations(status, bot_key);
  CREATE INDEX delivery_status_created ON delivery_obligations(status, created_at);
  CREATE INDEX delivery_session ON delivery_obligations(session_id, created_at);
`;

describe('SQLiteDeliveryLedger — v3 → v4 migration', () => {
  let dir: string;
  let path: string;
  let rm: (p: string, o: { recursive: boolean; force: boolean }) => void;

  beforeEach(async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    rm = rmSync;
    dir = mkdtempSync(join(tmpdir(), 'delivery-ledger-v3-'));
    path = join(dir, 'delivery.db');

    const db = new Database(path);
    db.exec(V3_SCHEMA);
    db.pragma('user_version = 3');
    db.prepare(
      `INSERT INTO delivery_obligations
       (id, bot_key, platform, chat_id, session_id, content_hash, content, created_at, status,
        kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('v3-1', 'bot-a', 'telegram', 'chat-1', 'sess-1', 'h', 'pre-v4', 1, 'pending', 'text');
    db.close();
  });

  afterEach(() => {
    rm(dir, { recursive: true, force: true });
  });

  it('keeps the pre-v4 row, reads inboundRef as undefined, and stamps v4', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      const row = await store.get('v3-1');
      expect(row?.content).toBe('pre-v4');
      expect(row?.inboundRef).toBeUndefined();
      expect((await store.listPending(['bot-a']))[0]?.id).toBe('v3-1');
    } finally {
      store.close();
    }
    const db = new Database(path);
    try {
      const version = db.pragma('user_version') as Array<{ user_version: number }>;
      expect(version[0]?.user_version).toBe(6);
      const cols = db.prepare('PRAGMA table_info(delivery_obligations)').all() as Array<{
        name: string;
      }>;
      expect(cols.map((c) => c.name)).toContain('inbound_ref');
    } finally {
      db.close();
    }
  });

  it('a migrated ledger records and finds an inboundRef', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      expect(await store.hasObligationFor('spool-1')).toBe(false);
      const id = await store.record(input({ inboundRef: 'spool-1' }));
      expect((await store.get(id))?.inboundRef).toBe('spool-1');
      expect(await store.hasObligationFor('spool-1')).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe('SQLiteDeliveryLedger — hasObligationFor', () => {
  it('inboundRef is null by default, and every status counts as evidence', async () => {
    const store = ledger();
    const plain = await store.record(input());
    expect((await store.get(plain))?.inboundRef).toBeUndefined();
    // '' names no spool row — normalized to none, like threadId.
    const blank = await store.record(input({ inboundRef: '' }));
    expect((await store.get(blank))?.inboundRef).toBeUndefined();
    expect(await store.hasObligationFor('')).toBe(false);

    const id = await store.record(input({ inboundRef: 'spool-9' }));
    expect(await store.hasObligationFor('spool-9')).toBe(true);
    // Delivered is as much evidence the reply exists as pending.
    await store.markDelivered(id);
    expect(await store.hasObligationFor('spool-9')).toBe(true);
    expect(await store.hasObligationFor('spool-other')).toBe(false);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// reclaimStaleClaims (plan openclaw-2026.9.6-gaps R11) — a process that claimed
// a row and died leaves it `redelivering`; before this the only way out was
// `abandonStale` after days, which loses the reply instead of retrying it.
// ---------------------------------------------------------------------------

describe('SQLiteDeliveryLedger — reclaimStaleClaims', () => {
  it('returns a redelivering row claimed before the cutoff to pending', async () => {
    const store = ledger();
    const id = await store.record(input());
    expect(await store.claim(id)).toBe(true);

    // A claim younger than the cutoff is a live send — left alone.
    expect(await store.reclaimStaleClaims(Date.now() - 60_000)).toBe(0);
    expect((await store.get(id))?.status).toBe('redelivering');

    // Older than the cutoff: the claimant is presumed dead, the reply is owed.
    expect(await store.reclaimStaleClaims(Date.now() + 1)).toBe(1);
    expect((await store.get(id))?.status).toBe('pending');
    expect((await store.listPending(['bot-a'])).map((r) => r.id)).toEqual([id]);
    store.close();
  });

  it('never touches a pending, delivered or abandoned row', async () => {
    const store = ledger();
    const pending = await store.record(input({ content: 'p' }));
    const delivered = await store.record(input({ content: 'd' }));
    await store.markDelivered(delivered);
    const abandoned = await store.record(input({ content: 'a' }));
    await store.claim(abandoned);
    await store.abandonStale(['bot-a'], Date.now() + 1);

    expect(await store.reclaimStaleClaims(Date.now() + 1)).toBe(0);
    // abandonStale took the pending row too; only the statuses matter here.
    expect((await store.get(pending))?.status).toBe('abandoned');
    expect((await store.get(delivered))?.status).toBe('delivered');
    expect((await store.get(abandoned))?.status).toBe('abandoned');
    store.close();
  });

  it('a reclaimed row can be claimed again, exactly once', async () => {
    const store = ledger();
    const id = await store.record(input());
    expect(await store.claim(id)).toBe(true);
    expect(await store.reclaimStaleClaims(Date.now() + 1)).toBe(1);
    const [a, b] = await Promise.all([store.claim(id), store.claim(id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// v4 → v5 migration — `claimed_at`, so a stranded claim can be told from a
// live one (R11).
// ---------------------------------------------------------------------------

/** The exact v4 schema, stamped at user_version = 4. */
const V4_SCHEMA = `${V3_SCHEMA}
  ALTER TABLE delivery_obligations ADD COLUMN inbound_ref TEXT;
  CREATE INDEX delivery_inbound_ref ON delivery_obligations(inbound_ref);
`;

describe('SQLiteDeliveryLedger — v4 → v5 migration', () => {
  let dir: string;
  let path: string;
  let rm: (p: string, o: { recursive: boolean; force: boolean }) => void;
  let migratedAfter: number;

  beforeEach(async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    rm = rmSync;
    dir = mkdtempSync(join(tmpdir(), 'delivery-ledger-v4-'));
    path = join(dir, 'delivery.db');

    const db = new Database(path);
    db.exec(V4_SCHEMA);
    db.pragma('user_version = 4');
    const insert = db.prepare(
      `INSERT INTO delivery_obligations
       (id, bot_key, platform, chat_id, session_id, content_hash, content, created_at, status,
        kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('v4-pending', 'bot-a', 'telegram', 'c', 's', 'h', 'owed', 1, 'pending', 'text');
    insert.run('v4-claimed', 'bot-a', 'telegram', 'c', 's', 'h', 'held', 1, 'redelivering', 'text');
    db.close();
    migratedAfter = Date.now();
  });

  afterEach(() => {
    rm(dir, { recursive: true, force: true });
  });

  it('adds claimed_at, keeps every row, and stamps v5', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      expect((await store.get('v4-pending'))?.status).toBe('pending');
      expect((await store.get('v4-claimed'))?.status).toBe('redelivering');
    } finally {
      store.close();
    }
    const db = new Database(path);
    try {
      const version = db.pragma('user_version') as Array<{ user_version: number }>;
      expect(version[0]?.user_version).toBe(6);
      const cols = db.prepare('PRAGMA table_info(delivery_obligations)').all() as Array<{
        name: string;
      }>;
      expect(cols.map((c) => c.name)).toContain('claimed_at');
    } finally {
      db.close();
    }
  });

  it('a claim inherited from v4 starts its clock at migration, not at zero', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      // The migration cannot know when the v4 claim was taken, so it stamps
      // the migration time rather than treating the claim as infinitely old —
      // an older binary still running could be mid-send on it.
      expect(await store.reclaimStaleClaims(migratedAfter - 1)).toBe(0);
      expect(await store.reclaimStaleClaims(Date.now() + 1)).toBe(1);
      expect((await store.get('v4-claimed'))?.status).toBe('pending');
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Redelivery backoff (schema v6) — a row the platform keeps refusing was
// re-sent every sweep tick until abandonStale, days later. The ledger now
// counts failed redeliveries and records when the next one is due; the
// POLICY (schedule, cap, what is permanent) lives in the gateway.
// ---------------------------------------------------------------------------

describe('SQLiteDeliveryLedger — deferRetry / abandon', () => {
  it('a fresh row has no attempts and no due time', async () => {
    const store = ledger();
    const row = await store.get(await store.record(input()));
    expect(row?.attempts).toBe(0);
    expect(row?.nextAttemptAt).toBeUndefined();
    expect(row?.abandonReason).toBeUndefined();
    store.close();
  });

  it('deferRetry returns a claimed row to pending with one more attempt and a due time', async () => {
    const store = ledger();
    const id = await store.record(input());
    expect(await store.claim(id)).toBe(true);
    expect(await store.deferRetry(id, 1_000)).toBe(1);
    const row = await store.get(id);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt).toBe(1_000);

    expect(await store.claim(id)).toBe(true);
    expect(await store.deferRetry(id, 2_000)).toBe(2);
    expect((await store.get(id))?.nextAttemptAt).toBe(2_000);
    store.close();
  });

  it('deferRetry and abandon never touch a row this caller did not claim', async () => {
    const store = ledger();
    const id = await store.record(input());
    expect(await store.deferRetry(id, 1_000)).toBeNull();
    expect(await store.abandon(id, 'nope')).toBeNull();
    const delivered = await store.record(input({ content: 'd' }));
    await store.claim(delivered);
    await store.markDelivered(delivered);
    expect(await store.abandon(delivered, 'nope')).toBeNull();
    expect((await store.get(id))?.attempts).toBe(0);
    expect((await store.get(delivered))?.status).toBe('delivered');
    store.close();
  });

  it('abandon gives up on a claimed row, records why, and returns it', async () => {
    const store = ledger();
    const id = await store.record(input({ kind: 'voice', artifactRef: 'a1' }));
    await store.claim(id);
    const row = await store.abandon(id, 'permanent: 403 Forbidden');
    expect(row?.status).toBe('abandoned');
    expect(row?.artifactRef).toBe('a1');
    expect((await store.get(id))?.abandonReason).toBe('permanent: 403 Forbidden');
    expect(await store.listPending(['bot-a'])).toEqual([]);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// v5 → v6 migration — `attempts`, `next_attempt_at`, `abandon_reason`.
// ---------------------------------------------------------------------------

/** The exact v5 schema, stamped at user_version = 5. */
const V5_SCHEMA = `${V4_SCHEMA}
  ALTER TABLE delivery_obligations ADD COLUMN claimed_at INTEGER;
`;

describe('SQLiteDeliveryLedger — v5 → v6 migration', () => {
  let dir: string;
  let path: string;
  let rm: (p: string, o: { recursive: boolean; force: boolean }) => void;

  beforeEach(async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    rm = rmSync;
    dir = mkdtempSync(join(tmpdir(), 'delivery-ledger-v5-'));
    path = join(dir, 'delivery.db');

    const db = new Database(path);
    db.exec(V5_SCHEMA);
    db.pragma('user_version = 5');
    db.prepare(
      `INSERT INTO delivery_obligations
       (id, bot_key, platform, chat_id, session_id, content_hash, content, created_at, status,
        kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('v5-pending', 'bot-a', 'telegram', 'c', 's', 'h', 'owed', 1, 'pending', 'text');
    db.close();
  });

  afterEach(() => {
    rm(dir, { recursive: true, force: true });
  });

  it('keeps the pre-v6 row as never-attempted and due now, and stamps v6', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      const row = await store.get('v5-pending');
      expect(row?.status).toBe('pending');
      expect(row?.attempts).toBe(0);
      expect(row?.nextAttemptAt).toBeUndefined();
      expect((await store.listPending(['bot-a'])).map((r) => r.id)).toEqual(['v5-pending']);
      // The migrated row takes part in the backoff like any other.
      expect(await store.claim('v5-pending')).toBe(true);
      expect(await store.deferRetry('v5-pending', 5)).toBe(1);
    } finally {
      store.close();
    }
    const db = new Database(path);
    try {
      const version = db.pragma('user_version') as Array<{ user_version: number }>;
      expect(version[0]?.user_version).toBe(6);
      const cols = db.prepare('PRAGMA table_info(delivery_obligations)').all() as Array<{
        name: string;
      }>;
      expect(cols.map((c) => c.name)).toEqual(
        expect.arrayContaining(['attempts', 'next_attempt_at', 'abandon_reason']),
      );
      const table = db
        .prepare(`SELECT sql FROM sqlite_master WHERE name = 'delivery_obligations'`)
        .get() as { sql: string };
      expect(table.sql).toMatch(/STRICT/);
    } finally {
      db.close();
    }
  });
});
