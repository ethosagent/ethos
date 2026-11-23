import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { migrate } from '@ethosagent/sqlite';
import type {
  AddSteerResult,
  BackgroundJob,
  BackgroundJobEvent,
  BackgroundJobEventType,
  BackgroundJobStatus,
  CreateBackgroundJobInput,
  GetJobEventsOptions,
  JobClaimFence,
  JobSteer,
  JobSteerSource,
  JobSteerState,
  JobStore,
} from '@ethosagent/types';
import {
  JOB_ABORTED_BY_SHUTDOWN,
  JOB_CLAIM_LOST,
  JOB_STEER_MAX_CHARS,
  JOB_STEER_MAX_PENDING,
} from '@ethosagent/types';
import {
  addAdditiveColumns,
  DELIVERY_INDEX,
  JOB_STORE_MIGRATIONS,
  JOB_STORE_SCHEMA_VERSION,
  SCHEMA,
} from './schema';

/** The `AND owner = ? AND started_at = ?` tail that confines a write to one claim; empty without a fence. */
function fenceClause(fence?: JobClaimFence): { sql: string; params: Array<string | number> } {
  return fence
    ? { sql: ' AND owner = ? AND started_at = ?', params: [fence.owner, fence.startedAt] }
    : { sql: '', params: [] };
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  owner: string;
  parent_session_key: string;
  root_session_key: string;
  child_session_key: string;
  personality_id: string | null;
  depth: number;
  status: string;
  label: string | null;
  prompt: string;
  summary: string | null;
  error: string | null;
  spend_usd: number;
  max_cost_usd: number | null;
  cancel_requested: number;
  heartbeat_at: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  delivered_at: number | null;
  origin_platform: string | null;
  origin_bot_key: string | null;
  origin_chat_id: string | null;
  origin_thread_id: string | null;
  remote_peer: string | null;
  remote_job_id: string | null;
  runner: string | null;
  blocked_since: number | null;
  blocked_request_id: string | null;
  deliver: string;
  origin_user_id: string | null;
  toolset_narrowing: string | null;
  room_audience: string | null;
  tainted: number;
  resume_affinity: string | null;
  no_resume: number;
  resume_count: number;
  requeued_at: number | null;
}

