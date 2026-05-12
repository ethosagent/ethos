import type {
  KanbanBoardSnapshot,
  KanbanEvent,
  KanbanTask,
  KanbanTaskStatus,
} from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Badge, Button, Card, Empty, Select, Spin, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { rpc } from '../rpc';

// Per-team Control Center.
//
// Three panes (Board / Activity / Roster) as described in the Plan B spec.
// First-cut implementation — drag-drop, full DESIGN.md token compliance, and
// the WebSocket live stream are deferred to a follow-up. Status changes go
// through a small Select dropdown on each card; the board polls the server on
// a 2s cadence so multi-process updates surface within that window.
//
// The task tile is the third Card-primitive exemption (see DESIGN.md's
// Decisions log). Skills and Cron were the first two; durable tasks earn the
// same treatment because the tile is the unit of work, not decoration.

const STATUS_COLUMNS: KanbanTaskStatus[] = ['todo', 'ready', 'running', 'blocked', 'done'];
const ARCHIVED_STATUS: KanbanTaskStatus = 'archived';

export function TeamControlCenter() {
  const { name = '' } = useParams<{ name: string }>();
  const navigate = useNavigate();

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['kanban', 'board', name],
    queryFn: () => rpc.kanban.getBoard({ team: name }),
    enabled: name.length > 0,
    refetchInterval: 2_000,
  });

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (error) {
    return (
      <Typography.Text type="danger">
        Failed to load board: {(error as Error).message}
      </Typography.Text>
    );
  }
  if (!data) return null;

  return (
    <div className="team-control-center">
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <Button onClick={() => navigate('/teams')} type="text">
          ← Teams
        </Button>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {data.board.team.name}
        </Typography.Title>
        <Tag bordered={false}>{data.board.team.dispatchMode}</Tag>
        <span style={{ flex: 1 }} />
        <Button onClick={() => void refetch()} loading={isFetching}>
          Refresh
        </Button>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 320px 280px',
          gap: 16,
        }}
      >
        <Board snapshot={data.board} teamName={name} />
        <Activity events={data.board.recentEvents} tasks={data.board.tasks} />
        <Roster snapshot={data.board} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board pane — status columns + goal swimlanes
// ---------------------------------------------------------------------------

