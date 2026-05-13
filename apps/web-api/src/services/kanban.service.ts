import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  KanbanStore,
  type Task,
  type TaskComment,
  type TaskEvent,
  type TaskRun,
  type TeamMemberStats,
} from '@ethosagent/kanban-store';
import {
  parseTeamManifest,
  readRuntimeFrom,
  type TeamRuntime,
  teamsDir,
} from '@ethosagent/team-supervisor';
import type {
  KanbanBoardSnapshot,
  KanbanComment,
  KanbanEvent,
  KanbanLink,
  KanbanMemberStats,
  KanbanRun,
  KanbanTask,
  KanbanTaskStatus,
  KanbanTeamSummary,
} from '@ethosagent/web-contracts';

// Kanban service. Lightweight — opens the team's `~/.ethos/teams/<name>/board.db`
// per request, queries it, and shapes rows into wire-format. We do NOT keep a
// long-lived KanbanStore handle here: the team supervisor owns the writer, and
// SQLite WAL lets us read alongside it safely as long as we open/close cleanly.

const RECENT_EVENTS_CAP = 100;

export interface KanbanServiceOptions {
  /** Override the teams directory (testing). Defaults to `~/.ethos/teams`. */
  teamsDir?: string;
}

export class KanbanService {
  private readonly rootDir: string;

  constructor(opts: KanbanServiceOptions = {}) {
    this.rootDir = opts.teamsDir ?? teamsDir();
  }

  /** Enumerate teams from the manifests on disk; merge in runtime status. */
  async list(): Promise<{ teams: KanbanTeamSummary[] }> {
    if (!existsSync(this.rootDir)) return { teams: [] };

    const entries = readdirSync(this.rootDir, { withFileTypes: true });
    const manifestFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
      .map((e) => e.name.replace(/\.yaml$/, ''));

    const teams: KanbanTeamSummary[] = [];
    for (const name of manifestFiles) {
      const manifestPath = join(this.rootDir, `${name}.yaml`);
      try {
        const src = await readFile(manifestPath, 'utf-8');
        const manifest = parseTeamManifest(src);
        const runtime = readRuntimeFrom(this.rootDir, name);
        teams.push(toTeamSummary(name, manifest.description, manifest, runtime, this.rootDir));
      } catch {
        // Malformed manifest — skip rather than poison the list.
      }
    }
    return { teams };
  }

