import type {
  KanbanBoardSnapshot,
  KanbanEvent,
  KanbanTask,
  KanbanTaskStatus,
} from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Descriptions, Drawer, Dropdown, Spin, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { rpc } from '../rpc';

// Per-team Control Center.
//
// Three panes (Board · Activity · Roster) with strict overflow containment so
// columns never bleed into neighboring sections. Status is rendered as a
// semantic chip — colored by meaning, not by personality — and changed via a
// dropdown menu next to it. Click a task tile → drawer with full detail.
//
// All chrome rides on DESIGN.md surface tokens (`--ethos-*` CSS vars) and the
// 8px base unit. The task tile is the third Card-primitive exemption per the
// Decisions log; everything else is raw layout. Heavy lifting (overflow,
// scroll containment, hover states, status colors) lives in styles.css under
// the `.cc-*` namespace.

const STATUS_COLUMNS: KanbanTaskStatus[] = ['todo', 'ready', 'running', 'blocked', 'done'];
const ARCHIVED_STATUS: KanbanTaskStatus = 'archived';
const ALL_STATUSES: KanbanTaskStatus[] = [...STATUS_COLUMNS, ARCHIVED_STATUS, 'scheduled'];
const STATUS_LABEL: Record<KanbanTaskStatus, string> = {
  todo: 'todo',
  ready: 'ready',
  running: 'running',
  blocked: 'blocked',
  done: 'done',
  archived: 'archived',
  scheduled: 'scheduled',
};

