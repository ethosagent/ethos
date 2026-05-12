import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'todo'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'done'
  | 'archived'
  | 'scheduled';

export type WorkspaceMode = 'scratch' | 'worktree' | 'dir';

export type RunOutcome = 'completed' | 'blocked' | 'stalled' | 'cancelled';

export type EventKind =
  | 'created'
  | 'status_changed'
  | 'commented'
  | 'assigned'
  | 'linked'
  | 'unlinked'
  | 'run_started'
  | 'run_completed'
  | 'heartbeat'
  | 'archived';

export interface Task {
  id: string;
  title: string;
  body: string;
  assignee: string | null;
  status: TaskStatus;
  priority: number;
  workspaceMode: WorkspaceMode;
  workspacePath: string | null;
  scheduledFor: number | null;
  idempotencyKey: string | null;
  currentRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskComment {
  id: string;
  taskId: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface TaskLink {
  parentId: string;
  childId: string;
}

export interface TaskRun {
  id: string;
  taskId: string;
  startedAt: number;
  endedAt: number | null;
  outcome: RunOutcome | null;
  summary: string | null;
  lastHeartbeatAt: number;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  kind: EventKind;
  actor: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface CreateTaskInput {
  title: string;
  body?: string;
  assignee?: string | null;
  priority?: number;
  parents?: string[];
  workspaceMode?: WorkspaceMode;
  scheduledFor?: number | null;
  idempotencyKey?: string | null;
  actor?: string;
}

export interface ListTasksFilter {
  assignee?: string;
  status?: TaskStatus;
  parentId?: string;
  q?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    assignee        TEXT,
    status          TEXT NOT NULL
                    CHECK (status IN ('todo','ready','running','blocked','done','archived','scheduled')),
    priority        INTEGER NOT NULL DEFAULT 0,
    workspace_mode  TEXT NOT NULL DEFAULT 'scratch'
                    CHECK (workspace_mode IN ('scratch','worktree','dir')),
    workspace_path  TEXT,
    scheduled_for   INTEGER,
    idempotency_key TEXT,
    current_run_id  TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS tasks_idem ON tasks(idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS tasks_status_assignee ON tasks(status, assignee);
  CREATE INDEX IF NOT EXISTS tasks_scheduled ON tasks(scheduled_for)
    WHERE scheduled_for IS NOT NULL;

  CREATE TABLE IF NOT EXISTS task_comments (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS task_comments_task ON task_comments(task_id, created_at);

  CREATE TABLE IF NOT EXISTS task_links (
    parent_id TEXT NOT NULL,
    child_id  TEXT NOT NULL,
    PRIMARY KEY (parent_id, child_id),
    FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (child_id)  REFERENCES tasks(id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS task_links_child ON task_links(child_id);

  CREATE TABLE IF NOT EXISTS task_runs (
    id                TEXT PRIMARY KEY,
    task_id           TEXT NOT NULL,
    started_at        INTEGER NOT NULL,
    ended_at          INTEGER,
    outcome           TEXT CHECK (outcome IS NULL OR outcome IN ('completed','blocked','stalled','cancelled')),
    summary           TEXT,
    last_heartbeat_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS task_runs_task ON task_runs(task_id, started_at);
  CREATE UNIQUE INDEX IF NOT EXISTS task_runs_open_one ON task_runs(task_id)
    WHERE ended_at IS NULL;

  CREATE TABLE IF NOT EXISTS task_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    kind       TEXT NOT NULL
               CHECK (kind IN ('created','status_changed','commented','assigned','linked','unlinked','run_started','run_completed','heartbeat','archived')),
    actor      TEXT NOT NULL,
    data_json  TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, created_at);
  CREATE INDEX IF NOT EXISTS task_events_recent ON task_events(created_at);

  -- task_fts is a hand-maintained denormalized search index over task title/body plus
  -- aggregated comment bodies. Comments are append-only at the API surface (no
  -- updateComment / deleteComment methods), so we only need INSERT triggers to keep
  -- task_fts.comments fresh. If a future schema ever adds comment update/delete paths,
  -- it MUST add the matching task_comments UPDATE/DELETE triggers below to keep
  -- search consistent.
  CREATE VIRTUAL TABLE IF NOT EXISTS task_fts USING fts5(
    task_id UNINDEXED,
    title,
    body,
    comments,
    tokenize = 'porter'
  );

  CREATE TRIGGER IF NOT EXISTS tasks_fts_ai AFTER INSERT ON tasks BEGIN
    INSERT INTO task_fts(task_id, title, body, comments)
    VALUES (new.id, new.title, new.body, '');
  END;

  CREATE TRIGGER IF NOT EXISTS tasks_fts_au AFTER UPDATE OF title, body ON tasks BEGIN
    UPDATE task_fts SET title = new.title, body = new.body
    WHERE task_id = new.id;
  END;

  CREATE TRIGGER IF NOT EXISTS tasks_fts_ad AFTER DELETE ON tasks BEGIN
    DELETE FROM task_fts WHERE task_id = old.id;
  END;

  CREATE TRIGGER IF NOT EXISTS comments_fts_ai AFTER INSERT ON task_comments BEGIN
    UPDATE task_fts
    SET comments = (
      SELECT COALESCE(GROUP_CONCAT(body, ' '), '')
      FROM task_comments WHERE task_id = new.task_id
    )
    WHERE task_id = new.task_id;
  END;
`;

// ---------------------------------------------------------------------------
// KanbanStore
// ---------------------------------------------------------------------------

export class KanbanStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    // mkdir -p the parent directory. Same raw-fs exception that session-sqlite uses
    // for path setup (the `Storage` abstraction is for ~/.ethos/ data IO, not for
    // bootstrapping the SQLite file's enclosing directory). `:memory:` has no
    // parent path, so skip.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // Version check FIRST — refuse to touch a DB whose schema is newer than this code.
    const versionRows = this.db.pragma('user_version') as Array<{ user_version: number }>;
    const currentVersion = versionRows[0]?.user_version ?? 0;
    if (currentVersion > 1) {
      throw new Error(
        `kanban-store: database user_version=${currentVersion} is newer than code (1); refusing to open to avoid downgrade`,
      );
    }
    this.db.exec(SCHEMA);
    if (currentVersion === 0) {
      this.db.pragma('user_version = 1');
    }
  }

  createTask(input: CreateTaskInput): Task {
    const idempotencyKey = input.idempotencyKey ?? null;
    const id = newTaskId();
    const now = Date.now();
    const body = input.body ?? '';
    const assignee = input.assignee ?? null;
    const priority = input.priority ?? 0;
    const workspaceMode: WorkspaceMode = input.workspaceMode ?? 'scratch';
    const scheduledFor = input.scheduledFor ?? null;
    const status: TaskStatus = scheduledFor !== null ? 'scheduled' : 'todo';
    const parents = input.parents ?? [];
    const actor = input.actor ?? 'system';

    const insertTask = this.db.prepare(
      `INSERT INTO tasks
       (id, title, body, assignee, status, priority, workspace_mode, workspace_path,
        scheduled_for, idempotency_key, current_run_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );

    const tx = this.db.transaction((): string => {
      // Race-safe idempotency: try insert, catch unique constraint, then look up.
      // The catch path covers two scenarios:
      // (1) a concurrent caller raced us between any SELECT-then-INSERT
      // (2) this createTask is nested inside another transaction where
      //     tx.immediate() degrades to a SAVEPOINT and won't acquire the write lock at BEGIN
      if (idempotencyKey !== null) {
        const existing = this.db
          .prepare('SELECT id FROM tasks WHERE idempotency_key = ?')
          .get(idempotencyKey) as { id: string } | undefined;
        if (existing) return existing.id;
      }

      try {
        insertTask.run(
          id,
          input.title,
          body,
          assignee,
          status,
          priority,
          workspaceMode,
          null,
          scheduledFor,
          idempotencyKey,
          null,
          now,
          now,
        );
      } catch (err) {
        // If we raced another caller with the same idempotency_key, return their row.
        const msg = err instanceof Error ? err.message : String(err);
        if (
          idempotencyKey !== null &&
          /UNIQUE constraint failed: tasks\.idempotency_key/.test(msg)
        ) {
          const winner = this.db
            .prepare('SELECT id FROM tasks WHERE idempotency_key = ?')
            .get(idempotencyKey) as { id: string } | undefined;
          if (winner) return winner.id;
        }
        throw err;
      }
      this.emit(id, 'created', actor, { status });
      // Route parent links through the same cycle-checked path as `link()` so we have
      // one code path for the invariant. The check is trivially true for a fresh task
      // (no descendants yet), but we want a single owner of the rule.
      for (const parentId of parents) {
        this.link(parentId, id, actor);
      }
      return id;
    });
    const finalId = tx.immediate();

    const task = this.getTask(finalId);
    if (!task) throw new Error(`createTask: inserted task ${finalId} not found`);
    return task;
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasks(filter: ListTasksFilter = {}): Task[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let join = '';

    if (filter.q !== undefined) {
      join += ' JOIN task_fts ON task_fts.task_id = t.id';
      conditions.push('task_fts MATCH ?');
      values.push(escapeFtsQuery(filter.q));
    }
    if (filter.status !== undefined) {
      conditions.push('t.status = ?');
      values.push(filter.status);
    }
    if (filter.assignee !== undefined) {
      conditions.push('t.assignee = ?');
      values.push(filter.assignee);
    }
    if (filter.parentId !== undefined) {
      join += ' JOIN task_links l ON l.child_id = t.id';
      conditions.push('l.parent_id = ?');
      values.push(filter.parentId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? -1;
    const order = filter.q !== undefined ? 'bm25(task_fts)' : 't.priority DESC, t.created_at DESC';

    // DISTINCT defends against any future case where joins (FTS shadow table or
    // task_links) could multiply rows — the public API returns tasks, not joined rows.
    const rows = this.db
      .prepare(`SELECT DISTINCT t.* FROM tasks t${join} ${where} ORDER BY ${order} LIMIT ?`)
      .all(...values, limit) as TaskRow[];
    return rows.map(rowToTask);
  }

  updateStatus(taskId: string, status: TaskStatus, reason?: string, actor = 'system'): Task {
    const now = Date.now();

    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT status, current_run_id FROM tasks WHERE id = ?')
        .get(taskId) as { status: TaskStatus; current_run_id: string | null } | undefined;
      if (!row) throw new Error(`updateStatus: task ${taskId} not found`);
      const oldStatus = row.status;
      const oldRunId = row.current_run_id;

      let runStarted = false;
      let runCancelled = false;

      if (status === 'running' && oldRunId === null) {
        // Open a new run as a side-effect of the status flip
        const runId = newRunId();
        this.db
          .prepare(
            `INSERT INTO task_runs (id, task_id, started_at, last_heartbeat_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(runId, taskId, now, now);
        this.db
          .prepare('UPDATE tasks SET status = ?, current_run_id = ?, updated_at = ? WHERE id = ?')
          .run(status, runId, now, taskId);
        runStarted = true;
      } else if (oldStatus === 'running' && status !== 'running' && oldRunId !== null) {
        // Caller is leaving 'running' without going through completeRun/blockRun.
        // Auto-cancel the open run so task status and run state stay consistent.
        const result = this.db
          .prepare(
            `UPDATE task_runs SET ended_at = ?, outcome = ?
             WHERE id = ? AND ended_at IS NULL`,
          )
          .run(now, 'cancelled', oldRunId);
        this.db
          .prepare(
            'UPDATE tasks SET status = ?, current_run_id = NULL, updated_at = ? WHERE id = ?',
          )
          .run(status, now, taskId);
        runCancelled = result.changes === 1;
      } else {
        this.db
          .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
          .run(status, now, taskId);
      }

      if (oldStatus !== status) {
        this.emit(taskId, 'status_changed', actor, {
          from: oldStatus,
          to: status,
          reason: reason ?? null,
        });
      }
      if (runStarted) this.emit(taskId, 'run_started', actor, {});
      if (runCancelled) {
        this.emit(taskId, 'run_completed', actor, { outcome: 'cancelled', summary: null });
      }
    });
    tx();

    return this.getTask(taskId) as Task;
  }

  completeRun(taskId: string, summary: string, actor = 'system'): Task {
    return this.endRun(taskId, 'done', 'completed', summary, actor);
  }

  blockRun(taskId: string, reason: string, actor = 'system'): Task {
    // The reason is captured both on the run (summary column) and as a comment so
    // it shows up in the human-readable thread. Atomic with the block transition.
    return this.endRun(taskId, 'blocked', 'blocked', reason, actor, { comment: reason });
  }

  private endRun(
    taskId: string,
    newStatus: TaskStatus,
    outcome: RunOutcome,
    summary: string | null,
    actor: string,
    opts: { comment?: string } = {},
  ): Task {
    const now = Date.now();
    // The whole "claim the run and end it" sequence runs inside one transaction so that
    // a concurrent writer can't end the same run between our read and our write.
    const tx = this.db.transaction((): Task => {
      const row = this.db
        .prepare('SELECT status, current_run_id FROM tasks WHERE id = ?')
        .get(taskId) as { status: TaskStatus; current_run_id: string | null } | undefined;
      if (!row) throw new Error(`endRun: task ${taskId} not found`);
      if (row.current_run_id === null) {
        throw new Error(`no open run: task ${taskId} has no current run to end`);
      }
      const result = this.db
        .prepare(
          `UPDATE task_runs SET ended_at = ?, outcome = ?, summary = ?
           WHERE id = ? AND ended_at IS NULL`,
        )
        .run(now, outcome, summary, row.current_run_id);
      if (result.changes !== 1) {
        throw new Error(`no open run: race ended run ${row.current_run_id} concurrently`);
      }
      this.db
        .prepare('UPDATE tasks SET status = ?, current_run_id = NULL, updated_at = ? WHERE id = ?')
        .run(newStatus, now, taskId);
      if (opts.comment !== undefined) {
        const commentId = newCommentId();
        this.db
          .prepare(
            'INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?,?,?,?,?)',
          )
          .run(commentId, taskId, actor, opts.comment, now);
        this.emit(taskId, 'commented', actor, { commentId });
      }
      this.emit(taskId, 'run_completed', actor, { outcome, summary });
      if (row.status !== newStatus) {
        this.emit(taskId, 'status_changed', actor, { from: row.status, to: newStatus });
      }
      return this.getTask(taskId) as Task;
    });
    return tx();
  }

  heartbeatRun(taskId: string, note?: string, actor = 'system'): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const row = this.db.prepare('SELECT current_run_id FROM tasks WHERE id = ?').get(taskId) as
        | { current_run_id: string | null }
        | undefined;
      if (!row) throw new Error(`heartbeatRun: task ${taskId} not found`);
      if (row.current_run_id === null) {
        throw new Error(`no open run: task ${taskId} has no current run to heartbeat`);
      }
      const result = this.db
        .prepare('UPDATE task_runs SET last_heartbeat_at = ? WHERE id = ? AND ended_at IS NULL')
        .run(now, row.current_run_id);
      if (result.changes !== 1) {
        throw new Error(`no open run: race ended run ${row.current_run_id} concurrently`);
      }
      this.emit(taskId, 'heartbeat', actor, { note: note ?? null });
    });
    tx();
  }

  listRuns(taskId: string): TaskRun[] {
    // rowid tie-breaks same-millisecond inserts; same trick the session-sqlite store uses.
    const rows = this.db
      .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at ASC, rowid ASC')
      .all(taskId) as TaskRunRow[];
    return rows.map(rowToRun);
  }

  addComment(taskId: string, author: string, body: string): TaskComment {
    const id = newCommentId();
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?,?,?,?,?)',
        )
        .run(id, taskId, author, body, now);
      this.emit(taskId, 'commented', author, { commentId: id });
    });
    tx();
    return { id, taskId, author, body, createdAt: now };
  }

  listComments(taskId: string): TaskComment[] {
    const rows = this.db
      .prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(taskId) as TaskCommentRow[];
    return rows.map(rowToComment);
  }

  assign(taskId: string, assignee: string | null, actor = 'system'): Task {
    const now = Date.now();
    const tx = this.db.transaction((): Task => {
      const result = this.db
        .prepare('UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ?')
        .run(assignee, now, taskId);
      if (result.changes === 0) {
        throw new Error(`assign: task ${taskId} not found`);
      }
      this.emit(taskId, 'assigned', actor, { assignee });
      return this.getTask(taskId) as Task;
    });
    return tx();
  }

  archive(taskId: string, actor = 'system'): Task {
    // updateStatus owns run + status changes (auto-cancels an open run if any).
    // We wrap it in an outer tx so the 'archived' event lands atomically with the change.
    const tx = this.db.transaction((): Task => {
      const updated = this.updateStatus(taskId, 'archived', undefined, actor);
      this.emit(taskId, 'archived', actor, {});
      return updated;
    });
    return tx();
  }

  link(parentId: string, childId: string, actor = 'system'): void {
    if (parentId === childId) {
      throw new Error(`cycle: ${childId} cannot be its own parent`);
    }
    // Cycle check is a recursive walk over task_links — O(graph_size) per insert.
    // Plan A targets per-personality boards (≲ low thousands of tasks); if Plan B
    // scales to large shared boards, swap this for a closure-table maintained on link.
    // Check + insert in one transaction so concurrent writers can't both pass
    // the check and then both insert edges that close a cycle.
    const tx = this.db.transaction(() => {
      const ancestor = this.db
        .prepare(
          `WITH RECURSIVE ancestors(id) AS (
             SELECT parent_id FROM task_links WHERE child_id = ?
             UNION
             SELECT l.parent_id FROM task_links l JOIN ancestors a ON l.child_id = a.id
           )
           SELECT 1 AS hit FROM ancestors WHERE id = ? LIMIT 1`,
        )
        .get(parentId, childId) as { hit: number } | undefined;
      if (ancestor) {
        throw new Error(`cycle: ${childId} is already a transitive parent of ${parentId}`);
      }
      try {
        this.db
          .prepare('INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)')
          .run(parentId, childId);
        this.emit(parentId, 'linked', actor, { parentId, childId });
        this.emit(childId, 'linked', actor, { parentId, childId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/FOREIGN KEY/i.test(msg)) {
          throw new Error(
            `not found: parent or child task does not exist (${parentId} -> ${childId})`,
          );
        }
        if (/UNIQUE constraint failed: task_links/.test(msg)) {
          // Idempotent: the edge already exists. No event, no error.
          return;
        }
        throw err;
      }
    });
    tx.immediate();
  }

  getParents(childId: string): Task[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t
         JOIN task_links l ON l.parent_id = t.id
         WHERE l.child_id = ?
         ORDER BY t.created_at ASC`,
      )
      .all(childId) as TaskRow[];
    return rows.map(rowToTask);
  }

  // ---------------------------------------------------------------------------
  // Plan B dispatcher helpers — promote / reclaim / dispatch queries
  // ---------------------------------------------------------------------------

  /**
   * Promote `todo` tasks whose blocking parents are all `done` to `ready`.
   *
   * A "blocking parent" is a parent with a real assignee. Parents created via
   * `kanban_create_goal` carry `assignee=NULL` and are treated as transparent
   * containers — they organize tasks without gating them. Without that rule,
   * a coordinator's `kanban_create_goal` + `kanban_create(parents=[goal])`
   * flow deadlocks: the goal has no assignee, so nothing closes it, so the
   * child never promotes.
   *
   * Archived parents stay as blockers (archive = abandoned, not satisfied),
   * matching the same semantics `kanban_unblock` uses.
   */
  promoteReady(actor = 'system'): string[] {
    const candidates = this.db
      .prepare(
        `SELECT t.id FROM tasks t
         WHERE t.status = 'todo'
           AND NOT EXISTS (
             SELECT 1 FROM task_links l
             JOIN tasks p ON p.id = l.parent_id
             WHERE l.child_id = t.id
               AND p.assignee IS NOT NULL
               AND p.status != 'done'
           )`,
      )
      .all() as Array<{ id: string }>;
    for (const c of candidates) {
      this.updateStatus(c.id, 'ready', 'parents done', actor);
    }
    return candidates.map((c) => c.id);
  }

  /**
   * Promote `scheduled` tasks whose `scheduled_for` is in the past to `ready`.
   * Returns the promoted task ids.
   */
  promoteScheduled(nowMs: number = Date.now(), actor = 'system'): string[] {
    const candidates = this.db
      .prepare(
        `SELECT id FROM tasks WHERE status = 'scheduled' AND scheduled_for IS NOT NULL
         AND scheduled_for <= ?`,
      )
      .all(nowMs) as Array<{ id: string }>;
    for (const c of candidates) {
      this.updateStatus(c.id, 'ready', 'scheduled time reached', actor);
    }
    return candidates.map((c) => c.id);
  }

  /**
   * Find open runs whose `last_heartbeat_at` is older than `cutoffMs` ago.
   * The caller (typically the dispatcher) decides what to do — usually
   * `blockRun(id, 'stalled')`.
   */
  findStalledRuns(cutoffMs: number, nowMs: number = Date.now()): TaskRun[] {
    const threshold = nowMs - cutoffMs;
    const rows = this.db
      .prepare(
        `SELECT * FROM task_runs WHERE ended_at IS NULL AND last_heartbeat_at < ?
         ORDER BY last_heartbeat_at ASC`,
      )
      .all(threshold) as TaskRunRow[];
    return rows.map(rowToRun);
  }

  /**
   * Tasks ready for the dispatcher to claim: status=ready, an assignee is set,
   * and there is no current run yet.
   */
  findReadyToDispatch(): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'ready' AND assignee IS NOT NULL AND current_run_id IS NULL
         ORDER BY priority DESC, created_at ASC`,
      )
      .all() as TaskRow[];
    return rows.map(rowToTask);
  }

  listEvents(taskId: string): TaskEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC, id ASC')
      .all(taskId) as TaskEventRow[];
    return rows.map(rowToEvent);
  }

  private emit(
    taskId: string,
    kind: EventKind,
    actor: string,
    data: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        'INSERT INTO task_events (task_id, kind, actor, data_json, created_at) VALUES (?,?,?,?,?)',
      )
      .run(taskId, kind, actor, JSON.stringify(data), Date.now());
  }

  searchFts(query: string): Task[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t
         JOIN task_fts ON task_fts.task_id = t.id
         WHERE task_fts MATCH ?
         ORDER BY bm25(task_fts)`,
      )
      .all(escapeFtsQuery(query)) as TaskRow[];
    return rows.map(rowToTask);
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string;
  title: string;
  body: string;
  assignee: string | null;
  status: string;
  priority: number;
  workspace_mode: string;
  workspace_path: string | null;
  scheduled_for: number | null;
  idempotency_key: string | null;
  current_run_id: string | null;
  created_at: number;
  updated_at: number;
}

interface TaskRunRow {
  id: string;
  task_id: string;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  summary: string | null;
  last_heartbeat_at: number;
}

interface TaskCommentRow {
  id: string;
  task_id: string;
  author: string;
  body: string;
  created_at: number;
}

function rowToRun(r: TaskRunRow): TaskRun {
  return {
    id: r.id,
    taskId: r.task_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    outcome: (r.outcome as RunOutcome | null) ?? null,
    summary: r.summary,
    lastHeartbeatAt: r.last_heartbeat_at,
  };
}

function rowToComment(r: TaskCommentRow): TaskComment {
  return {
    id: r.id,
    taskId: r.task_id,
    author: r.author,
    body: r.body,
    createdAt: r.created_at,
  };
}

interface TaskEventRow {
  id: number;
  task_id: string;
  kind: string;
  actor: string;
  data_json: string;
  created_at: number;
}

function rowToEvent(r: TaskEventRow): TaskEvent {
  return {
    id: r.id,
    taskId: r.task_id,
    kind: r.kind as EventKind,
    actor: r.actor,
    data: JSON.parse(r.data_json) as Record<string, unknown>,
    createdAt: r.created_at,
  };
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    assignee: r.assignee,
    status: r.status as TaskStatus,
    priority: r.priority,
    workspaceMode: r.workspace_mode as WorkspaceMode,
    workspacePath: r.workspace_path,
    scheduledFor: r.scheduled_for,
    idempotencyKey: r.idempotency_key,
    currentRunId: r.current_run_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ID helpers (exported for tests + potential reuse)
export function newTaskId(): string {
  return `t_${shortId()}`;
}

export function newCommentId(): string {
  return `c_${shortId()}`;
}

export function newRunId(): string {
  return `r_${shortId()}`;
}

function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

// FTS5 query escaping: wrap as a quoted phrase so callers can pass arbitrary user text
// (including spaces and special FTS5 operators) without triggering a syntax error.
// Multi-word inputs match as exact phrases; single words match as tokens.
function escapeFtsQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}