interface JobEventRow {
  id: number;
  job_id: string;
  seq: number;
  event_type: string;
  payload: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToJob(r: JobRow): BackgroundJob {
  return {
    id: r.id,
    owner: r.owner,
    parentSessionKey: r.parent_session_key,
    rootSessionKey: r.root_session_key,
    childSessionKey: r.child_session_key,
    personalityId: r.personality_id ?? undefined,
    depth: r.depth,
    status: r.status as BackgroundJobStatus,
    label: r.label ?? undefined,
    prompt: r.prompt,
    summary: r.summary ?? undefined,
    error: r.error ?? undefined,
    spendUsd: r.spend_usd,
    maxCostUsd: r.max_cost_usd ?? undefined,
    cancelRequested: r.cancel_requested === 1,
    heartbeatAt: r.heartbeat_at ?? undefined,
    createdAt: r.created_at,
    startedAt: r.started_at ?? undefined,
    finishedAt: r.finished_at ?? undefined,
    deliveredAt: r.delivered_at ?? undefined,
    originPlatform: r.origin_platform ?? undefined,
    originBotKey: r.origin_bot_key ?? undefined,
    originChatId: r.origin_chat_id ?? undefined,
    originThreadId: r.origin_thread_id ?? undefined,
    originUserId: r.origin_user_id ?? undefined,
    toolsetNarrowing: parseToolsetNarrowing(r.toolset_narrowing),
    roomAudience: parseRoomAudience(r.room_audience),
    remotePeer: r.remote_peer ?? undefined,
    remoteJobId: r.remote_job_id ?? undefined,
    runner: r.runner ?? undefined,
    blockedSince: r.blocked_since ?? undefined,
    blockedRequestId: r.blocked_request_id ?? undefined,
    deliver: r.deliver === 'parent' ? 'parent' : 'user',
    ...(r.tainted === 1 ? { tainted: true } : {}),
    resumeCount: r.resume_count,
    ...(r.no_resume === 1 ? { noResume: true } : {}),
    resumeAffinity: r.resume_affinity ?? undefined,
    requeuedAt: r.requeued_at ?? undefined,
  };
}

/**
 * `toolset_narrowing` is written only by `create` from a typed value, so a
 * shape mismatch means a hand-edited row. It reads as NO narrowing rather than
 * a crash of every job listing — the same fail-quiet read the other nullable
 * columns get — which means the child runs under its personality's toolset.
 */
function parseToolsetNarrowing(raw: string | null): BackgroundJob['toolsetNarrowing'] {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const isNames = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string');
  const narrow: unknown = Reflect.get(parsed, 'narrow');
  const exclude: unknown = Reflect.get(parsed, 'exclude');
  return {
    ...(isNames(narrow) ? { narrow } : {}),
    ...(isNames(exclude) ? { exclude } : {}),
  };
}

/**
 * `room_audience` is written only by `create` from a typed value. NULL is an
 * unstamped (pre-column) row; any other unrecognised value is a hand-edited
 * row and reads as `'shared'` — shared only narrows, so fail closed.
 */
function parseRoomAudience(raw: string | null): BackgroundJob['roomAudience'] {
  if (raw === null) return undefined;
  return raw === 'private' ? 'private' : 'shared';
}

interface JobSteerRow {
  id: number;
  job_id: string;
  text: string;
  state: string;
  source: string;
  requester_user_id: string | null;
  created_at: number;
  read_at: number | null;
}

const STEER_STATES: readonly JobSteerState[] = ['pending', 'read', 'unread'];
const STEER_SOURCES: readonly JobSteerSource[] = ['cli', 'gateway', 'web', 'tool'];

function rowToSteer(r: JobSteerRow): JobSteer {
  // Only this store writes the table, from typed values; an unrecognised
  // hand-edited value reads as the conservative choice (unread / tool).
  const state = STEER_STATES.find((s) => s === r.state) ?? 'unread';
  const source = STEER_SOURCES.find((s) => s === r.source) ?? 'tool';
  return {
    id: r.id,
    jobId: r.job_id,
    text: r.text,
    state,
    source,
    ...(r.requester_user_id !== null ? { requesterUserId: r.requester_user_id } : {}),
    createdAt: r.created_at,
    ...(r.read_at !== null ? { readAt: r.read_at } : {}),
  };
}

function rowToEvent(r: JobEventRow): BackgroundJobEvent {
  return {
    id: r.id,
    jobId: r.job_id,
    seq: r.seq,
    eventType: r.event_type as BackgroundJobEventType,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    createdAt: r.created_at,
  };
}

// `blocked` is ACTIVE, not terminal: a run parked on a human answer still owns
// its concurrency slot, so the per-root / per-personality caps must see it.
const ACTIVE_STATUSES = "('queued','running','blocked')";
const TERMINAL_STATUSES = "('done','failed','aborted','stale','expired')";

// ---------------------------------------------------------------------------
// SQLiteJobStore
// ---------------------------------------------------------------------------

export class SQLiteJobStore implements JobStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    // mkdir -p the parent directory — same raw-fs exception the other SQLite
    // stores use for path setup (the Storage abstraction covers ~/.ethos/ data
    // IO, not bootstrapping the DB file's enclosing directory). `:memory:` has
    // no parent path, so skip.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // One jobs.db is shared cross-process (gateway + serve + CLL). An explicit
    // busy timeout makes concurrent opens/writes wait instead of throwing
    // SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');

