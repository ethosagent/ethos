import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppState } from '../../state/AppContext';
import { StatusDot } from '../../ui/StatusDot';
import { KanbanBoard } from './KanbanBoard';
import type { KanbanTask } from './KanbanTaskTile';
import { TaskDetailDrawer } from './TaskDetailDrawer';

interface TeamInfo {
  name: string;
  description: string;
  health?: string;
  memberCount?: number;
  runningCount?: number;
  dispatchMode?: string;
}

export function KanbanPage() {
  const { state } = useAppState();
  const { port } = state;

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<string>('');
  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [selectedTask, setSelectedTask] = useState<KanbanTask | null>(null);

  const loadTeams = useCallback(async () => {
    try {
      const res = await client.rpc.kanban.list({});
      setTeams(res.teams ?? []);
      if (res.teams?.length && !selectedTeam) {
        setSelectedTeam(res.teams[0].name);
      }
    } catch {
      // best-effort
    }
  }, [client, selectedTeam]);

  const loadBoard = useCallback(async () => {
    if (!selectedTeam) return;
    try {
      const res = await client.rpc.kanban.getBoard({ team: selectedTeam });
      setTasks(res.board.tasks ?? []);
    } catch {
      // best-effort
    }
  }, [client, selectedTeam]);

  useEffect(() => {
    loadTeams();
  }, [loadTeams]);

  useEffect(() => {
    loadBoard();
    const interval = setInterval(loadBoard, 15_000);
    return () => clearInterval(interval);
  }, [loadBoard]);

  const handleTaskClick = useCallback(
    (id: string) => {
      const task = tasks.find((t) => t.id === id);
      if (task) setSelectedTask(task);
    },
    [tasks],
  );

  const handleCloseDrawer = useCallback(() => {
    setSelectedTask(null);
  }, []);

  const handleStatusChange = useCallback(
    async (
      taskId: string,
      status:
        | 'todo'
        | 'ready'
        | 'running'
        | 'blocked'
        | 'done'
        | 'archived'
        | 'scheduled'
        | 'failed'
        | 'needs_revision',
    ) => {
      try {
        await client.rpc.kanban.updateStatus({ team: selectedTeam, taskId, status });
        await loadBoard();
        setSelectedTask(null);
      } catch {
        // best-effort
      }
    },
    [client, selectedTeam, loadBoard],
  );

  const inProgressCount = useMemo(
    () => tasks.filter((t) => t.status === 'running').length,
    [tasks],
  );

  const doneThisWeekCount = useMemo(() => {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return tasks.filter((t) => {
      if (t.status !== 'done') return false;
      const updated = new Date(t.updatedAt).getTime();
      return Number.isFinite(updated) && updated >= weekAgo;
    }).length;
  }, [tasks]);

  const currentTeam = teams.find((t) => t.name === selectedTeam);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header with team selector and stats */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          flexShrink: 0,
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 20,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          Teams
        </h3>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {teams.length} {teams.length === 1 ? 'team' : 'teams'}
        </span>
        <span style={{ flex: 1 }} />

        {/* Online status for selected team */}
        {currentTeam && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              color: 'var(--text-secondary)',
            }}
          >
            <StatusDot
              color={
                currentTeam.health === 'running'
                  ? 'var(--success, #4ade80)'
                  : 'var(--text-tertiary)'
              }
              size={8}
            />
            {currentTeam.health === 'running' && (currentTeam.runningCount ?? 0) > 0
              ? `${currentTeam.runningCount} online`
              : 'offline'}
          </span>
        )}

        <select
          value={selectedTeam}
          onChange={(e) => setSelectedTeam(e.target.value)}
          style={{
            width: 180,
            height: 28,
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            background: 'var(--bg-base)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            padding: '0 8px',
            outline: 'none',
          }}
        >
          {teams.length === 0 && <option value="">No teams</option>}
          {teams.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      {/* Stats strip */}
      {selectedTeam && (
        <div
          style={{
            display: 'flex',
            gap: 24,
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-subtle)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span
              style={{
                fontSize: 24,
                fontWeight: 700,
                color: 'var(--text-primary)',
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1,
              }}
            >
              {inProgressCount}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>in progress</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span
              style={{
                fontSize: 24,
                fontWeight: 700,
                color: 'var(--text-primary)',
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1,
              }}
            >
              {doneThisWeekCount}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>done this week</span>
          </div>
        </div>
      )}

      <KanbanBoard tasks={tasks} onTaskClick={handleTaskClick} />

      <TaskDetailDrawer
        task={selectedTask}
        open={selectedTask !== null}
        onClose={handleCloseDrawer}
        onStatusChange={handleStatusChange}
      />
    </div>
  );
}
