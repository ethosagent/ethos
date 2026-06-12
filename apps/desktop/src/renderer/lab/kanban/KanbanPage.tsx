import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../../shell/ServerUrl';
import { KanbanBoard } from './KanbanBoard';
import type { KanbanTask } from './KanbanTaskTile';
import { TaskDetailDrawer } from './TaskDetailDrawer';

export function KanbanPage() {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [teams, setTeams] = useState<Array<{ name: string; description: string }>>([]);
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 40,
          padding: '0 16px',
          flexShrink: 0,
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
          Kanban
        </h3>
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
            borderRadius: 4,
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