    // Downgrade guard, idempotent baseline, and the stepwise chain all live in
    // the shared harness — the same one session-sqlite / delivery-ledger use.
    migrate(this.db, {
      name: 'job-store',
      targetVersion: JOB_STORE_SCHEMA_VERSION,
      baseline: SCHEMA,
      migrations: JOB_STORE_MIGRATIONS,
    });
    addAdditiveColumns(this.db);
    this.db.exec(DELIVERY_INDEX);
  }

  async create(input: CreateBackgroundJobInput): Promise<BackgroundJob> {
    const id = randomUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO jobs
         (id, owner, parent_session_key, root_session_key, child_session_key,
          personality_id, depth, status, label, prompt, spend_usd,
          max_cost_usd, cancel_requested, created_at,
          origin_platform, origin_bot_key, origin_chat_id, origin_thread_id,
          remote_peer, remote_job_id, runner, deliver, origin_user_id, toolset_narrowing,
          room_audience, no_resume)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.owner,
        input.parentSessionKey,
        input.rootSessionKey,
        input.childSessionKey,
        input.personalityId ?? null,
        input.depth,
        'queued',
        input.label ?? null,
        input.prompt,
        0,
        input.maxCostUsd ?? null,
        0,
        now,
        input.originPlatform ?? null,
        input.originBotKey ?? null,
        input.originChatId ?? null,
        input.originThreadId ?? null,
        input.remotePeer ?? null,
        input.remoteJobId ?? null,
        input.runner ?? null,
        input.deliver ?? 'user',
        input.originUserId ?? null,
        input.toolsetNarrowing ? JSON.stringify(input.toolsetNarrowing) : null,
        input.roomAudience ?? null,
        input.noResume === true ? 1 : 0,
      );

    this.appendEventSync(id, 'queued', {});

    const job = this.getSync(id);
    if (!job) throw new Error(`create: inserted job ${id} not found`);
    return job;
  }

  async get(id: string): Promise<BackgroundJob | null> {
    return this.getSync(id);
  }

  private getSync(id: string): BackgroundJob | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  async claimNextQueued(owner: string, opts?: { adopt?: string }): Promise<BackgroundJob | null> {
    const now = Date.now();
    // A row handed back by `releaseQueued` carries its release label as owner;
    // `adopt` names the one label this claimant may take. Without it the claim
    // is exactly the owner-only claim it always was.
    const adopt = opts?.adopt ?? owner;
    const claim = this.db.transaction((): string | null => {
      const candidate = this.db
        .prepare(
          `SELECT id FROM jobs
           WHERE status = 'queued' AND owner IN (?, ?)
           ORDER BY created_at ASC, rowid ASC
           LIMIT 1`,
        )
        .get(owner, adopt) as { id: string } | undefined;
      if (!candidate) return null;

      const result = this.db
        .prepare(
          `UPDATE jobs SET status = 'running', owner = ?, started_at = ?, heartbeat_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(owner, now, now, candidate.id);
      if (result.changes !== 1) return null;

      this.appendEventSync(candidate.id, 'claimed', {});
      this.appendEventSync(candidate.id, 'running', {});
      return candidate.id;
    });

    const claimedId = claim();
    return claimedId ? this.getSync(claimedId) : null;
  }

  async releaseQueued(owner: string, releasedAs: string): Promise<number> {
    // One transaction: a claim by `owner` cannot interleave with the move, so a
    // row is either still `owner`'s or already under the release label.
    return this.db.transaction((): number => {
      const rows = this.db
        .prepare(`SELECT id FROM jobs WHERE status = 'queued' AND owner = ?`)
        .all(owner) as Array<{ id: string }>;
      const move = this.db.prepare(
        `UPDATE jobs SET owner = ? WHERE id = ? AND status = 'queued' AND owner = ?`,
      );
      let moved = 0;
      for (const { id } of rows) {
        if (move.run(releasedAs, id, owner).changes === 1) {
          // Still `queued` — the release is a re-label, recorded on the row's
          // own timeline rather than as a new status.
          this.appendEventSync(id, 'queued', { releasedBy: owner, releasedAs });
          moved++;
        }
      }
      return moved;
    })();
  }

  async setResumeAffinity(id: string, affinity: string | null): Promise<void> {
    this.db
      .prepare(
        `UPDATE jobs SET resume_affinity = ?
         WHERE id = ? AND status = 'running' AND (? IS NULL OR no_resume = 0)`,
      )
      .run(affinity, id, affinity);
  }

  /**
   * running|blocked -> queued under `released:<resume_affinity>`, counted. Runs
   * inside the caller's transaction. Deliberately NOT `recordTerminalSync`: that
   * sweeps pending steers to `unread`, and a pending steer belongs to the
   * resumed run. `ineligible` = no affinity or wrong status; `capped` = has
   * affinity but `resume_count` is already at `maxResumes` — the cap lives in
   * the WHERE clause so no reader can race past it.
   */
  private requeueSync(
    id: string,
    reason: 'restart' | 'crash',
    fromStatuses: readonly ('running' | 'blocked')[],
    maxResumes: number,
  ): 'requeued' | 'ineligible' | 'capped' {
    const marks = fromStatuses.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', owner = 'released:' || resume_affinity,
           resume_count = resume_count + 1, requeued_at = ?, heartbeat_at = NULL,
           error = NULL, blocked_since = NULL, blocked_request_id = NULL
         WHERE id = ? AND status IN (${marks}) AND resume_affinity IS NOT NULL
           AND cancel_requested = 0 AND resume_count < ?
         RETURNING resume_count`,
      )
      .get(Date.now(), id, ...fromStatuses, maxResumes) as { resume_count: number } | undefined;
    if (row !== undefined) {
      this.appendRequeuedSync(id, reason, row.resume_count);
      return 'requeued';
    }
    const affinity = this.db
      .prepare(
        'SELECT 1 AS x FROM jobs WHERE id = ? AND resume_affinity IS NOT NULL AND cancel_requested = 0',
      )
      .get(id);
    return affinity === undefined ? 'ineligible' : 'capped';
  }

  /**
   * Appends the `requeued` event, recording the tools the previous claim
   * started and never finished (`interruptedTools`) so a resume reads them from
   * one event instead of re-deriving them from the trail. The previous claim is
   * everything after the newest `claimed` event — at requeue time that is the
   * claim being ended. Per tool name: `tool_headline` count minus `tool_end`
   * count, in first-start order. Runs inside the caller's transaction; pinned by
   * `__tests__/durable-resume.test.ts`.
   */
  private appendRequeuedSync(
    id: string,
    reason: 'restart' | 'crash' | 'manual',
    attempt: number,
  ): void {
    const claim = this.db
      .prepare(`SELECT MAX(seq) AS seq FROM job_events WHERE job_id = ? AND event_type = 'claimed'`)
      .get(id) as { seq: number | null };
    const rows = this.db
      .prepare(
        `SELECT event_type, payload FROM job_events
         WHERE job_id = ? AND seq > ? AND event_type IN ('tool_headline', 'tool_end')
         ORDER BY seq ASC`,
      )
      .all(id, claim.seq ?? 0) as Array<{ event_type: string; payload: string }>;
    const open = new Map<string, number>();
    for (const r of rows) {
      // One malformed payload must not roll back the sweep's whole transaction.
      let name: unknown;
      try {
        name = (JSON.parse(r.payload) as { toolName?: unknown } | null)?.toolName;
      } catch {
        continue;
      }
      if (typeof name !== 'string') continue;
      if (r.event_type === 'tool_headline') open.set(name, (open.get(name) ?? 0) + 1);
      else open.set(name, Math.max(0, (open.get(name) ?? 0) - 1));
    }
    const interruptedTools = [...open].filter(([, n]) => n > 0).map(([name]) => name);
    this.appendEventSync(id, 'requeued', { reason, attempt, interruptedTools });
  }

  async requeueForResume(
    id: string,
    opts: { reason: 'restart' | 'crash'; maxResumes: number },
  ): Promise<boolean> {
    return (
      this.db.transaction(() =>
        this.requeueSync(id, opts.reason, ['running', 'blocked'], opts.maxResumes),
      )() === 'requeued'
    );
  }

  async requeueStale(id: string, releasedAs: string): Promise<boolean> {
    return this.db.transaction((): boolean => {
      const row = this.db
        .prepare(
          `UPDATE jobs SET status = 'queued', owner = ?, requeued_at = ?, heartbeat_at = NULL,
             error = NULL, finished_at = NULL
           WHERE id = ? AND status = 'stale'
           RETURNING resume_count`,
        )
        .get(releasedAs, Date.now(), id) as { resume_count: number } | undefined;
      if (row === undefined) return false;
      this.appendRequeuedSync(id, 'manual', row.resume_count);
      return true;
    })();
  }

  async markTainted(id: string): Promise<void> {
    this.db.prepare('UPDATE jobs SET tainted = 1 WHERE id = ?').run(id);
  }

  async heartbeat(id: string): Promise<void> {
    // The column update IS the beat — no event, to avoid write amplification.
    this.db
      .prepare(`UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND status = 'running'`)
      .run(Date.now(), id);
  }

  async updateSpend(id: string, spendUsd: number, fence?: JobClaimFence): Promise<void> {
    // No event — the executor coalesces spend updates.
    const f = fenceClause(fence);
    this.db
      .prepare(`UPDATE jobs SET spend_usd = ? WHERE id = ?${f.sql}`)
      .run(spendUsd, id, ...f.params);
  }

  async requestCancel(id: string): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE jobs SET cancel_requested = 1 WHERE id = ?').run(id);
      this.appendEventSync(id, 'cancel_requested', {});
    });
    tx();
  }

  async markBlocked(id: string, requestId: string, fence?: JobClaimFence): Promise<void> {
    const f = fenceClause(fence);
    const tx = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE jobs SET status = 'blocked', blocked_since = ?, blocked_request_id = ?
           WHERE id = ? AND status = 'running'${f.sql}`,
        )
        .run(Date.now(), requestId, id, ...f.params);
      // Guarded, not asserted: the row may have been cancelled or finished
      // between the question being asked and this write. No transition, no event.
      if (result.changes === 1) this.appendEventSync(id, 'blocked', { requestId });
    });
    tx();
  }

  async resumeFromBlocked(id: string, fence?: JobClaimFence): Promise<void> {
    const f = fenceClause(fence);
    const tx = this.db.transaction(() => {
      // heartbeat_at is bumped here, not left as it was: a run parked longer than
      // staleMs would otherwise be swept stale in the gap between resuming and
      // the executor's next beat.
      const result = this.db
        .prepare(
          `UPDATE jobs SET status = 'running', blocked_since = NULL,
             blocked_request_id = NULL, heartbeat_at = ?
           WHERE id = ? AND status = 'blocked'${f.sql}`,
        )
        .run(Date.now(), id, ...f.params);
      if (result.changes === 1) this.appendEventSync(id, 'resumed', {});
    });
    tx();
  }

  async finish(
    id: string,
    terminal: 'done' | 'failed' | 'aborted',
    fields: { summary?: string; error?: string; tainted?: boolean },
    fence?: JobClaimFence,
  ): Promise<void> {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT status, owner, started_at FROM jobs WHERE id = ?')
        .get(id) as { status: string; owner: string; started_at: number | null } | undefined;
      if (!row) throw new Error(`finish: job ${id} not found`);
      // Pinned by `__tests__/durable-resume-fence.test.ts` ('fenced finish').
      if (fence && (row.owner !== fence.owner || row.started_at !== fence.startedAt)) {
        throw Object.assign(new Error(`finish: job ${id} is no longer held by this claim`), {
          code: JOB_CLAIM_LOST,
        });
      }
      // `blocked` is a legal SOURCE (a parked run is still cancellable — §4.1's
      // blocked card offers Cancel) but never a terminal ARGUMENT.
      if (row.status !== 'running' && row.status !== 'stale' && row.status !== 'blocked') {
        throw new Error(`finish: job ${id} not in running/stale/blocked (status=${row.status})`);
      }

      // The blocked fields are cleared with the transition: a terminal row is not
      // parked on anything. The audit trail keeps the `blocked` event.
      this.db
        .prepare(
          `UPDATE jobs SET status = ?, summary = ?, error = ?, finished_at = ?,
             blocked_since = NULL, blocked_request_id = NULL,
             tainted = MAX(tainted, ?)
           WHERE id = ?`,
        )
        .run(
          terminal,
          fields.summary ?? null,
          fields.error ?? null,
          Date.now(),
          fields.tainted === true ? 1 : 0,
          id,
        );

      // A stale row that turns out alive recovers: record it before the terminal
      // event so the audit trail reads stale -> recovered -> <terminal>.
      if (row.status === 'stale') {
        this.appendEventSync(id, 'recovered', {});
      }
      this.recordTerminalSync(id, terminal, {});
    });
    tx();
  }

  /**
   * Append a terminal event and sweep `pending → unread` for a job leaving the
   * live states. Must run inside the transition's own transaction, so
   * `addSteer` (which checks status in its transaction) can never insert a
   * steer this sweep misses. Every terminal transition goes through here.
   */
  private recordTerminalSync(
    jobId: string,
    eventType: BackgroundJobEventType,
    payload: Record<string, unknown>,
  ): void {
    this.appendEventSync(jobId, eventType, payload);
    this.sweepSteers(jobId);
  }

  private sweepSteers(jobId: string): void {
    this.db
      .prepare(`UPDATE job_steers SET state = 'unread' WHERE job_id = ? AND state = 'pending'`)
      .run(jobId);
  }

  async addSteer(
    jobId: string,
    input: { text: string; source: JobSteerSource; requesterUserId?: string },
  ): Promise<AddSteerResult> {
    // BEGIN IMMEDIATE, not the shim's default deferred BEGIN: this reads the job
    // status then INSERTs, and in WAL mode a deferred read-then-write upgrade
    // fails with SQLITE_BUSY (busy_timeout does not help a stale snapshot) when
    // another process commits `finish` in between. Taking the write lock up
    // front makes that writer wait, then this read sees `finished`.
    const tx = this.db.transaction((): AddSteerResult => {
      const job = this.db
        .prepare(
          `SELECT status, remote_job_id, status IN ${ACTIVE_STATUSES} AS active
           FROM jobs WHERE id = ?`,
        )
        .get(jobId) as { status: string; remote_job_id: string | null; active: number } | undefined;
      if (!job) return { ok: false, reason: 'not_found' };
      if (job.remote_job_id !== null) return { ok: false, reason: 'remote' };
      if (job.active !== 1) {
        return { ok: false, reason: 'finished', status: job.status as BackgroundJobStatus };
      }
      if (input.text.length > JOB_STEER_MAX_CHARS) return { ok: false, reason: 'too_long' };
      const pending = this.db
        .prepare(`SELECT COUNT(*) AS n FROM job_steers WHERE job_id = ? AND state = 'pending'`)
        .get(jobId) as { n: number };
      if (pending.n >= JOB_STEER_MAX_PENDING) return { ok: false, reason: 'full' };

      const createdAt = Date.now();
      const result = this.db
        .prepare(
          `INSERT INTO job_steers (job_id, text, state, source, requester_user_id, created_at)
           VALUES (?, ?, 'pending', ?, ?, ?)`,
        )
        .run(jobId, input.text, input.source, input.requesterUserId ?? null, createdAt);
      const id = Number(result.lastInsertRowid);
      this.appendEventSync(jobId, 'steer', {
        steerId: id,
        chars: input.text.length,
        source: input.source,
      });
      return {
        ok: true,
        steer: rowToSteer({
          id,
          job_id: jobId,
          text: input.text,
          state: 'pending',
          source: input.source,
          requester_user_id: input.requesterUserId ?? null,
          created_at: createdAt,
          read_at: null,
        }),
      };
    });
    return tx.immediate();
  }

  // Polled once a second per running job: the one statement worth caching.
  private pendingSteersStmt?: ReturnType<Database.Database['prepare']>;

  async listPendingSteers(jobId: string, afterId: number): Promise<JobSteer[]> {
    this.pendingSteersStmt ??= this.db.prepare(
      `SELECT * FROM job_steers WHERE job_id = ? AND state = 'pending' AND id > ?
       ORDER BY id ASC`,
    );
    const rows = this.pendingSteersStmt.all(jobId, afterId) as JobSteerRow[];
    return rows.map(rowToSteer);
  }

  async markSteersRead(jobId: string, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const stmt = this.db.prepare(
        `UPDATE job_steers SET state = 'read', read_at = ?
         WHERE job_id = ? AND id = ? AND state = 'pending'`,
      );
      for (const id of ids) stmt.run(now, jobId, id);
    });
    tx();
  }

  async listSteers(jobId: string): Promise<JobSteer[]> {
    const rows = this.db
      .prepare('SELECT * FROM job_steers WHERE job_id = ? ORDER BY id ASC')
      .all(jobId) as JobSteerRow[];
    return rows.map(rowToSteer);
  }

  async listByOrigin(
    origin: { platform: string; botKey: string; chatId: string; threadId?: string },
    opts?: { limit?: number },
  ): Promise<BackgroundJob[]> {
    const limit = Math.max(0, Math.floor(opts?.limit ?? 50));
    // `IS ?` is NULL-safe equality: an undefined thread matches only rows with
    // no thread, a thread id matches only that thread.
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE origin_platform = ? AND origin_bot_key = ? AND origin_chat_id = ?
           AND origin_thread_id IS ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(
        origin.platform,
        origin.botKey,
        origin.chatId,
        origin.threadId ?? null,
        limit,
      ) as JobRow[];
    return rows.map(rowToJob);
  }

  async listByRoot(rootSessionKey: string): Promise<BackgroundJob[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE root_session_key = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(rootSessionKey) as JobRow[];
    return rows.map(rowToJob);
  }

  async countActiveByRoot(rootSessionKey: string): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs
         WHERE root_session_key = ? AND status IN ${ACTIVE_STATUSES}`,
      )
      .get(rootSessionKey) as { n: number };
    return row.n;
  }

  async countActiveByPersonality(personalityId: string): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs
         WHERE personality_id = ? AND status IN ${ACTIVE_STATUSES}`,
      )
      .get(personalityId) as { n: number };
    return row.n;
  }

  async countActive(): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ${ACTIVE_STATUSES}`)
      .get() as { n: number };
    return row.n;
  }

  /**
   * Discount a host pause from every in-flight job's liveness clock.
   *
   * A job that was genuinely alive and progressing across a VM suspend wrote no
   * heartbeat while the host was stopped, so the first post-resume
   * `reclaimStale` sweep reads the pause as a dead executor. Advancing every
   * running row's `heartbeat_at` by the pause duration — once, at the resume
   * boundary, before that sweep runs — corrects the timestamps the gate
   * compares without touching the gate: a job that really stopped beating is
   * still past the threshold afterwards.
   *
   * This is `resumeFromBlocked`'s bump generalized from one row to every
   * in-flight one, for the same reason it bumps there.
   *
   * Returns the number of rows bumped. A non-positive or non-finite duration
   * writes nothing.
   */
  async bumpRunningHeartbeats(pauseDurationMs: number): Promise<number> {
    // heartbeat_at is INTEGER in a STRICT table — a fractional offset would
    // make the sum a REAL and the write would throw.
    const offset = Math.round(pauseDurationMs);
    if (!Number.isFinite(pauseDurationMs) || offset <= 0) return 0;
    const result = this.db
      .prepare(
        `UPDATE jobs SET heartbeat_at = heartbeat_at + ?
         WHERE status = 'running' AND heartbeat_at IS NOT NULL`,
      )
      .run(offset);
    return result.changes;
  }

  async reclaimStale(staleMs: number, opts?: { maxResumes?: number }): Promise<BackgroundJob[]> {
    const threshold = Date.now() - staleMs;
    const maxResumes = opts?.maxResumes ?? 0;
    const ids = this.db.transaction((): string[] => {
      // `status = 'running'` is what keeps `blocked` out of the sweep, and that
      // is deliberate, not incidental: the executor stops beating for a parked
      // run, so a blocked row's heartbeat ages past the threshold by design. A
      // question waiting on a person must never be filed as a dead host.
      const rows = this.db
        .prepare(
          `SELECT id FROM jobs
           WHERE status = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at <= ?`,
        )
        .all(threshold) as Array<{ id: string }>;
      if (rows.length === 0) return [];

      const transitioned: string[] = [];
      for (const { id } of rows) {
        // D13: this transaction is the one atomic owner of the move out of
        // `running` — requeue when eligible, otherwise go stale.
        const requeued = this.requeueSync(id, 'crash', ['running'], maxResumes);
        if (requeued === 'requeued') {
          transitioned.push(id);
          continue;
        }
        const capped = maxResumes > 0 && requeued === 'capped';
        const result = this.db
          .prepare(
            `UPDATE jobs SET status = 'stale', error = ?
             WHERE id = ? AND status = 'running'`,
          )
          .run(
            capped
              ? `stalled — no heartbeat (auto-resume limit ${maxResumes} reached)`
              : 'stalled — no heartbeat',
            id,
          );
        if (result.changes === 1) {
          this.recordTerminalSync(id, 'stale', {});
          transitioned.push(id);
        }
      }
      return transitioned;
    })();

    return ids.map((id) => this.getSync(id)).filter((j): j is BackgroundJob => j !== null);
  }

  async expireQueued(ttlMs: number, opts?: { resumeTtlMs?: number }): Promise<BackgroundJob[]> {
    const now = Date.now();
    const threshold = now - ttlMs;
    const resumeThreshold = now - (opts?.resumeTtlMs ?? ttlMs);
    const ids = this.db.transaction((): string[] => {
      // A requeued row is measured from `requeued_at` (its wait for a successor
      // began then), a never-requeued row from `created_at` — as before.
      const rows = this.db
        .prepare(
          `SELECT id FROM jobs WHERE status = 'queued' AND
             ((requeued_at IS NULL AND created_at <= ?) OR (requeued_at IS NOT NULL AND requeued_at <= ?))`,
        )
        .all(threshold, resumeThreshold) as Array<{ id: string }>;
      if (rows.length === 0) return [];

      const transitioned: string[] = [];
      for (const { id } of rows) {
        const result = this.db
          .prepare(
            `UPDATE jobs SET status = 'expired',
               error = 'queued too long — no executor claimed it (process may have died before claiming)'
             WHERE id = ? AND status = 'queued'`,
          )
          .run(id);
        if (result.changes === 1) {
          this.recordTerminalSync(id, 'expired', {});
          transitioned.push(id);
        }
      }
      return transitioned;
    })();

    return ids.map((id) => this.getSync(id)).filter((j): j is BackgroundJob => j !== null);
  }

  async listRunningRemote(): Promise<BackgroundJob[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE status = 'running' AND remote_job_id IS NOT NULL
         ORDER BY created_at ASC`,
      )
      .all() as JobRow[];
    return rows.map(rowToJob);
  }

  async listUndelivered(originBotKeys: string[]): Promise<BackgroundJob[]> {
    if (originBotKeys.length === 0) return [];
    // Announceable: `done`/`failed`, and an `aborted` row ONLY when its
    // runtime's shutdown interrupted it (`JOB_ABORTED_BY_SHUTDOWN`) — the
    // origin chat is told to ask again. A user's cancel stays silent, and
    // `stale`/`expired` have no result worth waking anyone for. Narrowing here
    // (rather than at the caller) is also what keeps this query's result set
    // bounded: an un-announceable row is never scanned again.
    const placeholders = originBotKeys.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE (status IN ('done','failed') OR (status = 'aborted' AND error = ?))
           AND delivered_at IS NULL
           AND origin_bot_key IN (${placeholders})
           AND origin_platform IS NOT NULL
           AND origin_chat_id IS NOT NULL
         ORDER BY COALESCE(finished_at, created_at) ASC, rowid ASC`,
      )
      .all(JOB_ABORTED_BY_SHUTDOWN, ...originBotKeys) as JobRow[];
    return rows.map(rowToJob);
  }

  async claimDelivery(id: string): Promise<boolean> {
    const result = this.db
      .prepare('UPDATE jobs SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL')
      .run(Date.now(), id);
    return result.changes === 1;
  }

  async releaseDelivery(id: string): Promise<void> {
    this.db.prepare('UPDATE jobs SET delivered_at = NULL WHERE id = ?').run(id);
  }

  /**
   * G5 — the mid-run "needs you" claim, keyed by the pending question's
   * requestId. `INSERT OR IGNORE` on a PRIMARY KEY is the same atomic
   * exactly-once shape `claimDelivery`'s conditional UPDATE has: SQLite
   * serialises the write, so of two processes inserting the same requestId
   * exactly one reports `changes === 1`.
   */
  async claimNotice(requestId: string, jobId: string): Promise<boolean> {
    const result = this.db
      .prepare(
        'INSERT OR IGNORE INTO job_notices (request_id, job_id, claimed_at) VALUES (?, ?, ?)',
      )
      .run(requestId, jobId, Date.now());
    return result.changes === 1;
  }

  async releaseNotice(requestId: string): Promise<void> {
    this.db.prepare('DELETE FROM job_notices WHERE request_id = ?').run(requestId);
  }

  async pruneTerminal(cutoffMs: number): Promise<number> {
    const prune = this.db.transaction((): number => {
      // Delete events first to respect the FK (foreign_keys is ON), matching on
      // the same terminal + age predicate as the jobs delete.
      this.db
        .prepare(
          `DELETE FROM job_events WHERE job_id IN (
             SELECT id FROM jobs
             WHERE status IN ${TERMINAL_STATUSES}
               AND COALESCE(finished_at, created_at) < ?
           )`,
        )
        .run(cutoffMs);

      // Same predicate for the notice claims: a pruned job's parked-question
      // claims have nothing left to be exactly-once about.
      this.db
        .prepare(
          `DELETE FROM job_notices WHERE job_id IN (
             SELECT id FROM jobs
             WHERE status IN ${TERMINAL_STATUSES}
               AND COALESCE(finished_at, created_at) < ?
           )`,
        )
        .run(cutoffMs);

      const result = this.db
        .prepare(
          `DELETE FROM jobs
           WHERE status IN ${TERMINAL_STATUSES}
             AND COALESCE(finished_at, created_at) < ?`,
        )
        .run(cutoffMs);

      // job_steers has no FK (D2): sweep the steers of the jobs just deleted
      // (and any an older build's prune orphaned) once the jobs rows are gone.
      this.db.prepare('DELETE FROM job_steers WHERE job_id NOT IN (SELECT id FROM jobs)').run();
      return result.changes;
    });
    return prune();
  }

  async appendEvent(
    jobId: string,
    eventType: BackgroundJobEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    this.appendEventSync(jobId, eventType, payload);
  }

  private appendEventSync(
    jobId: string,
    eventType: BackgroundJobEventType,
    payload: Record<string, unknown>,
  ): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const maxRow = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM job_events WHERE job_id = ?')
        .get(jobId) as { max_seq: number };
      const nextSeq = maxRow.max_seq + 1;
      this.db
        .prepare(
          `INSERT INTO job_events (job_id, seq, event_type, payload, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(jobId, nextSeq, eventType, JSON.stringify(payload), now);
    });
    tx();
  }

  /**
   * Bounded tail read. The inner query walks the `job_events(job_id, seq)` index
   * BACKWARDS and stops after `limit` rows, so a two-hour run's trail costs the
   * page, not the job; the outer query flips it back to ascending because that
   * is the contract every caller reads against. `beforeSeq` narrows the same
   * index range, so paging backwards is another bounded scan, not a growing one.
   *
   * With no `opts` the query is exactly the old one — the whole trail, seq ASC.
   */
  async getEvents(jobId: string, opts?: GetJobEventsOptions): Promise<BackgroundJobEvent[]> {
    const params: unknown[] = [jobId];
    let where = 'job_id = ?';
    if (opts?.eventType !== undefined) {
      where += ' AND event_type = ?';
      params.push(opts.eventType);
    }
    if (opts?.beforeSeq !== undefined) {
      where += ' AND seq < ?';
      params.push(opts.beforeSeq);
    }
    if (opts?.afterSeq !== undefined) {
      // Forward tail: the OLDEST `limit` rows after the cursor, ascending, so
      // a poller paging forward never skips rows.
      where += ' AND seq > ?';
      params.push(opts.afterSeq);
      if (opts.limit !== undefined) {
        params.push(Math.max(0, Math.floor(opts.limit)));
        const rows = this.db
          .prepare(`SELECT * FROM job_events WHERE ${where} ORDER BY seq ASC LIMIT ?`)
          .all(...params) as JobEventRow[];
        return rows.map(rowToEvent);
      }
    }

    if (opts?.limit === undefined) {
      const rows = this.db
        .prepare(`SELECT * FROM job_events WHERE ${where} ORDER BY seq ASC`)
        .all(...params) as JobEventRow[];
      return rows.map(rowToEvent);
    }

    params.push(Math.max(0, Math.floor(opts.limit)));
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM job_events WHERE ${where} ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq ASC`,
      )
      .all(...params) as JobEventRow[];
    return rows.map(rowToEvent);
  }

  close(): void {
    this.db.close();
  }
}
