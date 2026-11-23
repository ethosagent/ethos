import type Database from '@ethosagent/sqlite';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id                 TEXT PRIMARY KEY,
    owner              TEXT NOT NULL,
    parent_session_key TEXT NOT NULL,
    root_session_key   TEXT NOT NULL,
    child_session_key  TEXT NOT NULL,
    personality_id     TEXT,
    depth              INTEGER NOT NULL,
    status             TEXT NOT NULL DEFAULT 'queued',
    label              TEXT,
    prompt             TEXT NOT NULL,
    summary            TEXT,
    error              TEXT,
    spend_usd          REAL NOT NULL DEFAULT 0,
    max_cost_usd       REAL,
    cancel_requested   INTEGER NOT NULL DEFAULT 0,
    heartbeat_at       INTEGER,
    created_at         INTEGER NOT NULL,
    started_at         INTEGER,
    finished_at        INTEGER,
    delivered_at       INTEGER,
    origin_platform    TEXT,
    origin_bot_key     TEXT,
    origin_chat_id     TEXT,
    origin_thread_id   TEXT,
    remote_peer        TEXT,
    remote_job_id      TEXT,
    runner             TEXT,
    blocked_since      INTEGER,
    blocked_request_id TEXT,
    deliver            TEXT NOT NULL DEFAULT 'user',
    origin_user_id     TEXT,
    toolset_narrowing  TEXT,
    tainted            INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  CREATE TABLE IF NOT EXISTS job_events (
    id         INTEGER PRIMARY KEY,
    job_id     TEXT NOT NULL REFERENCES jobs(id),
    seq        INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  -- G5 — the second delivery claim. One row per PUSHED mid-run notice, keyed by
  -- the pending question's requestId. Insert-wins is the claim: the PRIMARY KEY
  -- makes a concurrent second insert a no-op, so two processes racing the same
  -- question push it exactly once. Deliberately a table and not a column on
  -- jobs: a job parks on more than one question over its life, and each park
  -- needs its own claim (a column would be spent after the first).
  CREATE TABLE IF NOT EXISTS job_notices (
    request_id TEXT PRIMARY KEY,
    job_id     TEXT NOT NULL,
    claimed_at INTEGER NOT NULL
  ) STRICT;

  -- The steer queue (plan background-job-steer D2/D18(a)). In the BASELINE, not
  -- a numbered migration: migrate execs the baseline on every open, so
  -- CREATE TABLE IF NOT EXISTS reaches old and new databases alike, and
  -- user_version stays 10 (a bump would lock older builds sharing ~/.ethos out
  -- of jobs.db, D18(a)). NO foreign key to jobs: foreign_keys is ON, and an
  -- older build's pruneTerminal deletes jobs rows without knowing this table;
  -- an FK would make that delete fail. job_notices has no FK for the same
  -- reason. pruneTerminal here also deletes orphans.
  CREATE TABLE IF NOT EXISTS job_steers (
    id                INTEGER PRIMARY KEY,
    job_id            TEXT NOT NULL,
    text              TEXT NOT NULL,
    state             TEXT NOT NULL DEFAULT 'pending',
    source            TEXT NOT NULL,
    requester_user_id TEXT,
    created_at        INTEGER NOT NULL,
    read_at           INTEGER
  ) STRICT;

  CREATE INDEX IF NOT EXISTS job_steers_job ON job_steers(job_id, state, id);
  CREATE INDEX IF NOT EXISTS job_events_job ON job_events(job_id, seq);
  CREATE INDEX IF NOT EXISTS job_notices_job ON job_notices(job_id);
  CREATE INDEX IF NOT EXISTS jobs_root_status ON jobs(root_session_key, status);
  CREATE INDEX IF NOT EXISTS jobs_owner_status ON jobs(owner, status);
  CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status, created_at);
