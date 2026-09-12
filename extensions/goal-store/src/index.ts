import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from '@ethosagent/sqlite';
import type {
  CreateGoalInput,
  Goal,
  GoalAttempt,
  GoalEvent,
  GoalEventType,
  GoalStatus,
  GoalStore,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS goals (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL,
    personality_id      TEXT NOT NULL,
    origin              TEXT NOT NULL,
    source_session      TEXT,
    title               TEXT NOT NULL,
    goal_text           TEXT NOT NULL,
    acceptance_criteria TEXT,
    status              TEXT NOT NULL DEFAULT 'running',
    max_attempts        INTEGER DEFAULT 3,
    max_cost_usd        REAL,
    deadline            TEXT,
    output_md           TEXT,
    output_partial      TEXT,
    error_text          TEXT,
    started_at          INTEGER NOT NULL,
    completed_at        INTEGER,
    resume_count        INTEGER NOT NULL DEFAULT 0,
    turn_count          INTEGER,
    tool_count          INTEGER,
    token_count         INTEGER,
    cost_usd            REAL,
    max_tool_calls_per_turn INTEGER,
    allow_dangerous_tool_calls INTEGER,
    max_recovery_attempts INTEGER,
    max_identical_tool_calls INTEGER,
    plan_md             TEXT,
    lease_owner         TEXT,
    heartbeat_at        INTEGER
  ) STRICT;

  CREATE TABLE IF NOT EXISTS goal_attempts (
    id            TEXT PRIMARY KEY,
    goal_id       TEXT NOT NULL REFERENCES goals(id),
    n             INTEGER NOT NULL,
    session_key   TEXT NOT NULL,
    output_md     TEXT,
    artifacts     TEXT,
    verdict       TEXT,
    strategy_used TEXT,
    cost_usd      REAL,
    trace_id      TEXT,
    started_at    INTEGER NOT NULL,
    completed_at  INTEGER,
    UNIQUE (goal_id, n)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS goal_events (
    id           INTEGER PRIMARY KEY,
    goal_id      TEXT NOT NULL REFERENCES goals(id),
    seq          INTEGER NOT NULL,
    event_type   TEXT NOT NULL,
    payload      TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS goal_events_goal ON goal_events(goal_id, seq);
  CREATE INDEX IF NOT EXISTS goal_attempts_goal ON goal_attempts(goal_id, n);
  CREATE INDEX IF NOT EXISTS goals_user_status ON goals(user_id, status);
`;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface GoalRow {
  id: string;
  user_id: string;
  personality_id: string;
  origin: string;
  source_session: string | null;
  title: string;
  goal_text: string;
  acceptance_criteria: string | null;
  status: string;
  max_attempts: number | null;
  max_cost_usd: number | null;
  deadline: string | null;
  output_md: string | null;
  output_partial: string | null;
  error_text: string | null;
  started_at: number;
  completed_at: number | null;
  resume_count: number;
  turn_count: number | null;
  tool_count: number | null;
  token_count: number | null;
  cost_usd: number | null;
  max_tool_calls_per_turn: number | null;
  allow_dangerous_tool_calls: number | null;
  max_recovery_attempts: number | null;
  max_identical_tool_calls: number | null;
  plan_md: string | null;
}

interface GoalAttemptRow {
  id: string;
  goal_id: string;
  n: number;
  session_key: string;
  output_md: string | null;
  artifacts: string | null;
  verdict: string | null;
  strategy_used: string | null;
  cost_usd: number | null;
  trace_id: string | null;
  started_at: number;
  completed_at: number | null;
}

interface GoalEventRow {
  id: number;
  goal_id: string;
  seq: number;
  event_type: string;
  payload: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToGoal(r: GoalRow): Goal {
  return {
    id: r.id,
    userId: r.user_id,
    personalityId: r.personality_id,
    origin: r.origin,
    sourceSession: r.source_session,
    title: r.title,
    goalText: r.goal_text,
    acceptanceCriteria: r.acceptance_criteria ? JSON.parse(r.acceptance_criteria) : null,
    planMd: r.plan_md,
    status: r.status as GoalStatus,
    maxAttempts: r.max_attempts ?? 3,
    maxCostUsd: r.max_cost_usd,
    deadline: r.deadline,
    outputMd: r.output_md,
    outputPartial: r.output_partial,
    errorText: r.error_text,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    resumeCount: r.resume_count,
    turnCount: r.turn_count,
    toolCount: r.tool_count,
    tokenCount: r.token_count,
    costUsd: r.cost_usd,
    maxToolCallsPerTurn: r.max_tool_calls_per_turn ?? undefined,
    maxIdenticalToolCalls: r.max_identical_tool_calls ?? undefined,
    allowDangerousToolCalls: r.allow_dangerous_tool_calls === 1,
    maxRecoveryAttempts: r.max_recovery_attempts ?? undefined,
  };
}

function rowToAttempt(r: GoalAttemptRow): GoalAttempt {
  return {
    id: r.id,
    goalId: r.goal_id,
    n: r.n,
    sessionKey: r.session_key,
    outputMd: r.output_md,
    artifacts: r.artifacts ? JSON.parse(r.artifacts) : null,
    verdict: r.verdict ? JSON.parse(r.verdict) : null,
    strategyUsed: (r.strategy_used ?? 'first') as GoalAttempt['strategyUsed'],
    costUsd: r.cost_usd,
    traceId: r.trace_id,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

function rowToEvent(r: GoalEventRow): GoalEvent {
  return {
    id: r.id,
    goalId: r.goal_id,
    seq: r.seq,
    eventType: r.event_type as GoalEventType,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

function newGoalId(): string {
  return `g_${shortId()}`;
}

function newAttemptId(): string {
  return `ga_${shortId()}`;
}

// ---------------------------------------------------------------------------
// Status writes
// ---------------------------------------------------------------------------

type StatusExtra = Parameters<GoalStore['updateStatus']>[2];

/** The SET list (and its values, in order) for a status write plus `extra`. */
function statusAssignments(
  status: GoalStatus,
  extra: StatusExtra,
): { sets: string[]; values: unknown[] } {
  const sets: string[] = ['status = ?'];
  const values: unknown[] = [status];
  const columns = [
    ['outputMd', 'output_md'],
    ['outputPartial', 'output_partial'],
    ['errorText', 'error_text'],
    ['completedAt', 'completed_at'],
    ['turnCount', 'turn_count'],
    ['toolCount', 'tool_count'],
    ['tokenCount', 'token_count'],
    ['costUsd', 'cost_usd'],
    ['planMd', 'plan_md'],
  ] as const;
  for (const [key, column] of columns) {
    const value = extra?.[key];
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      values.push(value);
    }
  }
  return { sets, values };
}

// ---------------------------------------------------------------------------
// SQLiteGoalStore
// ---------------------------------------------------------------------------

export class SQLiteGoalStore implements GoalStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // One goals.db is shared cross-process (every loop builds a runner against
    // it — see the lease below). An explicit busy timeout makes concurrent
    // writes wait instead of throwing SQLITE_BUSY: a losing `resumeGoal` must
    // report `false`, not a thrown "database is locked". Pinned by
    // __tests__/lease.test.ts ("a peer process holding the write lock").
    this.db.pragma('busy_timeout = 5000');

    // Version check — refuse to open a DB whose schema is newer than this code.
    const versionRows = this.db.pragma('user_version') as Array<{ user_version: number }>;
    const currentVersion = versionRows[0]?.user_version ?? 0;
    // 7 is accepted: unshipped interim builds stamped it for "6 + the lease
    // columns" (see below), and it is re-stamped to 6.
    if (currentVersion > 7) {
      throw new Error(
        `goal-store: database user_version=${currentVersion} is newer than code (6); refusing to open to avoid downgrade`,
      );
    }

    this.db.exec(SCHEMA);

    // v1 → v2: add max_tool_calls_per_turn to pre-existing STRICT goals tables.
    // The table_info check makes the ALTER idempotent (fresh DBs already have it
    // from CREATE TABLE).
    if (currentVersion < 2) {
      const cols = this.db.pragma('table_info(goals)') as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'max_tool_calls_per_turn')) {
        this.db.exec('ALTER TABLE goals ADD COLUMN max_tool_calls_per_turn INTEGER');
      }
    }

    // v2 → v3: add allow_dangerous_tool_calls. Idempotent via table_info; runs
    // for both fresh-from-v1 and existing-v2 databases.
    if (currentVersion < 3) {
      const cols = this.db.pragma('table_info(goals)') as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'allow_dangerous_tool_calls')) {
        this.db.exec('ALTER TABLE goals ADD COLUMN allow_dangerous_tool_calls INTEGER');
      }
    }

    // v3 → v4: add max_recovery_attempts. Idempotent via table_info.
    if (currentVersion < 4) {
      const cols = this.db.pragma('table_info(goals)') as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'max_recovery_attempts')) {
        this.db.exec('ALTER TABLE goals ADD COLUMN max_recovery_attempts INTEGER');
      }
    }

    // v4 → v5: add max_identical_tool_calls. Idempotent via table_info.
    if (currentVersion < 5) {
      const cols = this.db.pragma('table_info(goals)') as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'max_identical_tool_calls')) {
        this.db.exec('ALTER TABLE goals ADD COLUMN max_identical_tool_calls INTEGER');
      }
    }

    // v5 → v6: add plan_md (the mandatory planning phase's plan). Idempotent via table_info.
    if (currentVersion < 6) {
      const cols = this.db.pragma('table_info(goals)') as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'plan_md')) {
        this.db.exec('ALTER TABLE goals ADD COLUMN plan_md TEXT');
      }
    }

    // Rule: an ADDITIVE NULLABLE column does not bump user_version. Every
    // older build refuses a database stamped newer than itself, and all of
    // them tolerate an extra nullable column (INSERTs name their columns;
    // reads map `SELECT *` field by field), so a bump would only lock older
    // CLIs/desktops sharing ~/.ethos out of goals.db. Such columns are added
    // on every open, idempotently, whatever the stamp says. Pinned by
    // __tests__/lease.test.ts ("lease columns are additive").
    //
    // The ownership lease (`lease_owner`, `heartbeat_at`) that
    // `interruptStale` / `resumeGoal` read. Rows written by older code keep
    // both NULL and are handled by the unleased rule in `interruptStale`.
    const cols = this.db.pragma('table_info(goals)') as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'lease_owner')) {
      this.db.exec('ALTER TABLE goals ADD COLUMN lease_owner TEXT');
    }
    if (!cols.some((c) => c.name === 'heartbeat_at')) {
      this.db.exec('ALTER TABLE goals ADD COLUMN heartbeat_at INTEGER');
    }

    // 6 is the schema version. Re-stamping an interim 7 makes the file
    // openable by the shipped builds again; the columns stay (harmless to them).
    if (currentVersion !== 6) {
      this.db.pragma('user_version = 6');
    }
  }

  create(input: CreateGoalInput): Goal {
    const id = newGoalId();
    const now = Date.now();
    const acceptanceCriteria = input.acceptanceCriteria
      ? JSON.stringify(input.acceptanceCriteria)
      : null;

    this.db
      .prepare(
        `INSERT INTO goals
         (id, user_id, personality_id, origin, source_session, title, goal_text,
          acceptance_criteria, status, max_attempts, max_cost_usd, deadline,
          started_at, resume_count, max_tool_calls_per_turn, allow_dangerous_tool_calls, max_recovery_attempts,
          max_identical_tool_calls)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.personalityId,
        input.origin,
        input.sourceSession ?? null,
        input.title,
        input.goalText,
        acceptanceCriteria,
        'running',
        input.maxAttempts ?? 3,
        input.maxCostUsd ?? null,
        input.deadline ?? null,
        now,
        0,
        input.maxToolCallsPerTurn ?? null,
        input.allowDangerousToolCalls ? 1 : 0,
        input.maxRecoveryAttempts ?? null,
        input.maxIdenticalToolCalls ?? null,
      );

    const goal = this.get(id);
    if (!goal) throw new Error(`create: inserted goal ${id} not found`);
    return goal;
  }

  get(id: string): Goal | null {
    const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as GoalRow | undefined;
    return row ? rowToGoal(row) : null;
  }

  list(opts?: { userId?: string; status?: GoalStatus; limit?: number }): Goal[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (opts?.userId !== undefined) {
      conditions.push('user_id = ?');
      values.push(opts.userId);
    }
    if (opts?.status !== undefined) {
      conditions.push('status = ?');
      values.push(opts.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? -1;

    const rows = this.db
      .prepare(`SELECT * FROM goals ${where} ORDER BY started_at DESC LIMIT ?`)
      .all(...values, limit) as GoalRow[];
    return rows.map(rowToGoal);
  }

  updateStatus(id: string, status: GoalStatus, extra?: StatusExtra): void {
    const { sets, values } = statusAssignments(status, extra);
    const result = this.db
      .prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, id);
    if (result.changes === 0) {
      throw new Error(`updateStatus: goal ${id} not found`);
    }
  }

  /**
   * The executing run's status write: applied only while `owner` (that run's
   * lease) still holds the goal — or nobody does — and the goal is not
   * `cancelled`. A cancel, from this process or another, is therefore never
   * overwritten by the run it stopped; and a run superseded by a resume, on
   * this runner or another, cannot write over the run that replaced it. One
   * conditional UPDATE, so a cancel cannot land between a check and the write.
   * Returns whether the write applied. Pinned by __tests__/lease.test.ts and
   * goal-runner's __tests__/cancel-lease.test.ts.
   */
  updateRunStatus(id: string, owner: string, status: GoalStatus, extra?: StatusExtra): boolean {
    const { sets, values } = statusAssignments(status, extra);
    const result = this.db
      .prepare(
        `UPDATE goals SET ${sets.join(', ')}
         WHERE id = ? AND status != 'cancelled' AND (lease_owner IS NULL OR lease_owner = ?)`,
      )
      .run(...values, id, owner);
    return result.changes === 1;
  }

  appendEvent(goalId: string, eventType: GoalEventType, payload: Record<string, unknown>): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const maxRow = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM goal_events WHERE goal_id = ?')
        .get(goalId) as { max_seq: number };
      const nextSeq = maxRow.max_seq + 1;
      this.db
        .prepare(
          `INSERT INTO goal_events (goal_id, seq, event_type, payload, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(goalId, nextSeq, eventType, JSON.stringify(payload), now);
    });
    tx();
  }

  getEvents(goalId: string): GoalEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM goal_events WHERE goal_id = ? ORDER BY seq ASC')
      .all(goalId) as GoalEventRow[];
    return rows.map(rowToEvent);
  }

  saveAttempt(attempt: Omit<GoalAttempt, 'id'>): GoalAttempt {
    const id = newAttemptId();
    const artifacts = attempt.artifacts ? JSON.stringify(attempt.artifacts) : null;
    const verdict = attempt.verdict ? JSON.stringify(attempt.verdict) : null;

    this.db
      .prepare(
        `INSERT INTO goal_attempts
         (id, goal_id, n, session_key, output_md, artifacts, verdict,
          strategy_used, cost_usd, trace_id, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        attempt.goalId,
        attempt.n,
        attempt.sessionKey,
        attempt.outputMd ?? null,
        artifacts,
        verdict,
        attempt.strategyUsed,
        attempt.costUsd ?? null,
        attempt.traceId ?? null,
        attempt.startedAt,
        attempt.completedAt ?? null,
      );

    const row = this.db.prepare('SELECT * FROM goal_attempts WHERE id = ?').get(id) as
      | GoalAttemptRow
      | undefined;
    if (!row) throw new Error(`saveAttempt: inserted attempt ${id} not found`);
    return rowToAttempt(row);
  }

  updateAttempt(
    goalId: string,
    n: number,
    patch: Partial<Pick<GoalAttempt, 'verdict' | 'outputMd' | 'costUsd' | 'completedAt'>>,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (patch.verdict !== undefined) {
      sets.push('verdict = ?');
      values.push(patch.verdict ? JSON.stringify(patch.verdict) : null);
    }
    if (patch.outputMd !== undefined) {
      sets.push('output_md = ?');
      values.push(patch.outputMd);
    }
    if (patch.costUsd !== undefined) {
      sets.push('cost_usd = ?');
      values.push(patch.costUsd);
    }
    if (patch.completedAt !== undefined) {
      sets.push('completed_at = ?');
      values.push(patch.completedAt);
    }

    if (sets.length === 0) return;

    values.push(goalId, n);
    const result = this.db
      .prepare(`UPDATE goal_attempts SET ${sets.join(', ')} WHERE goal_id = ? AND n = ?`)
      .run(...values);
    if (result.changes === 0) {
      throw new Error(`updateAttempt: attempt n=${n} for goal ${goalId} not found`);
    }
  }

  getAttempts(goalId: string): GoalAttempt[] {
    const rows = this.db
      .prepare('SELECT * FROM goal_attempts WHERE goal_id = ? ORDER BY n ASC')
      .all(goalId) as GoalAttemptRow[];
    return rows.map(rowToAttempt);
  }

  incrementResumeCount(id: string): void {
    const result = this.db
      .prepare('UPDATE goals SET resume_count = resume_count + 1 WHERE id = ?')
      .run(id);
    if (result.changes === 0) {
      throw new Error(`incrementResumeCount: goal ${id} not found`);
    }
  }

  // -------------------------------------------------------------------------
  // Ownership lease — the job-store heartbeat + reclaimStale model, for goals.
  // The executing RUN claims a goal and refreshes `heartbeat_at` while it is
  // live; `interruptStale` takes only goals whose lease went quiet, so a runner
  // booting beside another live runner leaves that runner's goals alone. The
  // owner string identifies one run, not one runner (goal-runner leases as
  // `<runnerId>:<runSeq>`), so a run superseded by a resume — even on the same
  // runner — fails every check below once the new run has claimed the goal.
  // Pinned by __tests__/lease.test.ts.
  // -------------------------------------------------------------------------

  /** Take (or retake) the lease on a goal: `owner` is now the run executing it. */
  claimGoal(goalId: string, owner: string): void {
    this.db
      .prepare('UPDATE goals SET lease_owner = ?, heartbeat_at = ? WHERE id = ?')
      .run(owner, Date.now(), goalId);
  }

  /**
   * Resume a goal for the run `owner`, atomically: from `failed`, `cancelled`
   * or `interrupted` only, it becomes `running`, its resume count goes up and
   * `owner` takes the lease — all in one conditional UPDATE, so of two
   * processes resuming the same goal exactly one wins and the other gets
   * false. A run that was still unwinding from the previous attempt holds a
   * superseded lease and stands down at its next check. Pinned by
   * __tests__/lease.test.ts ("resumeGoal").
   */
  resumeGoal(goalId: string, owner: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE goals
         SET status = 'running', resume_count = resume_count + 1,
             lease_owner = ?, heartbeat_at = ?
         WHERE id = ? AND status IN ('failed', 'cancelled', 'interrupted')`,
      )
      .run(owner, Date.now(), goalId);
    return result.changes === 1;
  }

  /**
   * Refresh `owner`'s lease, and report whether the run should go on: false when
   * the goal was `cancelled` (by anyone) or another run holds the lease now.
   * A beat from a run that does not hold the lease changes nothing — it
   * neither revives nor takes over someone else's.
   */
  heartbeatGoal(goalId: string, owner: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE goals SET heartbeat_at = ?
         WHERE id = ? AND lease_owner = ? AND status != 'cancelled'`,
      )
      .run(Date.now(), goalId, owner);
    return result.changes === 1;
  }

  /**
   * Mark `interrupted` every active goal (planning / running / judging /
   * retrying) whose lease is older than `staleMs`, and return their ids.
   * `needs_clarification` is parked on a person, not executing, and is never
   * taken — the same reason job-store's sweep skips `blocked`.
   *
   * A goal with NO lease (a row written before the lease columns existed, or
   * one created but not yet started) counts as orphaned only once its last
   * sign of life — the newer of `started_at` and its latest event — is older
   * than `staleMs`: a pre-lease runner still driving it writes events, and a
   * just-created row has not reached `startGoal` yet. One UPDATE, so a beat
   * cannot land between the check and the write.
   *
   * Limitation: a heartbeat is wall-clock, so a live runner whose host slept
   * longer than `staleMs` looks dead to a peer that sweeps before its next
   * beat, and the goal is marked `interrupted`. The lease is not taken over:
   * that run's next beat still succeeds and its next status write
   * (`updateRunStatus`, owner unchanged) puts the goal back — unless someone
   * resumes the `interrupted` goal first, in which case the resumed run's new
   * lease wins and the sleeper stands down at its next check.
   */
  interruptStale(staleMs: number, now: number = Date.now()): string[] {
    const threshold = now - staleMs;
    const rows = this.db
      .prepare(
        `UPDATE goals SET status = 'interrupted'
         WHERE status IN ('planning', 'running', 'judging', 'retrying')
           AND (
             (heartbeat_at IS NOT NULL AND heartbeat_at <= ?)
             OR (
               heartbeat_at IS NULL
               AND MAX(
                 started_at,
                 COALESCE(
                   (SELECT MAX(e.created_at) FROM goal_events e WHERE e.goal_id = goals.id),
                   0
                 )
               ) <= ?
             )
           )
         RETURNING id`,
      )
      .all(threshold, threshold) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  close(): void {
    this.db.close();
  }
}
