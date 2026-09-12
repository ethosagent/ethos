import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from '@ethosagent/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteGoalStore } from '../index';

// Goal ownership lease (plan architecture-suggestions-2026-09-10 F05 follow-up).
// Every loop build used to run a recovery that interrupted EVERY active goal in
// the shared goals.db the new runner was not itself executing — including goals
// another live runner (a running `ethos serve`, a second loop in the same
// process) was executing. The lease is the job-store model: the owning runner
// claims the row and refreshes `heartbeat_at`; `interruptStale` only takes rows
// whose lease went quiet.

const STALE_MS = 90_000;

function makeGoal(store: SQLiteGoalStore) {
  return store.create({
    userId: 'u',
    personalityId: 'p',
    origin: 'cli',
    title: 't',
    goalText: 'g',
  });
}

describe('SQLiteGoalStore — ownership lease', () => {
  it('leaves a goal whose owner is heartbeating alone', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = makeGoal(store);
    store.claimGoal(goal.id, 'runner-a');
    store.heartbeatGoal(goal.id, 'runner-a');

    expect(store.interruptStale(STALE_MS)).toEqual([]);
    expect(store.get(goal.id)?.status).toBe('running');
  });

  it('interrupts a goal whose owner stopped heartbeating', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = makeGoal(store);
    store.claimGoal(goal.id, 'runner-a');

    const later = Date.now() + STALE_MS + 1_000;
    expect(store.interruptStale(STALE_MS, later)).toEqual([goal.id]);
    expect(store.get(goal.id)?.status).toBe('interrupted');
  });

  it('ignores a heartbeat from a runner that does not own the goal', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = makeGoal(store);
    store.claimGoal(goal.id, 'runner-a');
    const later = Date.now() + STALE_MS + 1_000;
    // A non-owner beat must not keep someone else's dead lease alive — and it
    // must not quietly take the lease over either.
    store.heartbeatGoal(goal.id, 'runner-b');
    expect(store.interruptStale(STALE_MS, later)).toEqual([goal.id]);
  });

  it('treats an unleased (legacy) row as orphaned only once its last activity is older than staleMs', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = makeGoal(store);
    store.appendEvent(goal.id, 'run_start', { attemptN: 1 });

    // Fresh activity: a pre-lease runner may still be driving it.
    expect(store.interruptStale(STALE_MS)).toEqual([]);
    expect(store.get(goal.id)?.status).toBe('running');

    const later = Date.now() + STALE_MS + 1_000;
    expect(store.interruptStale(STALE_MS, later)).toEqual([goal.id]);
    expect(store.get(goal.id)?.status).toBe('interrupted');
  });

  it('covers planning/judging/retrying but never parked or terminal goals', () => {
    const store = new SQLiteGoalStore(':memory:');
    const byStatus = new Map<string, string>();
    for (const status of [
      'planning',
      'judging',
      'retrying',
      'needs_clarification',
      'completed',
      'failed',
      'cancelled',
    ] as const) {
      const goal = makeGoal(store);
      store.updateStatus(goal.id, status);
      byStatus.set(status, goal.id);
    }

    const later = Date.now() + STALE_MS + 1_000;
    const interrupted = new Set(store.interruptStale(STALE_MS, later));
    expect(interrupted).toEqual(
      new Set([byStatus.get('planning'), byStatus.get('judging'), byStatus.get('retrying')]),
    );
    expect(store.get(byStatus.get('needs_clarification') ?? '')?.status).toBe(
      'needs_clarification',
    );
    expect(store.get(byStatus.get('completed') ?? '')?.status).toBe('completed');
  });
});