`;

/**
 * The restore sweep's index. NOT in the baseline: `migrate` execs the baseline
 * BEFORE the migration chain, so on an older database `delivered_at` does not
 * exist yet and the CREATE INDEX would fail. It goes after the chain instead,
 * where the column is guaranteed to be there.
 */
export const DELIVERY_INDEX =
  'CREATE INDEX IF NOT EXISTS jobs_undelivered ON jobs(origin_bot_key, status, delivered_at)';

export const JOB_STORE_SCHEMA_VERSION = 10;

/**
 * Forward-only DDL steps. Each brings a `(N-1)` database to `N`; the baseline
 * above already describes v10, so a FRESH database never runs one. The
 * `table_info` guards keep each ALTER idempotent even if a database was
 * hand-repaired to the newer shape without its `user_version` being bumped.
 */
export const JOB_STORE_MIGRATIONS: Record<number, (db: Database.Database) => void> = {
  2: (db) => {
    addColumnIfMissing(db, 'remote_peer', 'TEXT');
    addColumnIfMissing(db, 'remote_job_id', 'TEXT');
  },
  // v2 -> v3: the delivery claim. `ALTER TABLE ... ADD COLUMN` keeps the table
  // STRICT (STRICT is a table property, not a column one) and leaves every
  // existing row intact with `delivered_at` NULL — i.e. "never announced",
  // which is the honest state for a job that finished before this code existed.
  3: (db) => addColumnIfMissing(db, 'delivered_at', 'INTEGER'),
  // v3 -> v4: which runner executed the row. NULL on every pre-existing row,
  // which reads as "the default runner" — the only one that existed then.
  4: (db) => addColumnIfMissing(db, 'runner', 'TEXT'),
  // v4 -> v5: the `blocked` state's two fields. Same ALTER shape as v2/v3 —
  // existing rows get NULLs, which is the honest state for every job that
  // finished before a run could park on a human answer.
  5: (db) => {
    addColumnIfMissing(db, 'blocked_since', 'INTEGER');
    addColumnIfMissing(db, 'blocked_request_id', 'TEXT');
  },
  // v5 -> v6: G5's second delivery claim (`job_notices`). No DDL of its own —
  // the baseline's `CREATE TABLE IF NOT EXISTS` already ran by the time this
  // step executes, on a fresh AND on an upgraded database alike (`migrate`
  // execs the baseline before the chain). The step exists so `user_version`
  // moves, which is what the downgrade guard reads.
  6: () => {},
  // v6 -> v7: who sees the result first (plan openclaw-9.5-adoption item 6).
  // The DEFAULT makes every existing row read `'user'` — the only behaviour
  // that existed before the column.
  7: (db) => addColumnIfMissing(db, 'deliver', `TEXT NOT NULL DEFAULT 'user'`),
  // v7 -> v8: who started the job (`BackgroundJob.originUserId`). NULL on
  // every existing row — no originator was ever recorded for them.
  8: (db) => addColumnIfMissing(db, 'origin_user_id', 'TEXT'),
  // v8 -> v9: the spawning turn's tool narrowing, as JSON
  // (`BackgroundJob.toolsetNarrowing`). NULL on every existing row, which
  // reads as "no narrowing" — what those jobs actually ran under.
  9: (db) => addColumnIfMissing(db, 'toolset_narrowing', 'TEXT'),
  // v9 -> v10: the run read untrusted content (`BackgroundJob.tainted`,
  // V2-SEC-2). The DEFAULT reads every existing row as untainted — no taint was
  // ever recorded for them.
  10: (db) => addColumnIfMissing(db, 'tainted', 'INTEGER NOT NULL DEFAULT 0'),
};

/**
 * Additive nullable columns added on EVERY open, idempotently, whatever
 * `user_version` says — and deliberately NOT a migration step (plan
 * personality-memory-boundary D18(a)). Every older build refuses a database
 * stamped newer than itself (`migrate`'s downgrade guard), and all of them
 * tolerate an extra nullable column (`create` names its columns; `rowToJob`
 * maps fields by name), so a bump would only lock older CLIs/desktops sharing
 * `~/.ethos` out of jobs.db. The goal-store convention
 * (extensions/goal-store/src/index.ts, "an ADDITIVE NULLABLE column does not
 * bump user_version"), also used by session-sqlite.
 *
 * Rule-5 conflict, flagged not rewritten: steps 2–10 of `JOB_STORE_MIGRATIONS`
 * above bumped `user_version` for additive columns too (step 10, `tainted`,
 * landed on main beside this helper). New additive columns go
 * here; those steps are left as they are (rewriting a shipped chain is its own
 * change) and are a cleanup candidate.
 *
 * `room_audience` — `BackgroundJob.roomAudience`; NULL on every existing row,
 * which reads as "unstamped" and resolves from the origin chat (D11).
 * Pinned by the 'room audience column' cases in `__tests__/job-store.test.ts`.
 */
export function addAdditiveColumns(db: Database.Database): void {
  addColumnIfMissing(db, 'room_audience', 'TEXT');
  // Durable background jobs (plan durable-background-jobs, pinned by
  // `__tests__/durable-resume.test.ts`): `resume_affinity` is
  // `BackgroundJob.resumeAffinity` (NULL = not auto-resumable), `no_resume` is
  // `BackgroundJob.noResume`, `resume_count` is `BackgroundJob.resumeCount`
  // (automatic resumes only), `requeued_at` is `BackgroundJob.requeuedAt`.
  // The DEFAULTs read every existing row as never resumed and resumable-by-opt-in.
  addColumnIfMissing(db, 'resume_affinity', 'TEXT');
  addColumnIfMissing(db, 'no_resume', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'resume_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'requeued_at', 'INTEGER');
}

function addColumnIfMissing(db: Database.Database, column: string, type: string): void {
  const cols = db.pragma('table_info(jobs)') as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${type}`);
  }
}