  /** Open the team board read-only, return a snapshot. */
  async getBoard(team: string): Promise<{ board: KanbanBoardSnapshot }> {
    assertSafeTeamName(team);
    const manifestPath = join(this.rootDir, `${team}.yaml`);
    if (!existsSync(manifestPath)) {
      throw new Error(`team not found: ${team}`);
    }
    const manifest = parseTeamManifest(await readFile(manifestPath, 'utf-8'));
    const runtime = readRuntimeFrom(this.rootDir, team);
    const summary = toTeamSummary(team, manifest.description, manifest, runtime, this.rootDir);

    const boardPath = join(this.rootDir, team, 'board.db');
    if (!existsSync(boardPath)) {
      // No board yet — return an empty snapshot rather than 404.
      return {
        board: {
          team: summary,
          tasks: [],
          links: [],
          recentEvents: [],
          memberStats: [],
        },
      };
    }

    // Open with the team name as `teamId` so `getMemberStats()` returns this
    // board's per-member outcome counters.
    const store = new KanbanStore(boardPath, { teamId: team });
    try {
      const tasks = store.listTasks({ limit: 1000 }).map(toWireTask);
      // Pull links straight from the underlying DB — store doesn't expose a
      // list method since callers usually want parent/child filtering instead.
      const linkRows = (
        store as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }
      ).db
        .prepare('SELECT parent_id, child_id FROM task_links')
        .all() as Array<{ parent_id: string; child_id: string }>;
      const links: KanbanLink[] = linkRows.map((r) => ({
        parentId: r.parent_id,
        childId: r.child_id,
      }));

      // Recent events across the whole board, capped.
      const eventRows = (
        store as unknown as { db: { prepare: (s: string) => { all: (n: number) => unknown[] } } }
      ).db
        .prepare(
          'SELECT id, task_id, kind, actor, data_json, created_at FROM task_events ORDER BY id DESC LIMIT ?',
        )
        .all(RECENT_EVENTS_CAP) as Array<{
        id: number;
        task_id: string;
        kind: string;
        actor: string;
        data_json: string;
        created_at: number;
      }>;
      const recentEvents: KanbanEvent[] = eventRows.reverse().map((r) => ({
        id: r.id,
        taskId: r.task_id,
        kind: r.kind as KanbanEvent['kind'],
        actor: r.actor,
        data: JSON.parse(r.data_json) as Record<string, unknown>,
        createdAt: new Date(r.created_at).toISOString(),
      }));

      const memberStats: KanbanMemberStats[] = [...store.getMemberStats().values()].map(
        toWireMemberStats,
      );

      return {
        board: {
          team: summary,
          tasks,
          links,
          recentEvents,
          memberStats,
        },
      };
    } finally {
      store.close();
    }
  }

  /**
   * Human-initiated status update. Threads `human:<sessionLabel>` as the actor
   * so the audit trail clearly separates UI edits from agent actions. Honors
   * the same auto-cancel-on-leave-running semantics as agent calls.
   */
  async updateStatus(opts: {
    team: string;
    taskId: string;
    status: KanbanTaskStatus;
    reason?: string;
    actor: string;
  }): Promise<{ task: KanbanTask }> {
    assertSafeTeamName(opts.team);
    const boardPath = join(this.rootDir, opts.team, 'board.db');
    if (!existsSync(boardPath)) {
      throw new Error(`team board not found: ${opts.team}`);
    }
    // Open with the team name as `teamId` so terminal transitions (failed,
    // needs_revision) recorded here update the same per-member stats ledger the
    // dispatcher writes through — keeping the ledger consistent regardless of
    // whether a human or an agent drove the transition.
    const store = new KanbanStore(boardPath, { teamId: opts.team });
    try {
      const updated = store.updateStatus(opts.taskId, opts.status, opts.reason, opts.actor);
      return { task: toWireTask(updated) };
    } finally {
      store.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function toTeamSummary(
  name: string,
  description: string,
  manifest: {
    dispatch_mode?: 'coordinator' | 'self-routing' | 'broadcast';
    coordinator?: string;
    members: unknown[];
  },
  runtime: TeamRuntime | null,
  rootDir: string,
): KanbanTeamSummary {
  // Match the schema's superRefine default resolution: an unset dispatch_mode
  // with a coordinator field means 'coordinator'; otherwise 'self-routing'.
  const dispatchMode =
    manifest.dispatch_mode ?? (manifest.coordinator !== undefined ? 'coordinator' : 'self-routing');
  const runningCount = runtime?.members.filter((m) => m.status === 'running').length ?? 0;
  const health: KanbanTeamSummary['health'] = runtime
    ? runningCount > 0
      ? 'running'
      : 'stale'
    : 'stopped';
  const boardPath = join(rootDir, name, 'board.db');
  const boardModifiedAt = existsSync(boardPath)
    ? new Date(statSync(boardPath).mtimeMs).toISOString()
    : null;
  return {
    name,
    description,
    dispatchMode,
    health,
    memberCount: manifest.members.length,
    runningCount,
    boardModifiedAt,
  };
}

function toWireTask(t: Task): KanbanTask {
  return {
    id: t.id,
    title: t.title,
    body: t.body,
    status: t.status,
    assignee: t.assignee,
    priority: t.priority,
    workspaceMode: t.workspaceMode,
    workspacePath: t.workspacePath,
    scheduledFor: t.scheduledFor !== null ? new Date(t.scheduledFor).toISOString() : null,
    currentRunId: t.currentRunId,
    retryCount: t.retryCount,
    maxRetries: t.maxRetries,
    acceptanceCriteria: t.acceptanceCriteria,
    createdAt: new Date(t.createdAt).toISOString(),
    updatedAt: new Date(t.updatedAt).toISOString(),
  };
}

function toWireMemberStats(s: TeamMemberStats): KanbanMemberStats {
  return {
    teamId: s.teamId,
    memberId: s.memberId,
    ticketsCompleted: s.ticketsCompleted,
    ticketsFailed: s.ticketsFailed,
    ticketsOrphaned: s.ticketsOrphaned,
    lastUpdatedAt: new Date(s.lastUpdatedAt).toISOString(),
  };
}

// Path-traversal guard. Same logic as `ethos team destroy` — refuse anything
// that could resolve outside `teamsDir()`. Without it, a malicious or buggy
// caller could feed `..` into a path and reach beyond the teams directory.
const TEAM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function assertSafeTeamName(name: string): void {
  if (name === '.' || name === '..' || !TEAM_NAME_PATTERN.test(name)) {
    throw new Error(`invalid team name: ${name}`);
  }
}

// Re-exports kept lightweight so callers don't need to depend on kanban-store
// directly when they just want the shape names from the wire types.
export type { KanbanComment, KanbanRun, TaskComment, TaskEvent, TaskRun };