describe('SQLiteGoalStore — cancel against the lease', () => {
  it('a heartbeat reports false once the goal is cancelled, by anyone', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = makeGoal(store);
    store.claimGoal(goal.id, 'runner-a');
    expect(store.heartbeatGoal(goal.id, 'runner-a')).toBe(true);

    store.updateStatus(goal.id, 'cancelled');
    expect(store.heartbeatGoal(goal.id, 'runner-a')).toBe(false);
  });

  it('a heartbeat reports false once another runner holds the lease', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = makeGoal(store);
    store.claimGoal(goal.id, 'runner-a');
    store.claimGoal(goal.id, 'runner-b');
    expect(store.heartbeatGoal(goal.id, 'runner-a')).toBe(false);
    expect(store.heartbeatGoal(goal.id, 'runner-b')).toBe(true);
  });

  it('updateRunStatus never overwrites cancelled', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = makeGoal(store);
    store.claimGoal(goal.id, 'runner-a');
    store.updateStatus(goal.id, 'cancelled');

    expect(store.updateRunStatus(goal.id, 'runner-a', 'failed', { errorText: 'Aborted' })).toBe(
      false,
    );
    expect(store.get(goal.id)?.status).toBe('cancelled');
    expect(store.get(goal.id)?.errorText).toBeNull();
  });

  it('updateRunStatus does not write over a goal another runner now holds', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = makeGoal(store);
    store.claimGoal(goal.id, 'runner-b');
    expect(store.updateRunStatus(goal.id, 'runner-a', 'failed')).toBe(false);
    expect(store.updateRunStatus(goal.id, 'runner-b', 'judging', { turnCount: 3 })).toBe(true);
    expect(store.get(goal.id)?.status).toBe('judging');
    expect(store.get(goal.id)?.turnCount).toBe(3);
  });
});