function Board({
  snapshot,
  teamName,
}: {
  snapshot: KanbanBoardSnapshot;
  teamName: string;
}): JSX.Element {
  const [showArchived, setShowArchived] = useState(false);

  // Group tasks by status. Tasks under a goal still appear in their own
  // status column — the goal is a swimlane header above its children, not a
  // gate that hides them.
  const byStatus = useMemo(() => {
    const map = new Map<KanbanTaskStatus, KanbanTask[]>();
    for (const status of [...STATUS_COLUMNS, ARCHIVED_STATUS]) {
      map.set(status, []);
    }
    for (const t of snapshot.tasks) {
      if (t.status === 'archived' && !showArchived) continue;
      const bucket = map.get(t.status);
      if (bucket) bucket.push(t);
    }
    return map;
  }, [snapshot.tasks, showArchived]);

  const childCountsByParent = useMemo(() => buildChildCounts(snapshot), [snapshot]);

  return (
    <section className="cc-board">
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          Board
        </Typography.Title>
        <span style={{ flex: 1 }} />
        <Button
          size="small"
          type={showArchived ? 'primary' : 'default'}
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? 'Hide archived' : 'Show archived'}
        </Button>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${showArchived ? STATUS_COLUMNS.length + 1 : STATUS_COLUMNS.length}, minmax(140px, 1fr))`,
          gap: 8,
        }}
      >
        {[...STATUS_COLUMNS, ...(showArchived ? [ARCHIVED_STATUS] : [])].map((status) => (
          <BoardColumn
            key={status}
            status={status}
            tasks={byStatus.get(status) ?? []}
            childCounts={childCountsByParent}
            teamName={teamName}
          />
        ))}
      </div>
    </section>
  );
}

function BoardColumn({
  status,
  tasks,
  childCounts,
  teamName,
}: {
  status: KanbanTaskStatus;
  tasks: KanbanTask[];
  childCounts: Map<string, { total: number; done: number }>;
  teamName: string;
}): JSX.Element {
  return (
    <div className="cc-board-column">
      <header
        style={{
          fontWeight: 600,
          fontSize: 12,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginBottom: 8,
        }}
      >
        {status} <Typography.Text type="secondary">({tasks.length})</Typography.Text>
      </header>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tasks.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={null} />
        ) : (
          tasks.map((t) => (
            <TaskTile key={t.id} task={t} childCount={childCounts.get(t.id)} teamName={teamName} />
          ))
        )}
      </div>
    </div>
  );
}

// Task tile — DESIGN.md Card-primitive exemption #3. The decision is logged
// in DESIGN.md's "Decisions" section in the same change-set as this file.
// The accent stripe / assignee mark / priority pill are the design hooks the
// spec calls out; tokens come through Antd's ConfigProvider so they stay in
// sync with the rest of the surface.
function TaskTile({
  task,
  childCount,
  teamName,
}: {
  task: KanbanTask;
  childCount?: { total: number; done: number };
  teamName: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  const updateMut = useMutation({
    mutationFn: (nextStatus: KanbanTaskStatus) =>
      rpc.kanban.updateStatus({ team: teamName, taskId: task.id, status: nextStatus }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kanban', 'board', teamName] }),
    onError: (err) =>
      notification.error({
        message: 'Status change failed',
        description: (err as Error).message,
      }),
  });

  const isGoal = task.assignee === null;
  const accent = accentFor(task.assignee);

  return (
    <Card
      size="small"
      style={{
        borderLeftWidth: 3,
        borderLeftStyle: 'solid',
        borderLeftColor: accent,
        position: 'relative',
      }}
      bodyStyle={{ padding: 8 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <Typography.Text code style={{ fontSize: 10 }}>
          {task.id.slice(0, 8)}
        </Typography.Text>
        {task.priority !== 0 && (
          <Tag
            bordered={false}
            color={task.priority > 0 ? 'gold' : 'default'}
            style={{ margin: 0 }}
          >
            p{task.priority}
          </Tag>
        )}
        {isGoal && (
          <Tag bordered={false} color="purple" style={{ margin: 0 }}>
            goal
          </Tag>
        )}
        {childCount && childCount.total > 0 && (
          <Tag bordered={false} style={{ margin: 0 }}>
            {childCount.done}/{childCount.total}
          </Tag>
        )}
      </div>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>{task.title}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
        <Typography.Text type="secondary">{task.assignee ?? <em>unassigned</em>}</Typography.Text>
        <span style={{ flex: 1 }} />
        <Select
          size="small"
          value={task.status}
          style={{ width: 90 }}
          onClick={(e) => e.stopPropagation()}
          onChange={(next) => updateMut.mutate(next)}
          disabled={updateMut.isPending}
          options={[...STATUS_COLUMNS, ARCHIVED_STATUS, 'scheduled' as KanbanTaskStatus].map(
            (s) => ({ label: s, value: s }),
          )}
        />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Activity pane — recent task_events
// ---------------------------------------------------------------------------

function Activity({ events, tasks }: { events: KanbanEvent[]; tasks: KanbanTask[] }): JSX.Element {
  const taskTitle = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tasks) m.set(t.id, t.title);
    return m;
  }, [tasks]);

  return (
    <section className="cc-activity" style={{ minWidth: 0 }}>
      <Typography.Title level={5} style={{ margin: '0 0 8px 0' }}>
        Activity
      </Typography.Title>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        {events.length === 0 ? (
          <Typography.Text type="secondary">No activity yet.</Typography.Text>
        ) : (
          [...events].reverse().map((e) => (
            <div
              key={`${e.taskId}:${e.id}`}
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'baseline',
                padding: '2px 0',
                borderBottom: '1px solid var(--ant-color-split, #f0f0f0)',
              }}
            >
              <Typography.Text style={{ color: accentFor(e.actor), fontWeight: 500 }}>
                {e.actor}
              </Typography.Text>
              <Typography.Text type="secondary">{describeEvent(e)}</Typography.Text>
              <Typography.Text code style={{ fontSize: 10 }}>
                {(taskTitle.get(e.taskId) ?? e.taskId.slice(0, 8)).slice(0, 24)}
              </Typography.Text>
              <span style={{ flex: 1 }} />
              <Typography.Text type="secondary" style={{ fontSize: 10 }}>
                {formatRelative(e.createdAt)}
              </Typography.Text>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Roster pane — members + status
// ---------------------------------------------------------------------------

function Roster({ snapshot }: { snapshot: KanbanBoardSnapshot }): JSX.Element {
  // Derive who's currently working from the task list: anyone holding an
  // open run is "working", otherwise idle.
  const workingByAssignee = useMemo(() => {
    const m = new Map<string, KanbanTask>();
    for (const t of snapshot.tasks) {
      if (t.status === 'running' && t.assignee !== null) m.set(t.assignee, t);
    }
    return m;
  }, [snapshot.tasks]);

  // No member list available without a separate teams.get call — fall back
  // to "everyone we've seen as an assignee on a task".
  const seenAssignees = useMemo(() => {
    const s = new Set<string>();
    for (const t of snapshot.tasks) {
      if (t.assignee) s.add(t.assignee);
    }
    return Array.from(s).sort();
  }, [snapshot.tasks]);

  return (
    <section className="cc-roster" style={{ minWidth: 0 }}>
      <Typography.Title level={5} style={{ margin: '0 0 8px 0' }}>
        Roster
      </Typography.Title>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {seenAssignees.length === 0 ? (
          <Typography.Text type="secondary">No assigned tasks yet.</Typography.Text>
        ) : (
          seenAssignees.map((person) => {
            const running = workingByAssignee.get(person);
            return (
              <div
                key={person}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
              >
                <Badge status={running ? 'processing' : 'default'} />
                <Typography.Text style={{ color: accentFor(person), fontWeight: 500 }}>
                  {person}
                </Typography.Text>
                <span style={{ flex: 1 }} />
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {running ? running.title.slice(0, 30) : 'idle'}
                </Typography.Text>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildChildCounts(
  snapshot: KanbanBoardSnapshot,
): Map<string, { total: number; done: number }> {
  const byId = new Map<string, KanbanTask>();
  for (const t of snapshot.tasks) byId.set(t.id, t);
  const counts = new Map<string, { total: number; done: number }>();
  for (const link of snapshot.links) {
    const child = byId.get(link.childId);
    if (!child) continue;
    const cur = counts.get(link.parentId) ?? { total: 0, done: 0 };
    cur.total += 1;
    if (child.status === 'done') cur.done += 1;
    counts.set(link.parentId, cur);
  }
  return counts;
}

// Cheap deterministic mark color from a personality / actor id. Same algorithm
// the existing surface uses for sender accents; full DESIGN.md token roundtrip
// is on the deferred-UI list.
const ACCENTS = ['#1677ff', '#13c2c2', '#722ed1', '#fa8c16', '#52c41a', '#eb2f96', '#fa541c'];
const ACCENT_FALLBACK = '#1677ff';
function accentFor(key: string | null): string {
  if (key === null) return '#8c8c8c';
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return ACCENTS[hash % ACCENTS.length] ?? ACCENT_FALLBACK;
}

function describeEvent(e: KanbanEvent): string {
  switch (e.kind) {
    case 'created':
      return 'created';
    case 'status_changed': {
      const data = e.data as { from?: string; to?: string };
      return `${data.from ?? '?'} → ${data.to ?? '?'}`;
    }
    case 'commented':
      return 'commented on';
    case 'assigned':
      return 'assigned';
    case 'linked':
      return 'linked';
    case 'unlinked':
      return 'unlinked';
    case 'run_started':
      return 'started run on';
    case 'run_completed': {
      const data = e.data as { outcome?: string };
      return `ended run (${data.outcome ?? 'completed'}) on`;
    }
    case 'heartbeat':
      return '♥ on';
    case 'archived':
      return 'archived';
    default:
      return e.kind;
  }
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diff = Date.now() - ts;
  if (diff < 1_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return new Date(iso).toLocaleString();
}