export function TeamControlCenter(): JSX.Element {
  const { name = '' } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['kanban', 'board', name],
    queryFn: () => rpc.kanban.getBoard({ team: name }),
    enabled: name.length > 0,
    refetchInterval: 2_000,
  });

  if (isLoading) {
    return (
      <div className="cc-page">
        <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
          <Spin />
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="cc-page">
        <Typography.Text type="danger">
          Failed to load board: {(error as Error).message}
        </Typography.Text>
      </div>
    );
  }
  if (!data) return <div className="cc-page" />;

  const board = data.board;
  const selectedTask = selectedTaskId ? board.tasks.find((t) => t.id === selectedTaskId) : null;

  return (
    <div className="cc-page">
      <header className="cc-header">
        <Button onClick={() => navigate('/teams')} type="text" size="small">
          ← Teams
        </Button>
        <h2 className="cc-title">{board.team.name}</h2>
        <span className="cc-status-chip cc-status-ready">{board.team.dispatchMode}</span>
        <span className="cc-spacer" />
        <Button
          size="small"
          type={showArchived ? 'primary' : 'default'}
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? 'Hide archived' : 'Show archived'}
        </Button>
        <Button size="small" onClick={() => void refetch()} loading={isFetching}>
          Refresh
        </Button>
      </header>

      <div className="cc-grid">
        <Board
          snapshot={board}
          teamName={name}
          showArchived={showArchived}
          onSelect={setSelectedTaskId}
        />
        <Activity events={board.recentEvents} tasks={board.tasks} onSelect={setSelectedTaskId} />
        <Roster snapshot={board} />
      </div>

      <TaskDrawer
        task={selectedTask ?? null}
        board={board}
        teamName={name}
        onClose={() => setSelectedTaskId(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board pane
// ---------------------------------------------------------------------------

function Board({
  snapshot,
  teamName,
  showArchived,
  onSelect,
}: {
  snapshot: KanbanBoardSnapshot;
  teamName: string;
  showArchived: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  const byStatus = useMemo(() => {
    const map = new Map<KanbanTaskStatus, KanbanTask[]>();
    for (const status of [...STATUS_COLUMNS, ARCHIVED_STATUS]) map.set(status, []);
    for (const t of snapshot.tasks) {
      if (t.status === 'archived' && !showArchived) continue;
      const bucket = map.get(t.status);
      if (bucket) bucket.push(t);
    }
    return map;
  }, [snapshot.tasks, showArchived]);

  const childCounts = useMemo(() => buildChildCounts(snapshot), [snapshot]);

  const columns = showArchived ? [...STATUS_COLUMNS, ARCHIVED_STATUS] : STATUS_COLUMNS;

  return (
    <section className="cc-panel cc-board">
      <header className="cc-panel-header">
        <h3 className="cc-panel-title">Board</h3>
        <span className="cc-spacer" />
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {snapshot.tasks.length} tasks
        </Typography.Text>
      </header>
      <div className="cc-panel-body">
        {columns.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            tasks={byStatus.get(status) ?? []}
            childCounts={childCounts}
            teamName={teamName}
            onSelect={onSelect}
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
  onSelect,
}: {
  status: KanbanTaskStatus;
  tasks: KanbanTask[];
  childCounts: Map<string, { total: number; done: number }>;
  teamName: string;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <div className="cc-column">
      <header className="cc-column-header">
        <span className={`cc-column-name cc-status-chip cc-status-${status}`}>
          {STATUS_LABEL[status]}
        </span>
        <span className="cc-spacer" />
        <span className="cc-column-count">{tasks.length}</span>
      </header>
      <div className="cc-column-body">
        {tasks.length === 0 ? (
          <div className="cc-column-empty">No tasks here yet</div>
        ) : (
          tasks.map((t) => (
            <TaskTile
              key={t.id}
              task={t}
              childCount={childCounts.get(t.id)}
              teamName={teamName}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}

// Task tile — DESIGN.md Card-primitive exemption #3. The accent stripe encodes
// the assignee; the status chip on the bottom encodes work state. Click the
// tile to open the drawer; status changes go through the dropdown on the chip
// so a stray click doesn't reclassify the task.
function TaskTile({
  task,
  childCount,
  teamName,
  onSelect,
}: {
  task: KanbanTask;
  childCount?: { total: number; done: number };
  teamName: string;
  onSelect: (id: string) => void;
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

  // The tile is keyboard-activatable but intentionally NOT a <button> because
  // it contains a nested status-chip button (Dropdown trigger) and HTML
  // forbids button-in-button. role="button" + tabIndex + Enter/Space keydown
  // give the same a11y semantics without the nesting violation.
  return (
    // biome-ignore lint/a11y/useSemanticElements: tile holds a nested Dropdown trigger button; can't be <button>
    <div
      role="button"
      tabIndex={0}
      className="cc-task"
      style={{ borderLeftColor: accent }}
      onClick={() => onSelect(task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(task.id);
        }
      }}
      title={task.title}
    >
      <div className="cc-task-top">
        <span className="cc-task-id">{task.id.slice(0, 8)}</span>
        {task.priority !== 0 && (
          <span className="cc-task-priority" data-p={task.priority}>
            p{task.priority}
          </span>
        )}
        {isGoal && <span className="cc-task-goal-badge">goal</span>}
        <span className="cc-spacer" />
        {childCount && childCount.total > 0 && (
          <span className="cc-task-progress">
            {childCount.done}/{childCount.total}
          </span>
        )}
      </div>
      <div className="cc-task-title">{task.title}</div>
      <div className="cc-task-bottom">
        <span className="cc-task-assignee" style={{ color: accent }}>
          <span className="cc-task-assignee-mark" style={{ background: accent }} />
          {task.assignee ?? <em style={{ fontStyle: 'normal', opacity: 0.6 }}>unassigned</em>}
        </span>
        <span className="cc-spacer" />
        <Dropdown
          trigger={['click']}
          menu={{
            items: ALL_STATUSES.filter((s) => s !== task.status).map((s) => ({
              key: s,
              label: <span className={`cc-status-chip cc-status-${s}`}>{STATUS_LABEL[s]}</span>,
              onClick: ({ domEvent }) => {
                domEvent.stopPropagation();
                updateMut.mutate(s);
              },
            })),
          }}
        >
          <button
            type="button"
            className={`cc-status-chip cc-status-${task.status}`}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
            }}
            style={{ cursor: 'pointer', border: 'none', font: 'inherit' }}
          >
            {STATUS_LABEL[task.status]}
          </button>
        </Dropdown>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity pane
// ---------------------------------------------------------------------------

function Activity({
  events,
  tasks,
  onSelect,
}: {
  events: KanbanEvent[];
  tasks: KanbanTask[];
  onSelect: (id: string) => void;
}): JSX.Element {
  const taskTitle = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tasks) m.set(t.id, t.title);
    return m;
  }, [tasks]);

  // Most recent first.
  const ordered = useMemo(() => [...events].reverse(), [events]);

  return (
    <section className="cc-panel cc-activity">
      <header className="cc-panel-header">
        <h3 className="cc-panel-title">Activity</h3>
      </header>
      <div className="cc-panel-body">
        {ordered.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            No activity yet.
          </Typography.Text>
        ) : (
          <div className="cc-activity-list">
            {ordered.map((e) => {
              const accent = accentFor(e.actor);
              const title = taskTitle.get(e.taskId) ?? e.taskId.slice(0, 8);
              return (
                <button
                  type="button"
                  key={`${e.taskId}:${e.id}`}
                  className="cc-activity-row"
                  onClick={() => onSelect(e.taskId)}
                >
                  <span className="cc-activity-actor" style={{ color: accent }}>
                    {e.actor}
                  </span>
                  <span className="cc-activity-text" title={`${describeEvent(e)} ${title}`}>
                    {describeEvent(e)} {title}
                  </span>
                  <span className="cc-activity-time">{formatRelative(e.createdAt)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Roster pane
// ---------------------------------------------------------------------------

function Roster({ snapshot }: { snapshot: KanbanBoardSnapshot }): JSX.Element {
  const workingByAssignee = useMemo(() => {
    const m = new Map<string, KanbanTask>();
    for (const t of snapshot.tasks) {
      if (t.status === 'running' && t.assignee !== null) m.set(t.assignee, t);
    }
    return m;
  }, [snapshot.tasks]);

  const seenAssignees = useMemo(() => {
    const s = new Set<string>();
    for (const t of snapshot.tasks) {
      if (t.assignee) s.add(t.assignee);
    }
    return Array.from(s).sort();
  }, [snapshot.tasks]);

  return (
    <section className="cc-panel cc-roster">
      <header className="cc-panel-header">
        <h3 className="cc-panel-title">Roster</h3>
      </header>
      <div className="cc-panel-body">
        {seenAssignees.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            No assigned tasks yet.
          </Typography.Text>
        ) : (
          <div className="cc-roster-list">
            {seenAssignees.map((person) => {
              const accent = accentFor(person);
              const running = workingByAssignee.get(person);
              return (
                <div key={person} className="cc-roster-row">
                  <span className="cc-roster-mark" style={{ background: accent }} />
                  <span className="cc-roster-name" style={{ color: accent }}>
                    {person}
                  </span>
                  <span className="cc-spacer" />
                  <span
                    className={`cc-roster-status-dot ${running ? 'cc-roster-status-running' : ''}`}
                    title={running ? `working on ${running.title}` : 'idle'}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Task drawer — full detail + recent events for one task
// ---------------------------------------------------------------------------

function TaskDrawer({
  task,
  board,
  teamName,
  onClose,
}: {
  task: KanbanTask | null;
  board: KanbanBoardSnapshot;
  teamName: string;
  onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  const updateMut = useMutation({
    mutationFn: (nextStatus: KanbanTaskStatus) =>
      rpc.kanban.updateStatus({
        team: teamName,
        taskId: task?.id ?? '',
        status: nextStatus,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kanban', 'board', teamName] }),
    onError: (err) =>
      notification.error({
        message: 'Status change failed',
        description: (err as Error).message,
      }),
  });

  const events = useMemo(() => {
    if (!task) return [];
    return board.recentEvents.filter((e) => e.taskId === task.id).reverse();
  }, [task, board.recentEvents]);

  const parents = useMemo(() => {
    if (!task) return [];
    return board.links
      .filter((l) => l.childId === task.id)
      .map((l) => board.tasks.find((t) => t.id === l.parentId))
      .filter((t): t is KanbanTask => t !== undefined);
  }, [task, board]);

  const children = useMemo(() => {
    if (!task) return [];
    return board.links
      .filter((l) => l.parentId === task.id)
      .map((l) => board.tasks.find((t) => t.id === l.childId))
      .filter((t): t is KanbanTask => t !== undefined);
  }, [task, board]);

  return (
    <Drawer
      open={task !== null}
      onClose={onClose}
      width={520}
      title={task ? `${task.id} · ${task.title}` : ''}
      destroyOnClose
    >
      {task && (
        <>
          <div style={{ marginBottom: 16 }}>
            <Dropdown
              trigger={['click']}
              menu={{
                items: ALL_STATUSES.filter((s) => s !== task.status).map((s) => ({
                  key: s,
                  label: <span className={`cc-status-chip cc-status-${s}`}>{STATUS_LABEL[s]}</span>,
                  onClick: () => updateMut.mutate(s),
                })),
              }}
            >
              <Button size="small">
                <span className={`cc-status-chip cc-status-${task.status}`}>
                  {STATUS_LABEL[task.status]}
                </span>
                <span style={{ marginLeft: 6 }}>▾</span>
              </Button>
            </Dropdown>
          </div>

          {task.body && (
            <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
              {task.body}
            </Typography.Paragraph>
          )}

          <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
            <Descriptions.Item label="Assignee">
              {task.assignee ?? <em style={{ opacity: 0.6 }}>unassigned (goal)</em>}
            </Descriptions.Item>
            <Descriptions.Item label="Priority">{task.priority}</Descriptions.Item>
            <Descriptions.Item label="Workspace">{task.workspaceMode}</Descriptions.Item>
            <Descriptions.Item label="Created">
              {new Date(task.createdAt).toLocaleString()}
            </Descriptions.Item>
            <Descriptions.Item label="Updated">
              {new Date(task.updatedAt).toLocaleString()}
            </Descriptions.Item>
          </Descriptions>

          {parents.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <Typography.Text strong style={{ fontSize: 12 }}>
                Parents
              </Typography.Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {parents.map((p) => (
                  <span key={p.id} className={`cc-status-chip cc-status-${p.status}`}>
                    {p.title.slice(0, 30)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {children.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <Typography.Text strong style={{ fontSize: 12 }}>
                Children
              </Typography.Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {children.map((c) => (
                  <span key={c.id} className={`cc-status-chip cc-status-${c.status}`}>
                    {c.title.slice(0, 30)}
                  </span>
                ))}
              </div>
            </div>
          )}

          <Typography.Text strong style={{ fontSize: 12 }}>
            Recent events
          </Typography.Text>
          <div className="cc-activity-list" style={{ marginTop: 6 }}>
            {events.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                No events for this task in the recent window.
              </Typography.Text>
            ) : (
              events.map((e) => (
                <div key={e.id} className="cc-activity-row">
                  <span className="cc-activity-actor" style={{ color: accentFor(e.actor) }}>
                    {e.actor}
                  </span>
                  <span className="cc-activity-text">{describeEvent(e).replace(/ on$/, '')}</span>
                  <span className="cc-activity-time">{formatRelative(e.createdAt)}</span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </Drawer>
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

// Per-personality accent — matches DESIGN.md's recommended hexes for the
// known built-in personalities and falls back to a deterministic hash for
// anything custom. Used for the assignee mark, name color, and tile stripe.
const KNOWN_ACCENTS: Record<string, string> = {
  researcher: '#4A9EFF',
  engineer: '#4ADE80',
  reviewer: '#F59E0B',
  coach: '#E879F9',
  operator: '#94A3B8',
  coordinator: '#67E8F9',
  dispatcher: '#94A3B8',
};
const FALLBACK_ACCENTS = ['#1677ff', '#13c2c2', '#722ed1', '#fa8c16', '#52c41a', '#eb2f96'];
const ACCENT_FALLBACK = '#9A9A98';

function accentFor(key: string | null): string {
  if (key === null) return ACCENT_FALLBACK;
  const stripped = key.replace(/^human:/, '');
  if (KNOWN_ACCENTS[stripped]) return KNOWN_ACCENTS[stripped];
  let hash = 0;
  for (let i = 0; i < stripped.length; i++) hash = (hash * 31 + stripped.charCodeAt(i)) >>> 0;
  return FALLBACK_ACCENTS[hash % FALLBACK_ACCENTS.length] ?? ACCENT_FALLBACK;
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