// The lease columns are two NULLABLE columns added on open. That does not bump
// `user_version`: v0.8.0 refuses any goals.db stamped newer than 6, so a bump
// would lock every older CLI/desktop sharing ~/.ethos out after one run of
// this code — and old code tolerates the columns (explicit INSERT column
// lists, `SELECT *` mapped field by field). Interim builds stamped 7; that
// stamp means "6 + these columns" and is re-stamped to 6.
describe('SQLiteGoalStore — lease columns are additive (no version bump)', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A v6 goals table: every column up to plan_md, no lease. */
  function writeV6(path: string, stamp: number): void {
    const db = new Database(path);
    db.exec(`
      CREATE TABLE goals (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, personality_id TEXT NOT NULL,
        origin TEXT NOT NULL, source_session TEXT, title TEXT NOT NULL,
        goal_text TEXT NOT NULL, acceptance_criteria TEXT,
        status TEXT NOT NULL DEFAULT 'running', max_attempts INTEGER DEFAULT 3,
        max_cost_usd REAL, deadline TEXT, output_md TEXT, output_partial TEXT,
        error_text TEXT, started_at INTEGER NOT NULL, completed_at INTEGER,
        resume_count INTEGER NOT NULL DEFAULT 0, turn_count INTEGER, tool_count INTEGER,
        token_count INTEGER, cost_usd REAL, max_tool_calls_per_turn INTEGER,
        allow_dangerous_tool_calls INTEGER, max_recovery_attempts INTEGER,
        max_identical_tool_calls INTEGER, plan_md TEXT
      ) STRICT;
    `);
    db.prepare(
      `INSERT INTO goals (id, user_id, personality_id, origin, title, goal_text, status, started_at)
       VALUES ('g_legacy', 'u', 'p', 'cli', 't', 'g', 'running', ?)`,
    ).run(Date.now());
    db.pragma(`user_version = ${stamp}`);
    db.close();
  }

  function inspect(path: string): { cols: string[]; version: number | undefined } {
    const raw = new Database(path);
    const cols = (raw.pragma('table_info(goals)') as Array<{ name: string }>).map((c) => c.name);
    const version = (raw.pragma('user_version') as Array<{ user_version: number }>)[0]
      ?.user_version;
    raw.close();
    return { cols, version };
  }

  it('adds the lease columns to an existing v6 database, keeps its rows, and stays at 6', () => {
    dir = mkdtempSync(join(tmpdir(), 'goal-store-lease-'));
    const path = join(dir, 'goals.db');
    writeV6(path, 6);

    const store = new SQLiteGoalStore(path);
    expect(store.get('g_legacy')?.status).toBe('running');
    // The migrated row takes a lease like any other.
    store.claimGoal('g_legacy', 'runner-a');
    expect(store.interruptStale(STALE_MS)).toEqual([]);
    store.close();

    const { cols, version } = inspect(path);
    expect(cols).toEqual(expect.arrayContaining(['lease_owner', 'heartbeat_at']));
    expect(version).toBe(6);
  });

  it('creates a fresh database at 6 with the lease columns', () => {
    dir = mkdtempSync(join(tmpdir(), 'goal-store-lease-'));
    const path = join(dir, 'goals.db');
    new SQLiteGoalStore(path).close();
    const { cols, version } = inspect(path);
    expect(cols).toEqual(expect.arrayContaining(['lease_owner', 'heartbeat_at']));
    expect(version).toBe(6);
  });

  it('opens a database an interim build stamped 7 and re-stamps it to 6', () => {
    dir = mkdtempSync(join(tmpdir(), 'goal-store-lease-'));
    const path = join(dir, 'goals.db');
    writeV6(path, 7);
    const store = new SQLiteGoalStore(path);
    expect(store.get('g_legacy')?.status).toBe('running');
    store.close();
    const { cols, version } = inspect(path);
    expect(cols).toEqual(expect.arrayContaining(['lease_owner', 'heartbeat_at']));
    expect(version).toBe(6);
  });

  it('still refuses a database stamped by a genuinely newer schema', () => {
    dir = mkdtempSync(join(tmpdir(), 'goal-store-lease-'));
    const path = join(dir, 'goals.db');
    writeV6(path, 8);
    expect(() => new SQLiteGoalStore(path)).toThrow(/newer than code/);
  });

  it("leaves the database usable by v0.8.0's query shapes", () => {
    dir = mkdtempSync(join(tmpdir(), 'goal-store-lease-'));
    const path = join(dir, 'goals.db');
    const store = new SQLiteGoalStore(path);
    store.claimGoal(
      store.create({ userId: 'u', personalityId: 'p', origin: 'cli', title: 't', goalText: 'g' })
        .id,
      'r',
    );
    store.close();

    // v0.8.0 (git show 2e8e5d2:extensions/goal-store/src/index.ts): refuses
    // user_version > 6, inserts with an explicit column list, reads SELECT *.
    const old = new Database(path);
    const version = (old.pragma('user_version') as Array<{ user_version: number }>)[0];
    expect(version?.user_version ?? 0).toBeLessThanOrEqual(6);
    old
      .prepare(
        `INSERT INTO goals
         (id, user_id, personality_id, origin, source_session, title, goal_text,
          acceptance_criteria, status, max_attempts, max_cost_usd, deadline,
          started_at, resume_count, max_tool_calls_per_turn, allow_dangerous_tool_calls, max_recovery_attempts,
          max_identical_tool_calls)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'g_old',
        'u',
        'p',
        'cli',
        null,
        't',
        'g',
        null,
        'running',
        3,
        null,
        null,
        Date.now(),
        0,
        null,
        0,
        null,
        null,
      );
    const rows = old.prepare('SELECT * FROM goals ORDER BY started_at DESC').all() as Array<{
      id: string;
      lease_owner: string | null;
    }>;
    old.close();
    expect(rows.map((r) => r.id)).toContain('g_old');
    expect(rows.find((r) => r.id === 'g_old')?.lease_owner).toBeNull();
  });
});

describe('SQLiteGoalStore.resumeGoal', () => {
  it('claims a resumable goal once: from a resumable status only, atomically', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = makeGoal(store);
    store.updateStatus(goal.id, 'failed');

    expect(store.resumeGoal(goal.id, 'runner-a:1')).toBe(true);
    expect(store.get(goal.id)?.status).toBe('running');
    expect(store.get(goal.id)?.resumeCount).toBe(1);
    // The second resumer finds it running already.
    expect(store.resumeGoal(goal.id, 'runner-b:1')).toBe(false);
    expect(store.heartbeatGoal(goal.id, 'runner-a:1')).toBe(true);
    expect(store.heartbeatGoal(goal.id, 'runner-b:1')).toBe(false);
  });

  it('refuses a goal that is not in a resumable status', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = makeGoal(store);
    expect(store.resumeGoal(goal.id, 'runner-a:1')).toBe(false);
    store.updateStatus(goal.id, 'completed');
    expect(store.resumeGoal(goal.id, 'runner-a:1')).toBe(false);
  });
});

// The documented sleep limitation in `interruptStale`: a peer may mark a live
// run's goal `interrupted`, but the lease is not taken over, so that run's next
// conditional write restores the goal — unless a resume claimed it first.
describe('SQLiteGoalStore — a live run marked interrupted by a peer', () => {
  it("is restored by the owning run's next status write", () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = makeGoal(store);
    store.claimGoal(goal.id, 'runner-a:1');
    expect(store.interruptStale(STALE_MS, Date.now() + STALE_MS + 1_000)).toEqual([goal.id]);

    expect(store.heartbeatGoal(goal.id, 'runner-a:1')).toBe(true);
    expect(store.updateRunStatus(goal.id, 'runner-a:1', 'judging')).toBe(true);
    expect(store.get(goal.id)?.status).toBe('judging');
  });

  it('stands down instead once the interrupted goal was resumed by another run', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = makeGoal(store);
    store.claimGoal(goal.id, 'runner-a:1');
    store.interruptStale(STALE_MS, Date.now() + STALE_MS + 1_000);
    expect(store.resumeGoal(goal.id, 'runner-b:1')).toBe(true);

    expect(store.heartbeatGoal(goal.id, 'runner-a:1')).toBe(false);
    expect(store.updateRunStatus(goal.id, 'runner-a:1', 'failed')).toBe(false);
    expect(store.get(goal.id)?.status).toBe('running');
  });
});

// goals.db is shared cross-process by design (`build-agent-loop.ts` builds a
// runner per loop against the one file, and `interruptStale` exists precisely
// because another live runner may hold it). It was the only such store in the
// repo with no `busy_timeout`, so a peer's in-flight write turned a losing
// resume into a thrown SQLITE_BUSY — a 500 where the caller should have been
// told someone else resumed the goal.
describe('SQLiteGoalStore — a peer process holding the write lock', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('waits for the peer instead of throwing SQLITE_BUSY', async () => {
    dir = mkdtempSync(join(tmpdir(), 'goal-store-busy-'));
    const dbPath = join(dir, 'goals.db');
    const store = new SQLiteGoalStore(dbPath);
    const goal = makeGoal(store);
    store.updateStatus(goal.id, 'interrupted');

    // The lock is held from a WORKER, not a second handle on this thread —
    // `@ethosagent/sqlite` is synchronous, so a same-thread holder could never
    // release while the call below blocks. Plain CommonJS source, so no
    // TypeScript transform is involved in the worker.
    const holder = new Worker(
      `const { DatabaseSync } = require('node:sqlite');
       const { workerData, parentPort } = require('node:worker_threads');
       const db = new DatabaseSync(workerData.dbPath);
       db.exec('PRAGMA busy_timeout = 5000');
       db.exec('BEGIN IMMEDIATE');
       db.prepare("INSERT INTO goals (id, user_id, personality_id, origin, title, goal_text, status, started_at) VALUES ('g_peer','u','p','cli','t','g','running',1)").run();
       parentPort.postMessage('held');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
       db.exec('COMMIT');
       db.close();`,
      { eval: true, workerData: { dbPath } },
    );
    await new Promise<void>((resolve, reject) => {
      holder.once('message', () => resolve());
      holder.once('error', reject);
    });

    // Runs while the peer holds the write lock. Pre-fix this threw.
    expect(store.resumeGoal(goal.id, 'runner-a:1')).toBe(true);
    expect(store.get(goal.id)?.status).toBe('running');
    store.close();
    await holder.terminate();
  }, 30_000);
});
